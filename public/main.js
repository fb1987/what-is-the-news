// --- main.js (hover works while paused; per-column reveal mask) ---
const DPR = Math.min(devicePixelRatio || 1, 2);
const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl2", {
  alpha:false, antialias:false, depth:false, stencil:false,
  powerPreference:"high-performance"
});
if (!gl) { alert("WebGL2 not available"); throw new Error("WebGL2 required"); }
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // safe row uploads

// ---------- Visual constants ----------
const CELL_W = 24, CELL_H = 24, TRAIL = 28;
const SPEED_MIN = 0.25, SPEED_MAX = 1.6;
const INJECT_EVERY = 1200;
const CHURN_RATE = 0.004;

// ---------- Scramble/legibility controls ----------
let SCRAMBLE_PCT = 0.25;      // 0.00 = clear, 1.00 = chaos
const KEEP_SPACES = true;
const PROTECT_MS  = 6000;     // protection for injected letters (ms)
window.setScramble = (p) => { SCRAMBLE_PCT = Math.max(0, Math.min(1, p)); };

// Stagger timings (ms)
const UNSCRAMBLE_MS = [1200, 3000]; // hover on
const SCRAMBLE_MS   = [1000, 2500]; // hover off
const randMs = (range) => range[0] + Math.random() * (range[1]-range[0]);

// ---------- Glyphs (includes real space) ----------
const GLYPHS = [
  ..." ",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."<>[]{}()+-=/*_|\\!?:;.,'\"",
  ..."ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ",
  ..."•◇◆"
];
const GLYPH_MAP = new Map(GLYPHS.map((ch, i) => [ch, i]));
const ATLAS_TILE = 64;
function charIndex(ch){ return GLYPH_MAP.has(ch) ? GLYPH_MAP.get(ch) : Math.floor(Math.random()*GLYPHS.length); }

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
uniform sampler2D uAtlas, uGlyphTex, uHeadTex, uRevealTex; // + uRevealTex
uniform vec2 uAtlasGrid, uGrid;
uniform vec3 uColorBody, uColorHead;
uniform float uTrail, uTime;
float h(vec3 p){ p=fract(p*.1031); p+=dot(p,p.yzx+33.33); return fract((p.x+p.y)*p.z); }
void main(){
  ivec2 cell = ivec2(int(vCell.x), int(vCell.y));
  float gi01 = texelFetch(uGlyphTex, cell, 0).r;
  float gi    = floor(gi01*255.0+0.5);
  float ac = uAtlasGrid.x;
  float ix = mod(gi, ac), iy = floor(gi/ac);
  vec2 tUV = (vec2(ix,iy)+vQuadUV)/uAtlasGrid;
  float glyphMask = texture(uAtlas, tUV).r;

  float headRow = texelFetch(uHeadTex, ivec2(int(vCell.x),0), 0).r;
  float dr = mod((headRow - vCell.y + uGrid.y), uGrid.y);
  float trailT  = clamp(1.0 - (dr/uTrail), 0.0, 1.0);
  float isHead  = step(dr, 0.8);

  // reveal mask makes whole column visible (for hover/anim), even when paused
  float reveal = texelFetch(uRevealTex, ivec2(int(vCell.x),0), 0).r; // 0..1
  float gate = max(max(trailT, isHead), step(0.5, reveal));

  float alpha = smoothstep(0.35, 0.55, glyphMask) * gate;
  float flick = 0.85 + 0.45*h(vec3(vCell.x, vCell.y, floor(uTime*60.0)));
  vec3 color  = mix(uColorBody, uColorHead, isHead);
  float intens = (0.15 + 0.85*trailT) * flick;

  outColor = vec4(color*intens, alpha);
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
let glyphTex, headTex, revealTex, atlasTex, atlasCols=0, atlasRows=0;
let gridIdx, heads, headVel, paused=false;

const idx = (c, r) => r * cols + c;
let protectedCells = new Uint8Array(0);

// Per-column memory (for click & hover)
let colHeadlineText = [];
let colHeadlineUrl  = [];

// Reveal mask (per column)
let revealCols = new Uint8Array(0);
function uploadReveal(){
  gl.bindTexture(gl.TEXTURE_2D, revealTex);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.UNSIGNED_BYTE,revealCols);
  gl.bindTexture(gl.TEXTURE_2D,null);
}

