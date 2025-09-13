// --- main.js (safe against async init/resizes) ---
const DPR = Math.min(devicePixelRatio || 1, 2);
const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl2", {
  alpha: false, antialias: false, depth: false, stencil: false,
  powerPreference: "high-performance"
});
if (!gl) { alert("WebGL2 not available"); throw new Error("WebGL2 required"); }
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // safe row uploads for R8/R32F

// ---------- Visual constants ----------
const CELL_W = 24, CELL_H = 24, TRAIL = 30;
const SPEED_MIN = 0.35, SPEED_MAX = 1.4;
const INJECT_EVERY = 1300;
const CHURN_RATE = 0.004; // calmer churn

// --- Legibility / scrambling controls ---
let SCRAMBLE_PCT = 0.50;   // 0.00 = no scramble (readable), 1.00 = totally scrambled
const KEEP_SPACES = true;
const PROTECT_MS  = 6000;
window.setScramble = (p) => { SCRAMBLE_PCT = Math.max(0, Math.min(1, p)); };

// ---------- Glyphs (includes real space) ----------
const GLYPHS = [
  ..." ", // real space
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."<>[]{}()+-=/*_|\\!?:;.,'\"",
  ..."ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ",
  ..."•◇◆"
];
const GLYPH_MAP = new Map(GLYPHS.map((ch, i) => [ch, i]));
function charIndex(ch){ return GLYPH_MAP.has(ch) ? GLYPH_MAP.get(ch) : Math.floor(Math.random()*GLYPHS.length); }
const ATLAS_TILE = 64;

// ---------- Size & grid ----------
let width=0, height=0, cols=0, rows=0;
function resize(){
  canvas.style.width  = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  const rect = canvas.getBoundingClientRect();
  width  = Math.floor(rect.width  * DPR);
  height = Math.floor(rect.height * DPR);
  canvas.width  = width;
  canvas.height = height;
  cols = Math.max(8,  Math.floor(rect.width  / CELL_W));
  rows = Math.max(16, Math.floor(rect.height / CELL_H) + 6);
  queueRebuild();
}
addEventListener("resize", resize);

// ---------- Atlas ----------
async function buildAtlasTexture(){
  if (document.fonts?.ready) { try { await document.fonts.ready; } catch {} }
  const atlasCols = Math.ceil(Math.sqrt(GLYPHS.length));
  const atlasRows = Math.ceil(GLYPHS.length / atlasCols);
  const cw = ATLAS_TILE, ch = ATLAS_TILE;

  const cvs = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(atlasCols*cw, atlasRows*ch)
    : Object.assign(document.createElement("canvas"), { width: atlasCols*cw, height: atlasRows*ch });

  const ctx = cvs.getContext("2d");
  ctx.clearRect(0,0,cvs.width,cvs.height);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  ctx.font = `48px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace`;
  for (let i=0;i<GLYPHS.length;i++){
    const gx = (i % atlasCols) * cw, gy = Math.floor(i/atlasCols) * ch;
    const s = GLYPHS[i], m = ctx.measureText(s);
    const x = gx + (cw - m.width)/2, y = gy + (ch - 48)/2 - 2;
    ctx.fillText(s, x, y);
  }
  const bmp = await (cvs.convertToBlob ? createImageBitmap(await cvs.convertToBlob()) : createImageBitmap(cvs));

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { tex, atlasCols, atlasRows };
}

