// --- main.js (safe against async init/resizes) ---
const DPR = Math.min(devicePixelRatio || 1, 2);
const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl2", { alpha:false, antialias:false, depth:false, stencil:false, powerPreference:"high-performance" });
if (!gl) { alert("WebGL2 not available"); throw new Error("WebGL2 required"); }

// ---------- Visual constants ----------
const CELL_W = 36, CELL_H = 36, TRAIL = 30;
const SPEED_MIN = 0.45, SPEED_MAX = 4;
const INJECT_EVERY = 1100, CHURN_RATE = 0.012;

// --- Legibility / scrambling controls ---
let SCRAMBLE_PCT = 0.30;   // 0.00 = no scramble (most readable), 1.00 = fully scrambled
const KEEP_SPACES = true;  // keep actual spaces (recommended for readability)
const PROTECT_MS  = 6000;  // how long injected letters are immune to churn (ms)

// Lower churn so fewer random flips; you can tune further
// (replace your existing CHURN_RATE constant with this)
const CHURN_RATE = 0.004;

// Convenience: live-tweakable from console or future hover
window.setScramble = (p) => { SCRAMBLE_PCT = Math.max(0, Math.min(1, p)); };


// ---------- Glyphs ----------
const GLYPHS = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."<>[]{}()+-=/*_|\\!?:;.,'\"",
  ..."ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ",
  ..."•◇◆"
];
const GLYPH_MAP = new Map(GLYPHS.map((ch, i) => [ch, i]));
function charIndex(ch) {
  // Map known chars to atlas index; space becomes noise for “Matrix” look
  return GLYPH_MAP.has(ch) ? GLYPH_MAP.get(ch) : Math.floor(Math.random() * GLYPHS.length);
}
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
  queueRebuild(); // async-safe
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
  // --- read exact glyph index per cell (no filtering) ---
  ivec2 cell = ivec2(int(vCell.x), int(vCell.y));
  float gi01 = texelFetch(uGlyphTex, cell, 0).r;     // [0..1] UNORM from R8
  float gi    = floor(gi01 * 255.0 + 0.5);           // [0..255] -> atlas index

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
  // This hides future glyphs completely.
  float alpha = smoothstep(0.35, 0.55, glyphMask) * max(trailT, isHead);

  // Color & intensity (slight flicker)
  float flick = 0.85 + 0.15 * h(vec3(vCell.x, vCell.y, floor(uTime*60.0)));
  vec3 color  = mix(uColorBody, uColorHead, isHead);
  float intens = (0.15 + 0.85 * trailT) * flick;

  outColor = vec4(color * intens, alpha);
}`
;

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

// Async rebuild gating
let ready=false, building=false;
let rebuildRequestId=0;
function queueRebuild(){
  rebuildRequestId++;
  rebuild(); // fire-and-forget; internally serialized
}
async function rebuild(){
  const myId = rebuildRequestId;
  if (building) return;          // collapse bursts
  building = true; ready = false;

  try{
    // (Re)create atlas once
    if(!atlasTex){
      const atlas = await buildAtlasTexture();
      atlasTex = atlas.tex; atlasCols = atlas.atlasCols; atlasRows = atlas.atlasRows;
    }
    // If a newer rebuild was requested while awaiting atlas, bail
    if (myId !== rebuildRequestId) { building=false; return; }

    // Allocate field textures & buffers for current cols/rows
    gridIdx = new Uint8Array(cols*rows);
    for (let i=0;i<gridIdx.length;i++) gridIdx[i]=Math.floor(Math.random()*GLYPHS.length);

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

    // Only mark ready if no newer rebuild was requested mid-flight
    if (myId === rebuildRequestId) ready = true;
  } finally {
    building=false;
  }
}

// ---------- Headlines ----------
let headlines = [];
async function getNews(){
  try{
    const r = await fetch("/api/news");
    const j = await r.json();
    headlines = (j.items || []).map(x => ({ t: String(x.t||"").toUpperCase() }));
    if (!getNews._logged && headlines.length) {
      console.log("[matrix-news] headlines:", headlines.length);
      getNews._logged = true;
    }
  }catch(e){
    console.warn("[matrix-news] news fetch failed", e);
  }
}

// Injection: start above head to ensure trail reveals it soon
function injectHeadline(){
  if(!ready || !headlines.length || !heads) return;

  const pick = headlines[Math.floor(Math.random() * Math.min(40, headlines.length))].t;

  // Choose a column and start a bit behind the head so trail reveals soon
  const col  = Math.floor(Math.random() * Math.max(1, Math.min(cols, heads.length)));
  const back = 10 + Math.floor(Math.random() * 10);
  const start = (Math.floor(heads[col]) - back + rows) % rows;

  const keepProb = Math.max(0, Math.min(1, 1 - SCRAMBLE_PCT));
  const now = performance.now();
  const toUnprotect = []; // record which cells we protect

  for (let i = 0; i < pick.length && i < rows; i++){
    const row = (start + i) % rows;
    const k   = idx(col, row);
    const ch  = pick[i];

    let glyph;
    if (ch === ' ' && KEEP_SPACES) {
      // Optional: use a visually faint middle dot for space or keep last glyph
      glyph = GLYPH_MAP.get(' ') ?? GLYPH_MAP.get('.');
      if (glyph === undefined) glyph = Math.floor(Math.random() * GLYPHS.length);
    } else {
      // Keep real char with prob keepProb, else scramble
      if (Math.random() < keepProb && GLYPH_MAP.has(ch)) glyph = GLYPH_MAP.get(ch);
      else glyph = Math.floor(Math.random() * GLYPHS.length);
    }

    gridIdx[k] = glyph;
    protectedCells[k] = 1;
    toUnprotect.push(k);
  }

  // Push to GPU
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED, gl.UNSIGNED_BYTE, gridIdx);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Schedule unprotect (lets natural churn resume later)
  setTimeout(() => {
    for (const k of toUnprotect) protectedCells[k] = 0;
  }, PROTECT_MS);
}



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
      if(Math.random()<CHURN_RATE){
        const r=Math.floor(Math.random()*rows);
        gridIdx[r*cols+c]=Math.floor(Math.random()*GLYPHS.length);
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
