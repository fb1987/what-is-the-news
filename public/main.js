// --- main.js (CRT post-FX + hover reveal + modal UI) ---
const DPR = Math.min(devicePixelRatio || 1, 2);
const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl2", {
  alpha:false, antialias:false, depth:false, stencil:false,
  powerPreference:"high-performance"
});
if (!gl) { alert("WebGL2 not available"); throw new Error("WebGL2 required"); }
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

// ---------- Visual constants ----------
const CELL_W = 24, CELL_H = 24, TRAIL = 28;
const SPEED_MIN = 0.30, SPEED_MAX = 1.4;
const INJECT_EVERY = 1200, CHURN_RATE = 0.004;

// ---------- Scramble controls ----------
let SCRAMBLE_PCT = 0.25;
const KEEP_SPACES = true, PROTECT_MS = 6000;
window.setScramble = p => { SCRAMBLE_PCT = Math.max(0, Math.min(1, p)); };

// Stagger timings
const UNSCRAMBLE_MS = [1200, 3000];
const SCRAMBLE_MS   = [1000, 2500];
const randMs = r => r[0] + Math.random() * (r[1]-r[0]);

// ---------- Glyphs (includes space) ----------
const GLYPHS = [
  ..." ",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."<>[]{}()+-=/*_|\\!?:;.,'\"",
  ..."ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ",
  ..."•◇◆"
];
const GLYPH_MAP = new Map(GLYPHS.map((ch, i) => [ch, i]));
const ATLAS_TILE = 64;
const charIndex = ch => GLYPH_MAP.has(ch) ? GLYPH_MAP.get(ch) : Math.floor(Math.random()*GLYPHS.length);

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

