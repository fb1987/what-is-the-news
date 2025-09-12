import express from "express";
import compression from "compression";
import { XMLParser } from "fast-xml-parser";

const app = express();
app.use(compression());
app.use(express.static("public"));

/**
 * -------- Free news source (no key) ----------
 * Google News RSS (Canada/English). You can add or remove feeds.
 * “Top stories” + topic sections. Keep it small and fast.
 */
const FEEDS = [
  "https://news.google.com/rss?hl=en-CA&gl=CA&ceid=CA:en",
  "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-CA&gl=CA&ceid=CA:en",
  "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-CA&gl=CA&ceid=CA:en",
  "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-CA&gl=CA&ceid=CA:en",
  "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-CA&gl=CA&ceid=CA:en"
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

let cache = { ts: 0, items: [] };
const TTL_MS = 10 * 60 * 1000; // 10 min

function normalizeTitle(t) {
  return (t || "")
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-")
    .trim();
}
function sourceFromItem(it) {
  // Google News puts source in <source> or inside title/link domain; keep simple:
  if (it.source && typeof it.source === "string") return it.source.trim();
  if (it["source"] && it["source"]["#text"]) return String(it["source"]["#text"]).trim();
  try {
    const u = new URL(it.link);
    return u.hostname.replace(/^www\./, "");
  } catch (_) {
    return "news";
  }
}

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
    ts: it.pubDate ? Date.parse(it.pubDate) : Date.now()
  }));
}

async function getNews() {
  const now = Date.now();
  if (now - cache.ts < TTL_MS && cache.items.length) return cache.items;

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const merged = [];
  for (const r of results) if (r.status === "fulfilled") merged.push(...r.value);

  // Deduplicate by normalized title (case-insensitive) and by URL
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
  // Cap and compact payload
  const compact = out.slice(0, 140).map((it) => ({
    t: it.title.slice(0, 140), // keep short for dense columns
    s: it.source,
    u: it.link,
    d: it.ts
  }));

  cache = { ts: now, items: compact };
  return compact;
}

app.get("/api/news", async (req, res) => {
  try {
    const items = await getNews();
    res.json({ items, ts: cache.ts });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("matrix-news listening on :" + PORT);
});
