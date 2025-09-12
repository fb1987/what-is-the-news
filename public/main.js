// WebGL2 DIGITAL RAIN with live headlines injection
const DPR = Math.min(devicePixelRatio || 1, 2);
const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl2", {
  alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance"
});
if (!gl) {
  alert("WebGL2 not available");
  throw new Error("WebGL2 required");
}

// ---------- Visual constants (tune density here) ----------
const CELL_W = 14;      // css px per glyph (width)
const CELL_H = 18;      // css px per glyph (height)
const TRAIL = 24;       // rows for glow trail
const SPEED_MIN = 0.55; // rows per frame (scaled by time)
const SPEED_MAX = 1.6;

// Headline injection cadence (ms)
const INJECT_EVERY = 1100;
const CHURN_RATE = 0.012; // random glyph churn per frame

// --------- Glyph set: ASCII + half-width katakana + symbols ----------
const GLYPHS = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."<>[]{}()+-=/*_|\\!?:;.,'\"",
  ..."ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ",
  ..."•◇◆"
];
const GLYPH_MAP = new Map(GLYPHS.map((ch, i) => [ch, i]));
const ATLAS_TILE = 64; // px per glyph in the atlas (high for crisp downscale)

// ---------- Resize & grid ----------
let width = 0, height = 0, cols = 0, rows = 0;
function resize() {
  const cssW = canvas.clientWidth = innerWidth;
  const cssH = canvas.clientHeight = innerHeight;
  width = Math.floor(cssW * DPR);
  height = Math.floor(cssH * DPR);
  canvas.width = width;
  canvas.height = height;

  cols = Math.max(8, Math.floor(cssW / CELL_W));
  rows = Math.max(16, Math.floor(cssH / CELL_H) + 6);

  // Rebuild textures and buffers when size changes
  initOrResizeGL();
}
addEventListener("resize", resize);

// ---------- Build glyph atlas on the fly (Canvas -> Texture) ----------
async function buildAtlasTexture() {
  // Ensure font is ready so atlas uses it
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch {}
  }
  const atlasCols = Math.ceil(Math.sqrt(GLYPHS.length));
  const atlasRows = Math.ceil(GLYPHS.length / atlasCols);
  const cw = ATLAS_TILE, ch = ATLAS_TILE;

  const cvs = new OffscreenCanvas(atlasCols * cw, atlasRows * ch);
  const ctx = cvs.getContext("2d", { willReadFrequently: false });
  // Draw white glyphs on transparent background -> sample red for alpha in shader
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillRect(0, 0, cvs.width, cvs.height);

  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  // Slightly condensed, square-ish mono; fallbacks included
  ctx.font = `48px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace`;

  for (let i = 0; i < GLYPHS.length; i++) {
    const gx = (i % atlasCols) * cw;
    const gy = Math.floor(i / atlasCols) * ch;
    const chStr = GLYPHS[i];
    const m = ctx.measureText(chStr);
    // Centering each glyph in its tile
    const x = gx + ((cw - m.width) / 2);
    const y = gy + ((ch - 48) / 2) - 2; // tweak baseline
    ctx.fillText(chStr, x, y);
  }

  const bitmap = await createImageBitmap(cvs);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // crisp downsizing
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { tex, atlasCols, atlasRows };
}

// ---------- GL program ----------
const VS = `#version 300 es
precision highp float;

layout (location=0) in vec2 aUnit;   // quad unit coords [0..1]
layout (location=1) in vec2 aCell;   // col, row (float for simplicity)

uniform vec2 uCanvas;     // px
uniform vec2 uCell;       // px
uniform vec2 uGrid;       // cols, rows

out vec2 vQuadUV;
out vec2 vCell;

void main() {
  vQuadUV = aUnit;        // pass to frag to index atlas
  vCell = aCell;          // pass cell indices to frag

  vec2 posPx = aUnit * uCell + vec2(aCell.x * uCell.x, aCell.y * uCell.y);
  vec2 posNDC = (posPx / uCanvas) * 2.0 - 1.0;
  gl_Position = vec4(posNDC.x, -posNDC.y, 0.0, 1.0);
}
`;