// Hover / transitions
let hoveredCol = -1;
// activeTransitions: Map<col, {mode, start, delays:Float32Array, applied:Uint8Array, targets?:Uint8Array}>
const activeTransitions = new Map();

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
    protectedCells = new Uint8Array(cols*rows);

    heads = new Float32Array(cols);
    headVel = new Float32Array(cols);
    for (let c=0;c<cols;c++){ heads[c]=Math.floor(Math.random()*rows); headVel[c]=SPEED_MIN+Math.random()*(SPEED_MAX-SPEED_MIN); }

    if (glyphTex) gl.deleteTexture(glyphTex);
    if (headTex)  gl.deleteTexture(headTex);
    if (revealTex) gl.deleteTexture(revealTex);

    glyphTex  = createTexture(cols, rows, gl.R8,   gl.RED, gl.UNSIGNED_BYTE);
    headTex   = createTexture(cols, 1,    gl.R32F, gl.RED, gl.FLOAT);
    revealTex = createTexture(cols, 1,    gl.R8,   gl.RED, gl.UNSIGNED_BYTE);

    // init textures
    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,rows,gl.RED,gl.UNSIGNED_BYTE,gridIdx);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindTexture(gl.TEXTURE_2D, headTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.FLOAT,heads);
    gl.bindTexture(gl.TEXTURE_2D, null);

    revealCols = new Uint8Array(cols); // all zeros initially
    uploadReveal();

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
        uRevealTex: gl.getUniformLocation(program,"uRevealTex"),
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

    // Reset hover/animations on rebuild
    activeTransitions.clear();
    hoveredCol = -1;

    ready = (myId === rebuildRequestId);
  } finally {
    building=false;
  }
}

// ---------- Headline normalization ----------
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

// ---------- Headlines ----------
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

// ---------- Injection (skips hovered or animating columns) ----------
function injectHeadline(){
  if(!ready || !headlines.length || !heads) return;

  let col = Math.floor(Math.random() * Math.max(1, Math.min(cols, heads.length)));
  let attempts = 0;
  while ((col === hoveredCol || activeTransitions.has(col)) && attempts++ < 12){
    col = Math.floor(Math.random() * Math.max(1, Math.min(cols, heads.length)));
  }
  if (col === hoveredCol || activeTransitions.has(col)) return;

  const pick = headlines[Math.floor(Math.random() * Math.min(40, headlines.length))];
  if (!pick || !pick.t) return;

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
    else glyph = (Math.random() < keepProb && GLYPH_MAP.has(ch)) ? GLYPH_MAP.get(ch) : Math.floor(Math.random()*GLYPHS.length);
    gridIdx[k] = glyph;
    protectedCells[k] = 1;
    toUnprotect.push(k);
  }

  colHeadlineText[col] = pick.t;
  colHeadlineUrl[col]  = pick.u || "";

  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED, gl.UNSIGNED_BYTE, gridIdx);
  gl.bindTexture(gl.TEXTURE_2D, null);

  setTimeout(() => { for (const k of toUnprotect) protectedCells[k] = 0; }, PROTECT_MS);
}

// ---------- Staggered transitions ----------
function scheduleUnscramble(col, text){
  if (!text) return;
  const L = text.length;
  const delays = new Float32Array(rows);
  const targets = new Uint8Array(rows);
  for (let r=0;r<rows;r++){
    delays[r] = Math.random() * randMs(UNSCRAMBLE_MS);
    const ch = text[r % L];
    targets[r] = (ch === ' ' && KEEP_SPACES) ? GLYPH_MAP.get(' ') : (GLYPH_MAP.has(ch) ? GLYPH_MAP.get(ch) : Math.floor(Math.random()*GLYPHS.length));
    protectedCells[idx(col,r)] = 1; // prevent churn during flip-in
  }
  revealCols[col] = 255; // fully visible regardless of trail/paused
  uploadReveal();
  activeTransitions.set(col, { mode:'unscramble', start: performance.now(), delays, applied: new Uint8Array(rows), targets });
}

function scheduleScramble(col){
  const delays = new Float32Array(rows);
  for (let r=0;r<rows;r++){
    delays[r] = Math.random() * randMs(SCRAMBLE_MS);
    protectedCells[idx(col,r)] = 1; // keep steady until flipped out
  }
  // keep reveal ON during scramble so you can watch the flip-out while paused
  activeTransitions.set(col, { mode:'scramble', start: performance.now(), delays, applied: new Uint8Array(rows) });
}