// ---------- Shaders ----------
const VS = `#version 300 es
precision highp float;
layout (location=0) in vec2 aUnit;
layout (location=1) in vec2 aCell;
uniform vec2 uCanvas, uCell, uGrid;
out vec2 vQuadUV, vCell;
void main(){
  vQuadUV=aUnit; vCell=aCell;
  vec2 px = aUnit*uCell + vec2(aCell.x*uCell.x, aCell.y*uCell.y);
  vec2 ndc = (px/uCanvas)*2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;

in vec2 vQuadUV;
in vec2 vCell;
out vec4 outColor;

uniform sampler2D uAtlas;
uniform sampler2D uGlyphTex; // R8 index texture
uniform sampler2D uHeadTex;  // cols x 1, R32F
uniform vec2 uAtlasGrid;     // cols, rows of atlas
uniform vec2 uGrid;          // cols, rows of screen grid
uniform vec3 uColorBody;
uniform vec3 uColorHead;
uniform float uTrail;
uniform float uTime;

float h(vec3 p){ p=fract(p*.1031); p+=dot(p,p.yzx+33.33); return fract((p.x+p.y)*p.z); }

void main(){
  // exact glyph index per cell
  ivec2 cell = ivec2(int(vCell.x), int(vCell.y));
  float gi01 = texelFetch(uGlyphTex, cell, 0).r;     // [0..1] UNORM
  float gi    = floor(gi01 * 255.0 + 0.5);           // [0..255]

  float ac = uAtlasGrid.x;
  float ix = mod(gi, ac);
  float iy = floor(gi / ac);
  vec2 tUV = (vec2(ix, iy) + vQuadUV) / uAtlasGrid;

  // white glyphs → use red as luminance
  float glyphMask = texture(uAtlas, tUV).r;

  // Column head
  float headRow = texelFetch(uHeadTex, ivec2(int(vCell.x), 0), 0).r;
  float dr = mod((headRow - vCell.y + uGrid.y), uGrid.y);

  // Trail shape & head flag
  float trailT  = clamp(1.0 - (dr / uTrail), 0.0, 1.0);
  float isHead  = step(dr, 0.8);

  // Only visible when trail is over a cell (or on the head).
  float alpha = smoothstep(0.35, 0.55, glyphMask) * max(trailT, isHead);

  // Color & intensity (slight flicker)
  float flick = 0.85 + 0.25 * h(vec3(vCell.x, vCell.y, floor(uTime*60.0)));
  vec3 color  = mix(uColorBody, uColorHead, isHead);
  float intens = (0.15 + 0.85 * trailT) * flick;

  outColor = vec4(color * intens, alpha);
}`;

// ---------- GL helpers ----------
function makeProgram(vsSrc, fsSrc){
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs,vsSrc); gl.compileShader(vs);
  if(!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(vs));
  const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs,fsSrc); gl.compileShader(fs);
  if(!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(fs));
  const p = gl.createProgram(); gl.attachShader(p,vs); gl.attachShader(p,fs); gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function createTexture(w,h,ifmt,fmt,type){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,ifmt,w,h,0,fmt,type,null);
  gl.bindTexture(gl.TEXTURE_2D,null);
  return t;
}

// ---------- State ----------
let program, u={}, vao, quadBuf, cellBuf;
let glyphTex, headTex, atlasTex, atlasCols=0, atlasRows=0;
let gridIdx, heads, headVel, paused=false;

// Cell helpers / protection map
const idx = (c, r) => r * cols + c;
let protectedCells = new Uint8Array(0);

// Per-column headline memory (for clicks & hover locks)
let colHeadlineText = []; // string or undefined
let colHeadlineUrl  = []; // url or undefined

// Hover lock
let hoveredCol = -1;

// Async rebuild gating
let ready=false, building=false;
let rebuildRequestId=0;
function queueRebuild(){ rebuildRequestId++; rebuild(); }
async function rebuild(){
  const myId = rebuildRequestId;
  if (building) return;
  building = true; ready = false;

  try{
    if(!atlasTex){
      const atlas = await buildAtlasTexture();
      atlasTex = atlas.tex; atlasCols = atlas.atlasCols; atlasRows = atlas.atlasRows;
    }
    if (myId !== rebuildRequestId) { building=false; return; }

    gridIdx = new Uint8Array(cols*rows);
    for (let i=0;i<gridIdx.length;i++) gridIdx[i]=Math.floor(Math.random()*GLYPHS.length);
    protectedCells = new Uint8Array(cols * rows);

    heads = new Float32Array(cols);
    headVel = new Float32Array(cols);
    for (let c=0;c<cols;c++){ heads[c]=Math.floor(Math.random()*rows); headVel[c]=SPEED_MIN+Math.random()*(SPEED_MAX-SPEED_MIN); }

    if (glyphTex) gl.deleteTexture(glyphTex);
    if (headTex)  gl.deleteTexture(headTex);
    glyphTex = createTexture(cols, rows, gl.R8,   gl.RED, gl.UNSIGNED_BYTE);
    headTex  = createTexture(cols, 1,    gl.R32F, gl.RED, gl.FLOAT);

    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,rows,gl.RED,gl.UNSIGNED_BYTE,gridIdx);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindTexture(gl.TEXTURE_2D, headTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.FLOAT,heads);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if(!program){
      program = makeProgram(VS,FS);
      gl.useProgram(program);
      u = {
        uCanvas: gl.getUniformLocation(program,"uCanvas"),
        uCell: gl.getUniformLocation(program,"uCell"),
        uGrid: gl.getUniformLocation(program,"uGrid"),
        uAtlas: gl.getUniformLocation(program,"uAtlas"),
        uGlyphTex: gl.getUniformLocation(program,"uGlyphTex"),
        uHeadTex: gl.getUniformLocation(program,"uHeadTex"),
        uAtlasGrid: gl.getUniformLocation(program,"uAtlasGrid"),
        uColorBody: gl.getUniformLocation(program,"uColorBody"),
        uColorHead: gl.getUniformLocation(program,"uColorHead"),
        uTrail: gl.getUniformLocation(program,"uTrail"),
        uTime: gl.getUniformLocation(program,"uTime")
      };
    }

    const quad = new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]);
    if (quadBuf) gl.deleteBuffer(quadBuf);
    quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const cells = new Float32Array(cols*rows*2);
    let p=0; for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ cells[p++]=c; cells[p++]=r; }
    if (cellBuf) gl.deleteBuffer(cellBuf);
    cellBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cellBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cells, gl.STATIC_DRAW);

    if (vao) gl.deleteVertexArray(vao);
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER, cellBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,2,gl.FLOAT,false,0,0);
    gl.vertexAttribDivisor(1,1);
    gl.bindVertexArray(null);

    gl.viewport(0,0,width,height);
    if (myId === rebuildRequestId) ready = true;
  } finally {
    building=false;
  }
}