const FS = `#version 300 es
precision highp float;

in vec2 vQuadUV;
in vec2 vCell;
out vec4 outColor;

uniform sampler2D uAtlas;
uniform sampler2D uGlyphTex; // cols x rows, R8 index -> glyph id [0..N)
uniform sampler2D uHeadTex;  // cols x 1, R32F: head row position
uniform vec2 uAtlasGrid;     // atlasCols, atlasRows
uniform vec2 uGrid;          // cols, rows
uniform vec3 uColorBody;     // green
uniform vec3 uColorHead;     // light green
uniform float uTrail;        // rows
uniform float uTime;

// Pseudo-random hash (no texture lookups)
float hash13(vec3 p) {
  p  = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  // Look up glyph index for this cell
  vec2 glyphUV = (vCell + 0.5) / uGrid;
  float glyphIdx01 = texture(uGlyphTex, glyphUV).r; // [0..1]
  float glyphIndex = floor(glyphIdx01 * 255.0 + 0.5);

  // Compute atlas tile UV
  float atlasCols = uAtlasGrid.x;
  float ix = mod(glyphIndex, atlasCols);
  float iy = floor(glyphIndex / atlasCols);
  vec2 tileUV = (vec2(ix, iy) + vQuadUV) / uAtlasGrid;

  // Sample atlas: use red as luminance (white glyphs on transparent)
  float a = texture(uAtlas, tileUV).r;

  // Column head position (float row); texture is cols x 1
  float col = vCell.x;
  float row = vCell.y;
  float headRow = texelFetch(uHeadTex, ivec2(int(col), 0), 0).r;

  // Distance (wrap-around): head paints brightness behind it
  float dr = mod((headRow - row + uGrid.y), uGrid.y);
  float trailT = clamp(1.0 - (dr / uTrail), 0.0, 1.0);

  // Head brightness (within ~1 row)
  float isHead = step(dr, 0.8);

  // Subtle noise flicker to avoid static blocks
  float flicker = 0.75 + 0.25 * hash13(vec3(col, row, floor(uTime * 60.0)));

  vec3 color = mix(uColorBody, uColorHead, isHead);
  float intensity = max(0.25, trailT) * flicker;

  // Smooth alpha cutoff so tiny dots don't vanish
  float glyph = smoothstep(0.35, 0.55, a);

  outColor = vec4(color * intensity, glyph);
}
`;

// ---------- Program helpers ----------
function makeProgram(vsSrc, fsSrc) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSrc); gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(vs));

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(fs));

  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

// ---------- Buffers & textures (rebuilt on resize) ----------
let program, u = {};
let vao, quadBuf, cellBuf;
let glyphTex, headTex, atlasTex;
let atlasCols = 0, atlasRows = 0;
let gridIdx;               // Uint8Array [cols*rows] of glyph indices
let heads, headVel;        // Float32Array [cols] head rows & speeds
let paused = false;

function createTexture(width, height, internalFormat, format, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function uploadGlyphTexture() {
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED, gl.UNSIGNED_BYTE, gridIdx);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function uploadHeadTexture() {
  gl.bindTexture(gl.TEXTURE_2D, headTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, 1, gl.RED, gl.FLOAT, heads);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

async function initOrResizeGL() {
  // Build / rebuild atlas once (keep between resizes)
  if (!atlasTex) {
    const atlas = await buildAtlasTexture();
    atlasTex = atlas.tex;
    atlasCols = atlas.atlasCols;
    atlasRows = atlas.atlasRows;
  }

  // Build glyph index texture & heads
  gridIdx = new Uint8Array(cols * rows);
  // Fill with random glyphs
  for (let i = 0; i < gridIdx.length; i++) {
    gridIdx[i] = Math.floor(Math.random() * GLYPHS.length);
  }

  // Head state
  heads = new Float32Array(cols);
  headVel = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    heads[c] = Math.floor(Math.random() * rows);
    headVel[c] = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
  }

  // Textures
  if (glyphTex) gl.deleteTexture(glyphTex);
  if (headTex) gl.deleteTexture(headTex);

  glyphTex = createTexture(cols, rows, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
  headTex  = createTexture(cols, 1, gl.R32F, gl.RED, gl.FLOAT);

  uploadGlyphTexture();
  uploadHeadTexture();

  // Program (once)
  if (!program) {
    program = makeProgram(VS, FS);
    gl.useProgram(program);
    u = {
      uCanvas: gl.getUniformLocation(program, "uCanvas"),
      uCell: gl.getUniformLocation(program, "uCell"),
      uGrid: gl.getUniformLocation(program, "uGrid"),
      uAtlas: gl.getUniformLocation(program, "uAtlas"),
      uGlyphTex: gl.getUniformLocation(program, "uGlyphTex"),
      uHeadTex: gl.getUniformLocation(program, "uHeadTex"),
      uAtlasGrid: gl.getUniformLocation(program, "uAtlasGrid"),
      uColorBody: gl.getUniformLocation(program, "uColorBody"),
      uColorHead: gl.getUniformLocation(program, "uColorHead"),
      uTrail: gl.getUniformLocation(program, "uTrail"),
      uTime: gl.getUniformLocation(program, "uTime")
    };
  }

  // Geometry: a single quad, instanced across cells
  const quad = new Float32Array([
    0,0,  1,0,  0,1,
    0,1,  1,0,  1,1
  ]);
  if (quadBuf) gl.deleteBuffer(quadBuf);
  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  // Instance buffer: (col,row) for each cell
  const cells = new Float32Array(cols * rows * 2);
  let p = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells[p++] = c;
      cells[p++] = r;
    }
  }
  if (cellBuf) gl.deleteBuffer(cellBuf);
  cellBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cellBuf);
  gl.bufferData(gl.ARRAY_BUFFER, cells, gl.STATIC_DRAW);

  // VAO
  if (vao) gl.deleteVertexArray(vao);
  vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // aUnit (location 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // aCell (location 1) instanced
  gl.bindBuffer(gl.ARRAY_BUFFER, cellBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1); // advance per instance

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  gl.viewport(0, 0, width, height);
}