function processTransitions(nowMs){
  if (activeTransitions.size === 0) return false;
  let changed = false;
  for (const [col, tr] of activeTransitions){
    let done=0;
    for (let r=0;r<rows;r++){
      if (tr.applied[r]) { done++; continue; }
      if (nowMs - tr.start >= tr.delays[r]){
        const k = idx(col,r);
        if (tr.mode === 'unscramble'){
          gridIdx[k] = tr.targets[r];
        } else { // scramble
          gridIdx[k] = Math.floor(Math.random()*GLYPHS.length);
        }
        tr.applied[r] = 1;
        changed = true;
        done++;
      }
    }
    if (done === rows){
      if (tr.mode === 'scramble'){
        for (let r=0;r<rows;r++) protectedCells[idx(col,r)] = 0;
        revealCols[col] = 0; // hide column again after flip-out completes
        uploadReveal();
      }
      activeTransitions.delete(col);
    }
  }
  return changed;
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

function beginHover(col){
  const existingText = colHeadlineText[col];
  if (!existingText){
    const pick = headlines[Math.floor(Math.random() * Math.min(40, headlines.length))];
    if (pick){ colHeadlineText[col] = pick.t; colHeadlineUrl[col] = pick.u || ""; }
  }
  scheduleUnscramble(col, colHeadlineText[col] || "");
  canvas.style.cursor = (colHeadlineUrl[col] && colHeadlineUrl[col].length) ? "pointer" : "default";
}

function endHover(col){
  scheduleScramble(col);
  canvas.style.cursor = "default";
}

canvas.addEventListener("mousemove", (e)=>{
  if (!ready) return;
  const col = columnFromEvent(e);
  if (col === hoveredCol) return;

  if (hoveredCol >= 0){
    activeTransitions.delete(hoveredCol);
    endHover(hoveredCol);
  }

  hoveredCol = col;
  activeTransitions.delete(hoveredCol);
  beginHover(hoveredCol);
});

canvas.addEventListener("mouseleave", ()=>{
  if (!ready) return;
  if (hoveredCol >= 0){
    activeTransitions.delete(hoveredCol);
    endHover(hoveredCol);
  }
  hoveredCol = -1;
});

canvas.addEventListener("click", ()=>{
  if (hoveredCol >= 0){
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

  // Update motion/churn only when not paused
  if(!paused){
    const nCols = Math.min(cols, heads.length, headVel.length);
    for(let c=0;c<nCols;c++){
      heads[c]=(heads[c]+headVel[c]*(dt*5.0))%rows;
      if (Math.random() < CHURN_RATE && c !== hoveredCol && !activeTransitions.has(c)) {
        const r = Math.floor(Math.random() * rows);
        const k = idx(c, r);
        if (!protectedCells[k]) gridIdx[k] = Math.floor(Math.random() * GLYPHS.length);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, headTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.FLOAT,heads);
    gl.bindTexture(gl.TEXTURE_2D,null);
  }

  // Always process hover transitions even when paused
  const changed = processTransitions(performance.now());

  // Always upload glyphs each frame (cheap enough; ensures paused hover updates show)
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,rows,gl.RED,gl.UNSIGNED_BYTE,gridIdx);
  gl.bindTexture(gl.TEXTURE_2D,null);

  // uniforms
  gl.uniform2f(u.uCanvas, width, height);
  gl.uniform2f(u.uCell, CELL_W*DPR, CELL_H*DPR);
  gl.uniform2f(u.uGrid, cols, rows);
  gl.uniform2f(u.uAtlasGrid, atlasCols, atlasRows);
  gl.uniform3f(u.uColorBody, 0.0, 1.0, 0.255);
  gl.uniform3f(u.uColorHead, 0.73, 1.0, 0.79);
  gl.uniform1f(u.uTrail, TRAIL);
  gl.uniform1f(u.uTime, now*0.001);

  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex);  gl.uniform1i(u.uAtlas,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glyphTex);  gl.uniform1i(u.uGlyphTex,1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, headTex);   gl.uniform1i(u.uHeadTex,2);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, revealTex); gl.uniform1i(u.uRevealTex,3);

  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cols*rows);
  gl.bindVertexArray(null);

  requestAnimationFrame(frame);
}

// ---------- Input ----------
addEventListener("keydown", e => { if(e.code==="Space") paused=!paused; });

// ---------- Start ----------
await getNews();
resize();
requestAnimationFrame(frame);
setInterval(()=>getNews(), 10*60*1000);
setInterval(()=>{ if(!paused) injectHeadline(); }, INJECT_EVERY);