// ---------- Headline normalization / filtering ----------
function normalizeTitle(raw){
  if (!raw) return "";
  let s = String(raw)
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”«»„‟]/g, '"').replace(/[‘’‚‛‹›]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .toUpperCase();

  let out = "";
  for (const ch of s) {
    if (ch === " " || GLYPH_MAP.has(ch)) out += ch;
    else if (/\s/.test(ch)) out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

// ---------- Headlines (keep URL too) ----------
let headlines = [];
async function getNews(){
  try{
    const r = await fetch("/api/news");
    const j = await r.json();
    headlines = (j.items || [])
      .map(x => ({ t: normalizeTitle(x.t), u: x.u || "" }))
      .filter(h => h.t);
    if (!getNews._logged) {
      console.log("[matrix-news] normalized headlines:", headlines.length);
      getNews._logged = true;
    }
  }catch(e){
    console.warn("[matrix-news] news fetch failed", e);
  }
}

// Write a full column with repeating headline, optionally protecting cells
function writeColumnHeadline(col, text, protect=true){
  if (col < 0 || col >= cols || !text) return;
  const L = text.length;
  if (!L) return;
  for (let r=0; r<rows; r++){
    const ch = text[r % L];
    const k  = idx(col, r);
    let glyph;
    if (ch === ' ' && KEEP_SPACES) glyph = GLYPH_MAP.get(' ');
    else glyph = GLYPH_MAP.has(ch) ? GLYPH_MAP.get(ch) : Math.floor(Math.random()*GLYPHS.length);
    gridIdx[k] = glyph;
    if (protect) protectedCells[k] = 1;
  }
}

// ---------- Injection (skips hovered column) ----------
function injectHeadline(){
  if(!ready || !headlines.length || !heads) return;

  // choose a non-hovered column
  let col = Math.floor(Math.random() * Math.max(1, Math.min(cols, heads.length)));
  if (hoveredCol >= 0 && cols > 1) {
    let tries = 0;
    while (col === hoveredCol && tries++ < 8) {
      col = Math.floor(Math.random() * Math.max(1, Math.min(cols, heads.length)));
    }
    if (col === hoveredCol) return; // all columns locked? skip
  }

  const pick = headlines[Math.floor(Math.random() * Math.min(40, headlines.length))];
  if (!pick || !pick.t) return;

  // start a bit behind head so trail reveals soon
  const back = 10 + Math.floor(Math.random() * 10);
  const start = (Math.floor(heads[col]) - back + rows) % rows;

  const keepProb = Math.max(0, Math.min(1, 1 - SCRAMBLE_PCT));
  const toUnprotect = [];

  for (let i = 0; i < pick.t.length && i < rows; i++){
    const row = (start + i) % rows;
    const k   = idx(col, row);
    const ch  = pick.t[i];

    let glyph;
    if (ch === ' ' && KEEP_SPACES) glyph = GLYPH_MAP.get(' ');
    else glyph = (Math.random() < keepProb && GLYPH_MAP.has(ch))
      ? GLYPH_MAP.get(ch)
      : Math.floor(Math.random() * GLYPHS.length);

    gridIdx[k] = glyph;
    protectedCells[k] = 1;
    toUnprotect.push(k);
  }

  // Remember mapping for click/hover
  colHeadlineText[col] = pick.t;
  colHeadlineUrl[col]  = pick.u || "";

  // Upload
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED, gl.UNSIGNED_BYTE, gridIdx);
  gl.bindTexture(gl.TEXTURE_2D, null);

  setTimeout(() => { for (const k of toUnprotect) protectedCells[k] = 0; }, PROTECT_MS);
}

// ---------- Hover handling ----------
function columnFromEvent(e){
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  let col = Math.floor(x / CELL_W);
  if (col < 0) col = 0;
  if (col >= cols) col = cols - 1;
  return col;
}

function unlockColumn(col){
  if (col < 0) return;
  for (let r=0; r<rows; r++){
    protectedCells[idx(col, r)] = 0;
  }
}

function lockColumn(col){
  if (col < 0) return;
  const existingText = colHeadlineText[col];
  const existingUrl  = colHeadlineUrl[col];

  // If column has no headline yet, pick one now and remember it
  if (!existingText) {
    const pick = headlines[Math.floor(Math.random() * Math.min(40, headlines.length))];
    if (pick) {
      colHeadlineText[col] = pick.t;
      colHeadlineUrl[col]  = pick.u || "";
    }
  }

  // Write full column with chosen headline, fully unscrambled & protected
  writeColumnHeadline(col, colHeadlineText[col] || "", true);

  // Upload only once on lock (rest of the frame loop keeps it intact via protection)
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED, gl.UNSIGNED_BYTE, gridIdx);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Cursor hint
  canvas.style.cursor = (colHeadlineUrl[col] && colHeadlineUrl[col].length) ? "pointer" : "default";
}