// ---------- News fetching & headline injection ----------
let headlines = [];
async function getNews() {
  try {
    const res = await fetch("/api/news");
    const j = await res.json();
    headlines = (j.items || []).map(x => ({
      t: String(x.t || "").toUpperCase(),
      s: x.s || "",
      u: x.u || ""
    }));
  } catch (e) {
    // stay quiet; render proceeds with random glyphs
  }
}

// Map a character to glyph index or a random fallback
function charIndex(ch) {
  if (GLYPH_MAP.has(ch)) return GLYPH_MAP.get(ch);
  // Space becomes random noise to keep the "Matrix" look
  return Math.floor(Math.random() * GLYPHS.length);
}

function injectHeadline() {
  if (!headlines.length) return;
  const pick = headlines[Math.floor(Math.random() * Math.min(40, headlines.length))].t;
  const col = Math.floor(Math.random() * cols);
  // Start halfway above the head so it "emerges" into view
  const start = (Math.floor(heads[col]) - Math.floor(Math.random() * (rows / 2)) + rows) % rows;

  // Write characters vertically downward
  for (let i = 0; i < pick.length && i < rows; i++) {
    const row = (start + i) % rows;
    const ch = pick[i];
    gridIdx[row * cols + col] = charIndex(ch);
  }
  uploadGlyphTexture();
}

// ---------- Animation loop ----------
let lastTime = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(program);
  gl.bindVertexArray(vao);

  // Update head positions & churn glyphs
  if (!paused) {
    for (let c = 0; c < cols; c++) {
      heads[c] = (heads[c] + headVel[c] * (dt * 60.0)) % rows;
      // Random churn in the column to avoid static patterns
      if (Math.random() < CHURN_RATE) {
        const r = Math.floor(Math.random() * rows);
        gridIdx[r * cols + c] = Math.floor(Math.random() * GLYPHS.length);
      }
    }
    uploadHeadTexture();
    // Minor churn batch update amortized by column loop above
    uploadGlyphTexture();
  }

  // Uniforms
  gl.uniform2f(u.uCanvas, width, height);
  gl.uniform2f(u.uCell, CELL_W * DPR, CELL_H * DPR);
  gl.uniform2f(u.uGrid, cols, rows);
  gl.uniform2f(u.uAtlasGrid, atlasCols, atlasRows);
  gl.uniform3f(u.uColorBody, 0.0, 1.0, 0.255); // #00ff41
  gl.uniform3f(u.uColorHead, 0.73, 1.0, 0.79); // #baffc9
  gl.uniform1f(u.uTrail, TRAIL);
  gl.uniform1f(u.uTime, now * 0.001);

  // Bind textures
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.uniform1i(u.uAtlas, 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.uniform1i(u.uGlyphTex, 1);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, headTex);
  gl.uniform1i(u.uHeadTex, 2);

  // Draw
  const instanceCount = cols * rows;
  gl.bindVertexArray(vao);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
  gl.bindVertexArray(null);

  requestAnimationFrame(frame);
}

// ---------- Input ----------
addEventListener("keydown", (e) => {
  if (e.code === "Space") { paused = !paused; }
});

// ---------- Start ----------
await getNews();
resize();

// Periodic news refresh + headline injections
setInterval(() => { getNews(); }, 10 * 60 * 1000);
setInterval(() => { if (!paused) injectHeadline(); }, INJECT_EVERY);

requestAnimationFrame(frame);