// ---------- Shaders (scene) ----------
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
uniform sampler2D uAtlas, uGlyphTex, uHeadTex, uRevealTex;
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

  float reveal = texelFetch(uRevealTex, ivec2(int(vCell.x),0), 0).r;
  float gate = max(max(trailT, isHead), step(0.5, reveal));

  float alpha = smoothstep(0.35, 0.55, glyphMask) * gate;
  float flick = 0.85 + 0.25*h(vec3(vCell.x, vCell.y, floor(uTime*60.0)));
  vec3 color  = mix(uColorBody, uColorHead, isHead);
  float intens = (0.15 + 0.85*trailT) * flick;

  outColor = vec4(color*intens, alpha);
}`;

// ---------- Post-processing (CRT) ----------
const POST_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){
  vUV = (aPos + 1.0) * 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
const POST_FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uTime, uPaused;

// hash
float n21(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }

void main(){
  vec2 uv = vUV;
  vec2 px = 1.0 / uRes;

  // slight barrel distortion
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);
  uv = uv + cc * r2 * 0.04;

  // chromatic aberration
  float ca = mix(0.75, 2.0, uPaused); // stronger when paused
  vec3 col;
  col.r = texture(uScene, uv + px*vec2( ca, 0.0)).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - px*vec2( ca, 0.0)).b;

  // bright pass + cheap bloom (9-tap)
  float thr = 0.25;
  vec3 bright = max(col - thr, 0.0);
  vec3 blur = vec3(0.0);
  vec2 o = px * mix(1.5, 3.0, uPaused); // larger radius when paused
  vec2 offs[8] = vec2[8]( vec2(-o.x,0), vec2(o.x,0), vec2(0,-o.y), vec2(0,o.y),
                          vec2(-o.x,-o.y), vec2(o.x,-o.y), vec2(-o.x,o.y), vec2(o.x,o.y) );
  for (int i=0;i<8;i++) blur += texture(uScene, uv + offs[i]).rgb;
  blur = (blur/8.0);
  vec3 bloom = bright * mix(1.2, 2.6, uPaused) + blur * mix(0.6, 1.4, uPaused);

  // scanlines + subpixel mask
  float scan = 0.85 + 0.15*sin((uv.y*uRes.y)*3.14159);
  float grille = 0.92 + 0.08*sin(uv.x*uRes.x*3.14159);
  col *= scan * grille;

  // vignette
  float vig = smoothstep(0.95, 0.4, r2);
  col *= vig;

  // noise/flicker
  float noise = (n21(uv*uRes + uTime*vec2(13.1,7.7)) - 0.5) * mix(0.02, 0.07, uPaused);
  float flick = 1.0 + (sin(uTime*50.0) * 0.005) + noise;

  // combine + halo
  vec3 glow = bloom;
  vec3 outc = col*flick + glow;

  // green bias
  outc = vec3(outc.r*0.6, outc.g*1.1, outc.b*0.7);

  frag = vec4(outc, 1.0);
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
let program, postProgram, u={}, pu={}, vao, quadBuf, cellBuf;
let postVAO, postBuf;
let glyphTex, headTex, revealTex, atlasTex, atlasCols=0, atlasRows=0;
let sceneTex, sceneFBO;
let gridIdx, heads, headVel, paused=false;

const idx = (c, r) => r * cols + c;
let protectedCells = new Uint8Array(0);
let revealCols = new Uint8Array(0);

// Per-column memory
let colHeadlineText = [], colHeadlineUrl  = [];

// Hover / transitions
let hoveredCol = -1;
const activeTransitions = new Map();

// ---------- Render target ----------
function createRenderTarget(){
  if (sceneTex) { gl.deleteTexture(sceneTex); sceneTex=null; }
  if (sceneFBO) { gl.deleteFramebuffer(sceneFBO); sceneFBO=null; }

  sceneTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  sceneFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) throw new Error("FBO incomplete");
}

// ---------- Build/Rebuild ----------
let ready=false, building=false, rebuildRequestId=0;
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

    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,rows,gl.RED,gl.UNSIGNED_BYTE,gridIdx);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindTexture(gl.TEXTURE_2D, headTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.FLOAT,heads);
    gl.bindTexture(gl.TEXTURE_2D, null);

    revealCols = new Uint8Array(cols); uploadReveal();

    // Programs
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
    if(!postProgram){
      postProgram = makeProgram(POST_VS, POST_FS);
      gl.useProgram(postProgram);
      pu = {
        uScene: gl.getUniformLocation(postProgram,"uScene"),
        uRes:   gl.getUniformLocation(postProgram,"uRes"),
        uTime:  gl.getUniformLocation(postProgram,"uTime"),
        uPaused:gl.getUniformLocation(postProgram,"uPaused")
      };
      // fullscreen quad
      const quad = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
      postBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, postBuf);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      postVAO = gl.createVertexArray(); gl.bindVertexArray(postVAO);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
      gl.bindVertexArray(null);
    }

    // cell mesh
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

    // render target
    createRenderTarget();

    // Reset transitions
    activeTransitions.clear();
    hoveredCol = -1;

    ready = (myId === rebuildRequestId);
  } finally { building=false; }
}

// ---------- Reveal tex upload ----------
function uploadReveal(){
  gl.bindTexture(gl.TEXTURE_2D, revealTex);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.UNSIGNED_BYTE,revealCols);
  gl.bindTexture(gl.TEXTURE_2D,null);
}

// ---------- Normalize titles ----------
function normalizeTitle(raw){
  if (!raw) return "";
  let s = String(raw)
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”«»„‟]/g, '"').replace(/[‘’‚‛‹›]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .toUpperCase();
  let out = "";
  for (const ch of s) out += (ch===" "||GLYPH_MAP.has(ch)) ? ch : (/\s/.test(ch)?" ":"");
  return out.replace(/\s+/g," ").trim();
}

// ---------- Headlines ----------
let headlines = [];
async function getNews(){
  try{
    const r = await fetch("/api/news");
    const j = await r.json();
    headlines = (j.items || []).map(x => ({ t: normalizeTitle(x.t), u: x.u || "" })).filter(h=>h.t);
    if (!getNews._logged) { console.log("[matrix-news] normalized headlines:", headlines.length); getNews._logged = true; }
  }catch(e){ console.warn("[matrix-news] news fetch failed", e); }
}

// ---------- Injection (skips hovered/animating) ----------
function injectHeadline(){
  if(!ready || !headlines.length || !heads) return;

  let col = Math.floor(Math.random() * Math.max(1, Math.min(cols, heads.length)));
  let tries=0;
  while ((col===hoveredCol || activeTransitions.has(col)) && tries++<12) col = Math.floor(Math.random()*Math.max(1,Math.min(cols,heads.length)));
  if (col===hoveredCol || activeTransitions.has(col)) return;

  const pick = headlines[Math.floor(Math.random()*Math.min(40, headlines.length))];
  if (!pick || !pick.t) return;

  const back = 10 + Math.floor(Math.random() * 10);
  const start = (Math.floor(heads[col]) - back + rows) % rows;

  const keepProb = Math.max(0, Math.min(1, 1 - SCRAMBLE_PCT));
  const toUnprotect=[];
  for (let i=0;i<pick.t.length && i<rows;i++){
    const row=(start+i)%rows, k=idx(col,row), ch=pick.t[i];
    const glyph = (ch===' '&&KEEP_SPACES) ? GLYPH_MAP.get(' ')
                 : (Math.random()<keepProb && GLYPH_MAP.has(ch)) ? GLYPH_MAP.get(ch)
                 : Math.floor(Math.random()*GLYPHS.length);
    gridIdx[k]=glyph; protectedCells[k]=1; toUnprotect.push(k);
  }
  colHeadlineText[col]=pick.t; colHeadlineUrl[col]=pick.u||"";

  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,rows,gl.RED,gl.UNSIGNED_BYTE,gridIdx);
  gl.bindTexture(gl.TEXTURE_2D, null);

  setTimeout(()=>{ for(const k of toUnprotect) protectedCells[k]=0; }, PROTECT_MS);
}

// ---------- Staggered transitions ----------
function scheduleUnscramble(col, text){
  if (!text) return;
  const L=text.length, delays=new Float32Array(rows), targets=new Uint8Array(rows);
  for (let r=0;r<rows;r++){
    delays[r]=Math.random()*randMs(UNSCRAMBLE_MS);
    const ch=text[r%L];
    targets[r]=(ch===' '&&KEEP_SPACES)?GLYPH_MAP.get(' '):(GLYPH_MAP.has(ch)?GLYPH_MAP.get(ch):Math.floor(Math.random()*GLYPHS.length));
    protectedCells[idx(col,r)] = 1;
  }
  revealCols[col]=255; uploadReveal();
  activeTransitions.set(col,{mode:'unscramble',start:performance.now(),delays,applied:new Uint8Array(rows),targets});
}
function scheduleScramble(col){
  const delays=new Float32Array(rows);
  for (let r=0;r<rows;r++){ delays[r]=Math.random()*randMs(SCRAMBLE_MS); protectedCells[idx(col,r)]=1; }
  activeTransitions.set(col,{mode:'scramble',start:performance.now(),delays,applied:new Uint8Array(rows)});
}
function processTransitions(nowMs){
  if (activeTransitions.size===0) return;
  for (const [col,tr] of activeTransitions){
    let done=0;
    for (let r=0;r<rows;r++){
      if (tr.applied[r]) { done++; continue; }
      if (nowMs - tr.start >= tr.delays[r]){
        const k=idx(col,r);
        gridIdx[k] = (tr.mode==='unscramble') ? tr.targets[r] : Math.floor(Math.random()*GLYPHS.length);
        tr.applied[r]=1; done++;
      }
    }
    if (done===rows){
      if (tr.mode==='scramble'){
        for (let r=0;r<rows;r++) protectedCells[idx(col,r)]=0;
        revealCols[col]=0; uploadReveal();
      }
      activeTransitions.delete(col);
    }
  }
}

// ---------- Hover handling ----------
function columnFromEvent(e){
  const rect=canvas.getBoundingClientRect(); const x=e.clientX-rect.left;
  return Math.min(cols-1, Math.max(0, Math.floor(x / CELL_W)));
}
function beginHover(col){
  if (!colHeadlineText[col] && headlines.length){
    const pick = headlines[Math.floor(Math.random() * Math.min(40, headlines.length))];
    if (pick){ colHeadlineText[col]=pick.t; colHeadlineUrl[col]=pick.u||""; }
  }
  scheduleUnscramble(col, colHeadlineText[col]||"");
  canvas.style.cursor = (colHeadlineUrl[col] && colHeadlineUrl[col].length) ? "pointer" : "default";
}
function endHover(col){ scheduleScramble(col); canvas.style.cursor="default"; }

canvas.addEventListener("mousemove", e=>{
  if (!ready) return;
  const col = columnFromEvent(e);
  if (col===hoveredCol) return;
  if (hoveredCol>=0){ activeTransitions.delete(hoveredCol); endHover(hoveredCol); }
  hoveredCol = col; activeTransitions.delete(hoveredCol); beginHover(hoveredCol);
});
canvas.addEventListener("mouseleave", ()=>{
  if (!ready) return;
  if (hoveredCol>=0){ activeTransitions.delete(hoveredCol); endHover(hoveredCol); }
  hoveredCol = -1;
});
canvas.addEventListener("click", ()=>{
  if (hoveredCol>=0){ const url=colHeadlineUrl[hoveredCol]; if(url) window.open(url,"_blank","noopener,noreferrer"); }
});

// ---------- Loop ----------
let lastTime=performance.now();
function frame(now){
  const dt=Math.min(0.05,(now-lastTime)/1000); lastTime=now;

  if (!ready || !heads || !headVel) { requestAnimationFrame(frame); return; }

  // ---- First pass: scene to FBO ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
  gl.viewport(0,0,width,height);
  gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(program); gl.bindVertexArray(vao);

  if(!paused){
    const nCols=Math.min(cols, heads.length, headVel.length);
    for(let c=0;c<nCols;c++){
      heads[c]=(heads[c]+headVel[c]*(dt*5.0))%rows;
      if (Math.random()<CHURN_RATE && c!==hoveredCol && !activeTransitions.has(c)){
        const r=Math.floor(Math.random()*rows), k=idx(c,r);
        if(!protectedCells[k]) gridIdx[k]=Math.floor(Math.random()*GLYPHS.length);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, headTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,1,gl.RED,gl.FLOAT,heads);
    gl.bindTexture(gl.TEXTURE_2D,null);
  }

  processTransitions(performance.now());

  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,cols,rows,gl.RED,gl.UNSIGNED_BYTE,gridIdx);
  gl.bindTexture(gl.TEXTURE_2D,null);

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

  // ---- Second pass: post-processing to screen ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0,0,width,height);
  gl.disable(gl.BLEND);
  gl.useProgram(postProgram); gl.bindVertexArray(postVAO);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex); gl.uniform1i(pu.uScene,0);
  gl.uniform2f(pu.uRes, width, height);
  gl.uniform1f(pu.uTime, now*0.001);
  gl.uniform1f(pu.uPaused, paused ? 1.0 : 0.0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);

  requestAnimationFrame(frame);
}

// ---------- Input ----------
addEventListener("keydown", e => { if(e.code==="Space") paused=!paused; });

// ---------- UI Buttons & Modal ----------
const btnSpace   = document.getElementById("btn-space");
const btnRabbit  = document.getElementById("btn-rabbit");
const modal      = document.getElementById("modal");
const modalClose = document.getElementById("modal-close");

// Force closed on boot (in case CSS was cached differently)
if (modal) modal.hidden = true;

if (btnSpace) {
  btnSpace.addEventListener("click", (e)=>{ e.stopPropagation(); paused = !paused; });
}
if (btnRabbit && modal) {
  btnRabbit.addEventListener("click", (e)=>{ e.stopPropagation(); modal.hidden = false; });
}
if (modal && modalClose) {
  modalClose.addEventListener("click", (e)=>{ e.stopPropagation(); modal.hidden = true; });
  // click outside the window closes it
  modal.addEventListener("click", (e)=>{ if (e.target === modal) modal.hidden = true; });
}

// ---------- Start ----------
await getNews();
resize();
requestAnimationFrame(frame);
setInterval(()=>getNews(), 10*60*1000);
setInterval(()=>{ if(!paused) injectHeadline(); }, INJECT_EVERY);