canvas.addEventListener("mousemove", (e)=>{
  if (!ready) return;
  const col = columnFromEvent(e);
  if (col === hoveredCol) return;

  // release old
  if (hoveredCol >= 0) unlockColumn(hoveredCol);

  // set new
  hoveredCol = col;
  lockColumn(hoveredCol);
});

canvas.addEventListener("mouseleave", ()=>{
  if (hoveredCol >= 0) unlockColumn(hoveredCol);
  hoveredCol = -1;
  canvas.style.cursor = "default";
});

canvas.addEventListener("click", ()=>{
  if (hoveredCol >= 0) {
    const url = colHeadlineUrl[hoveredCol];
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
});

// ---------- Loop ----------
let lastTime=performance.now();
function frame(now){
  const dt=Math.min(0.05,(now-lastTime)/1000); lastTime=now;

  gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);

  if (!ready || !heads || !headVel) { requestAnimationFrame(frame); return; }

  gl.useProgram(program); gl.bindVertexArray(vao);

  if(!paused){
    const nCols = Math.min(cols, heads.length, headVel.length);
    for(let c=0;c<nCols;c++){
      heads[c]=(heads[c]+headVel[c]*(dt*5.0))%rows;

      // churn only if not fully protected (hovered col is protected)
      if (Math.random() < CHURN_RATE && c !== hoveredCol) {
        const r = Math.floor(Math.random() * rows);
        const k = idx(c, r);
        if (!protectedCells[k]) {
          gridIdx[k] = Math.floor(Math.random() * GLYPHS.length);
        }
      }
    }
    // Upload heads & occasional churn
    gl.bindTexture(gl.TEXTURE_2D, headTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.FLOAT,heads);
    gl.bindTexture(gl.TEXTURE_2D,null);

    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,rows,gl.RED,gl.UNSIGNED_BYTE,gridIdx);
    gl.bindTexture(gl.TEXTURE_2D,null);
  }

  gl.uniform2f(u.uCanvas, width, height);
  gl.uniform2f(u.uCell, CELL_W*DPR, CELL_H*DPR);
  gl.uniform2f(u.uGrid, cols, rows);
  gl.uniform2f(u.uAtlasGrid, atlasCols, atlasRows);
  gl.uniform3f(u.uColorBody, 0.0, 1.0, 0.255);
  gl.uniform3f(u.uColorHead, 0.73, 1.0, 0.79);
  gl.uniform1f(u.uTrail, TRAIL);
  gl.uniform1f(u.uTime, now*0.001);

  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex); gl.uniform1i(u.uAtlas,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glyphTex); gl.uniform1i(u.uGlyphTex,1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, headTex);  gl.uniform1i(u.uHeadTex,2);

  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cols*rows);
  gl.bindVertexArray(null);

  requestAnimationFrame(frame);
}

// ---------- Input ----------
addEventListener("keydown", e => { if(e.code==="Space") paused=!paused; });

// ---------- Start ----------
await getNews();
resize();            // triggers queueRebuild()
requestAnimationFrame(frame);
setInterval(()=>getNews(), 10*60*1000);
setInterval(()=>{ if(!paused) injectHeadline(); }, INJECT_EVERY);
