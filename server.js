import express from "express";
import compression from "compression";
import { XMLParser } from "fast-xml-parser";

// --- NEW: OpenAI (optional) ---
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // cheap & fast

const app = express();
app.use(compression());
app.use(express.static("public"));
app.use(express.json({ limit: "32kb" })); // NEW: for POST bodies

// ---------- Google News helpers ----------
const HL = "en-CA", GL = "CA", CEID = "CA:en";
const NEWS_BASE = `https://news.google.com/rss`;

const TOPIC_CODES = {
  TOP: "Top stories",
  WORLD: "World",
  NATION: "Nation",
  BUSINESS: "Business",
  TECHNOLOGY: "Technology",
  ENTERTAINMENT: "Entertainment",
  SCIENCE: "Science",
  SPORTS: "Sports",
  HEALTH: "Health",
};
const TOPIC_LIST = Object.keys(TOPIC_CODES).filter(k => k !== "TOP");

const topicFeed = (code) =>
  `${NEWS_BASE}/headlines/section/topic/${encodeURIComponent(code)}?hl=${HL}&gl=${GL}&ceid=${CEID}`;

const topFeed = () => `${NEWS_BASE}?hl=${HL}&gl=${GL}&ceid=${CEID}`;
const searchFeed = (q) =>
  `${NEWS_BASE}/search?q=${encodeURIComponent(q)}&hl=${HL}&gl=${GL}&ceid=${CEID}`;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

// ---------- Cache (per distinct feed-set) ----------
const TTL_MS = 10 * 60 * 1000;
const newsCache = new Map(); // key -> { ts, items }

// ---------- Normalizers ----------
function normalizeTitle(t) {
  return (t || "")
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-")
    .trim();
}
function sourceFromItem(it) {
  if (it.source && typeof it.source === "string") return it.source.trim();
  if (it["source"] && it["source"]["#text"]) return String(it["source"]["#text"]).trim();
  try {
    const u = new URL(it.link);
    return u.hostname.replace(/^www\./, "");
  } catch (_) {
    return "news";
  }
}

// ---------- Fetch & Merge ----------
async function fetchFeed(url) {
  const res = await fetch(url, { headers: { "User-Agent": "matrix-news/1.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  const xml = await res.text();
  const j = parser.parse(xml);
  const items = j?.rss?.channel?.item || [];
  return items.map((it) => ({
    title: normalizeTitle(it.title),
    link: it.link,
    source: sourceFromItem(it),
    ts: it.pubDate ? Date.parse(it.pubDate) : Date.now(),
  }));
}

function dedupeAndTrim(merged, cap = 140) {
  const seen = new Set();
  const out = [];
  for (const it of merged) {
    const key = (it.title || "").toLowerCase();
    const key2 = (it.link || "").toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      if (key2) seen.add(key2);
      out.push(it);
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, cap).map((it) => ({
    t: it.title.slice(0, 140),
    s: it.source,
    u: it.link,
    d: it.ts,
  }));
}

async function fetchNewsForFeeds(feeds) {
  const key = JSON.stringify([...feeds].sort());
  const now = Date.now();
  const cached = newsCache.get(key);
  if (cached && now - cached.ts < TTL_MS && cached.items.length) return cached.items;

  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const merged = [];
  for (const r of results) if (r.status === "fulfilled") merged.push(...r.value);
  const compact = dedupeAndTrim(merged);
  newsCache.set(key, { ts: now, items: compact });
  return compact;
}

// ---------- Default feeds (unchanged behavior) ----------
const DEFAULT_FEEDS = [
  topFeed(),
  topicFeed("WORLD"),
  topicFeed("BUSINESS"),
  topicFeed("TECHNOLOGY"),
  topicFeed("SCIENCE"),
];

// ---------- LLM planner (topics + searches) ----------
function naivePlan(q) {
  // Fallback if no API key or LLM fails: extract 3–6 keywords as searches
  const words = String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s:'".-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const uniq = [...new Set(words)].slice(0, 6);
  const searches = uniq.length ? [uniq.join(" ")] : [];
  return { topics: [], sites: [], searches };
}

async function planWithLLM(q) {
  if (!OPENAI_KEY) return naivePlan(q);

  const sys = `
You map a short English preference into Google News "topics" and searches.
Topics (max 6) must be chosen from: ${TOPIC_LIST.join(", ")}.
Return strict JSON: {"topics":[...],"searches":[...],"sites":[...]}
- "topics": array of uppercase topic codes from the list.
- "searches": up to 6 Google News search strings (use quotes, AND/OR, minus, etc).
- "sites": up to 6 preferred domains like "theverge.com" (optional).
Limit total feeds to ~10 when combined with topics. Prefer specificity.`;

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: q.slice(0, 600) },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" }, // ask for strict JSON
  };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const txt = j?.choices?.[0]?.message?.content || "{}";
    const out = JSON.parse(txt);
    return {
      topics: Array.isArray(out.topics) ? out.topics.filter(t => TOPIC_LIST.includes(String(t))) : [],
      searches: Array.isArray(out.searches) ? out.searches.map(String).slice(0, 6) : [],
      sites: Array.isArray(out.sites) ? out.sites.map(String).slice(0, 6) : [],
    };
  } catch (_) {
    return naivePlan(q);
  }
}

// Build final feed URL list from plan
function feedsFromPlan(plan) {
  const feeds = new Set();
  feeds.add(topFeed()); // keep top stories for breadth

  for (const t of plan.topics || []) feeds.add(topicFeed(t));

  // site filters become searches like: (your query) site:domain
  for (const s of plan.searches || []) feeds.add(searchFeed(s));
  for (const d of plan.sites || []) feeds.add(searchFeed(`site:${d}`));

  // Cap to ~10 feeds total
  return [...feeds].slice(0, 10);
}

// ---------- Routes ----------
// NEW: tune – POST { q: string } -> { feeds, plan }
app.post("/api/tune", async (req, res) => {
  const q = String(req.body?.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing q" });

  const plan = await planWithLLM(q);
  const feeds = feedsFromPlan(plan);
  res.json({ feeds, plan });
});

// UPDATED: news – supports GET (default) and POST {feeds}
app.get("/api/news", async (_req, res) => {
  try {
    const items = await fetchNewsForFeeds(DEFAULT_FEEDS);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/news", async (req, res) => {
  try {
    const feeds = Array.isArray(req.body?.feeds) && req.body.feeds.length
      ? req.body.feeds.map(String)
      : DEFAULT_FEEDS;
    const items = await fetchNewsForFeeds(feeds);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("matrix-news listening on :" + PORT));
