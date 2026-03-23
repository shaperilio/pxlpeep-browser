// pxlpeep content script — fully self-contained, no dependencies.
// Ported from pxlpeep C++ (Qt/FreeImage) by shaperilio.
// ─────────────────────────────────────────────────────────────────────────────

if (window.__pxlpeepActive) { throw new Error("pxlpeep: already active"); }
window.__pxlpeepActive = true;

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS (ported from enums in ImageWindow.h / colormapper.h)
// ══════════════════════════════════════════════════════════════════════════════

const Scaling   = { Fit:0, Centered:1, User:2 };
const ImgFn     = { OneToOne:0, Log10Brighten:1, Log10Darken:2, Brighten:3, Darken:4 };
const Rotation  = { Zero:0, CCW90:1, CCW180:2, CCW270:3 };
const Palette   = { Grey:0, GreyInv:1, GreySat:2, GreySatInv:3, ColorExp:4, Color1:5 };
const PALETTE_NAMES = ["Grey","Inv. grey","Grey+sat","Inv. grey+sat","Color exp.","Colormap 1"];
const FN_NAMES  = ["1:1","log brighten","log darken","parabolic brighten","parabolic darken"];
const CHAN_R=1, CHAN_G=2, CHAN_B=4;
const ZOOM_STEP = Math.SQRT2;
const MAX_ZOOM  = 16, MIN_ZOOM = -16;
const DELTA_THRESH = 100; // wheel accumulator threshold

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

const S = {
  // image
  image: null,          // { width, height, numChannels, bpp, data:Float32Array, minValue, maxValue }
  imageUrl: window.__pxlpeepImageUrl || location.href,
  exif: null,           // { make, iso, shutterMs, aperture, date, ev }

  // zoom / pan
  zoomLevel: 0,
  zoomFactor: 1,
  panX: 0, panY: 0,

  // pixel transform
  scaling: Scaling.User,
  imgFn: ImgFn.OneToOne,
  dipFactor: 1,
  userMin: 0, userMax: 255,
  scaleMin: 0, scaleMax: 255,
  scale: 1, offset: 0,

  // palette
  palette: Palette.Grey,

  // channels
  channels: CHAN_R|CHAN_G|CHAN_B,

  // rotation / flip
  rotation: Rotation.Zero,
  flipH: false, flipV: false,

  // white balance (non-destructive, applied as uniforms)
  wbColor: [1,1,1],            // [r,g,b] gains
  wbGrey:  [1,1,1,1],          // [g00,g10,g01,g11] Bayer quad gains

  // overlays
  showInfo: true,
  showCursor: false,
  showRulers: true,
  showColorbar: true,
  showHelp: false,

  // ROI (in image coordinates)
  roi: { x1:0,y1:0,x2:0,y2:0, valid:false },

  // coordinate system
  yFlip: false,
  zeroIdx: true,

  // unit calibration
  unitPerPix: 1,
  unitName: "units",

  // cursor (viewport coords)
  cursorX: 0, cursorY: 0,
};

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE FUNCTIONS (ported from ImageWindow.cpp)
// ══════════════════════════════════════════════════════════════════════════════

function parabolicResponse(v, minV, maxV, dip) {
  const range = maxV - minV;
  if (range === 0) return v;
  const a = 2*(maxV+minV)*(1-dip)/(range*range);
  const b = 1 - a*(maxV+minV);
  const c = (1-b)/(maxV+minV)*(maxV+minV)**2/4 + (b-dip)*(maxV+minV)/2;
  return a*v*v + b*v + c;
}

function applyFn(v, fn, dip, minV, maxV) {
  switch(fn) {
    case ImgFn.Log10Brighten: {
      if (v > 0) { const r = Math.log10(v*dip*dip); return r > 0 ? r : 0; }
      return 0;
    }
    case ImgFn.Log10Darken: {
      if (v > 0) { const r = Math.log10(v/Math.max(dip*dip,1e-9)); return r > 0 ? r : 0; }
      return 0;
    }
    case ImgFn.Brighten: {
      const r = parabolicResponse(v, minV, maxV, dip);
      return Math.max(minV, Math.min(maxV, r));
    }
    case ImgFn.Darken: {
      const r = parabolicResponse(v, minV, maxV, 1/Math.max(dip,1e-9));
      return Math.max(minV, Math.min(maxV, r));
    }
    default: return v;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SCALE / OFFSET (ported from ImageWindow::translateImage)
// ══════════════════════════════════════════════════════════════════════════════

function recalcScale() {
  if (!S.image) return;
  const { minValue:minV, maxValue:maxV } = S.image;
  const fn = v => applyFn(v, S.imgFn, S.dipFactor, minV, maxV);
  const MAX_DISP = 255;

  if (S.scaling === Scaling.Centered) {
    let range = fn(maxV > minV ? maxV : minV);
    if (range < 0) range = -range;
    if (range === 0) range = 1;
    S.scale  = MAX_DISP/2/range;
    S.offset = -(MAX_DISP/2)/S.scale;
    S.scaleMin = -range; S.scaleMax = range;
  } else if (S.scaling === Scaling.Fit) {
    const fMin = fn(minV), fMax = fn(maxV);
    S.offset = fMin;
    S.scale  = (fMax===fMin) ? 1 : MAX_DISP/(fMax-fMin);
    S.scaleMin = minV; S.scaleMax = maxV;
  } else { // User
    const uMin = S.userMin, uMax = S.userMin===S.userMax ? S.userMin+255 : S.userMax;
    const fMin = fn(uMin), fMax = fn(uMax);
    S.offset = fMin;
    S.scale  = (fMax===fMin) ? 1 : MAX_DISP/(fMax-fMin);
    S.scaleMin = uMin; S.scaleMax = uMax;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LUT (ported from colormapper.h)
// ══════════════════════════════════════════════════════════════════════════════

function buildLUT() {
  // 256 × 6 RGBA8 packed into a flat Uint8Array (row = palette)
  const NUM_PAL = 6, SIZE = 256;
  const data = new Uint8Array(SIZE * NUM_PAL * 4);

  // Colormap1 waypoints: Black|Purple|Blue|Green|Magenta|Red|Yellow|White
  const CM1_R=[0,128,0,0,255,255,255,255];
  const CM1_G=[0,0,0,128,0,0,255,255];
  const CM1_B=[0,128,255,0,255,0,0,255];

  for (let p=0; p<NUM_PAL; p++) {
    for (let i=0; i<SIZE; i++) {
      const base = (p*SIZE+i)*4;
      switch(p) {
        case Palette.Grey:
          data[base]=data[base+1]=data[base+2]=i; data[base+3]=255; break;
        case Palette.GreyInv:
          data[base]=data[base+1]=data[base+2]=255-i; data[base+3]=255; break;
        case Palette.GreySat: {
          data[base+3]=255;
          if (i<=0)           {data[base]=0;   data[base+1]=0;   data[base+2]=255;}
          else if (i<13)      {data[base]=128; data[base+1]=128; data[base+2]=255;}
          else if (i>=255)    {data[base]=255; data[base+1]=0;   data[base+2]=0;}
          else if (i>242)     {data[base]=255; data[base+1]=128; data[base+2]=128;}
          else                {data[base]=i;   data[base+1]=i;   data[base+2]=i;}
          break;
        }
        case Palette.GreySatInv: {
          const v=255-i;
          data[base+3]=255;
          if (v<=0)           {data[base]=0;   data[base+1]=0;   data[base+2]=255;}
          else if (v<13)      {data[base]=128; data[base+1]=128; data[base+2]=255;}
          else if (v>=255)    {data[base]=255; data[base+1]=0;   data[base+2]=0;}
          else if (v>242)     {data[base]=255; data[base+1]=128; data[base+2]=128;}
          else                {data[base]=v;   data[base+1]=v;   data[base+2]=v;}
          break;
        }
        case Palette.ColorExp:
          // Simple expansion — in greyscale mode just grey; colour handled in shader
          data[base]=data[base+1]=data[base+2]=i; data[base+3]=255; break;
        case Palette.Color1: {
          const idx = Math.max(0,Math.min(7, i/255*7));
          const lo=Math.floor(idx), hi=Math.ceil(idx);
          const f = hi===lo ? 1 : (hi-idx)/(hi-lo);
          data[base]   = Math.round(CM1_R[lo]*f + CM1_R[hi]*(1-f));
          data[base+1] = Math.round(CM1_G[lo]*f + CM1_G[hi]*(1-f));
          data[base+2] = Math.round(CM1_B[lo]*f + CM1_B[hi]*(1-f));
          data[base+3] = 255;
          break;
        }
      }
    }
  }
  return data;
}

const LUT_DATA = buildLUT();

// ══════════════════════════════════════════════════════════════════════════════
// WEBGL2 RENDERER
// ══════════════════════════════════════════════════════════════════════════════

const VS = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUV;
void main(){vUV=aPos*.5+.5;gl_Position=vec4(aPos,0,1);}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uImg;
uniform sampler2D uLUT;
uniform int  uNChan,uChan,uFn,uPal,uRot;
uniform bool uFlipH,uFlipV;
uniform float uDip,uScale,uOffset,uSMin,uSMax,uMaxRaw;
uniform vec3  uWBC;
uniform vec4  uWBG;
uniform vec2  uSz;
uniform vec2  uVP;
uniform vec2  uPan;
uniform float uZoom;

vec2 xform(vec2 uv){
  if(uFlipH) uv.x=1.-uv.x;
  if(uFlipV) uv.y=1.-uv.y;
  if(uRot==1) uv=vec2(uv.y,1.-uv.x);
  else if(uRot==2) uv=vec2(1.-uv.x,1.-uv.y);
  else if(uRot==3) uv=vec2(1.-uv.y,uv.x);
  return uv;
}

float fn(float v){
  if(uFn==1){if(v>0.){float r=log(v*uDip*uDip)/log(10.);if(r>0.)return r;}return 0.;}
  if(uFn==2){if(v>0.){float r=log(v/max(uDip*uDip,1e-9))/log(10.);if(r>0.)return r;}return 0.;}
  if(uFn==3||uFn==4){
    float rng=uSMax-uSMin; if(rng==0.) return v;
    float dip=uFn==3?uDip:1./max(uDip,1e-9);
    float a=2.*(uSMax+uSMin)*(1.-dip)/(rng*rng);
    float b=1.-a*(uSMax+uSMin);
    float c=(1.-b)/(uSMax+uSMin)*(uSMax+uSMin)*(uSMax+uSMin)/4.+(b-dip)*(uSMax+uSMin)/2.;
    return clamp(a*v*v+b*v+c,uSMin,uSMax);
  }
  return v;
}

vec4 lut(float v){
  float t=clamp(v/255.,0.,1.);
  return texture(uLUT,vec2(t,(float(uPal)+.5)/6.));
}

vec4 satWarn(float v){
  if(v<=0.)  return vec4(0,0,1,1);
  if(v<13.)  return vec4(.5,.5,1,1);
  if(v>=255.)return vec4(1,0,0,1);
  if(v>242.) return vec4(1,.5,.5,1);
  float g=v/255.; return vec4(g,g,g,1);
}

void main(){
  vec2 fragPx=vec2(vUV.x,(1.-vUV.y))*uVP;
  vec2 dispSz=(uRot==1||uRot==3)?uSz.yx:uSz.xy;
  vec2 dispUV=(fragPx-uPan)/(uZoom*dispSz);
  if(dispUV.x<0.||dispUV.x>1.||dispUV.y<0.||dispUV.y>1.){fragColor=vec4(0.1,0.1,0.1,1.);return;}
  vec2 uv=xform(dispUV);
  vec4 tx=texture(uImg,uv);
  vec2 pc=uv*uSz;

  if(uNChan==1){
    int cx=int(mod(pc.x,2.)),cy=int(mod(pc.y,2.));
    float wb= cx==0&&cy==0?uWBG.x: cx==1&&cy==0?uWBG.y: cx==0&&cy==1?uWBG.z:uWBG.w;
    float raw=tx.r*uMaxRaw*wb;
    float mapped=(fn(raw)-uOffset)*uScale;
    if(uPal==2){fragColor=satWarn(mapped);return;}
    if(uPal==3){fragColor=satWarn(255.-mapped);return;}
    fragColor=lut(mapped); return;
  }

  bool aR=(uChan&1)!=0,aG=(uChan&2)!=0,aB=(uChan&4)!=0;
  float rR=aR?tx.r*uMaxRaw*uWBC.r:0.;
  float rG=aG?tx.g*uMaxRaw*uWBC.g:0.;
  float rB=aB?tx.b*uMaxRaw*uWBC.b:0.;

  int nA=(aR?1:0)+(aG?1:0)+(aB?1:0);
  if(nA==1){
    float solo=aR?rR:aG?rG:rB;
    float mapped=(fn(solo)-uOffset)*uScale;
    if(uPal==2){fragColor=satWarn(mapped);return;}
    if(uPal==3){fragColor=satWarn(255.-mapped);return;}
    fragColor=lut(mapped); return;
  }

  float mR=(fn(rR)-uOffset)*uScale;
  float mG=(fn(rG)-uOffset)*uScale;
  float mB=(fn(rB)-uOffset)*uScale;

  if(uPal==4){
    fragColor=vec4(clamp(mR/255.,0.,1.),clamp(mG/255.,0.,1.),clamp(mB/255.,0.,1.),1.);return;
  }
  if(uPal==2){fragColor=satWarn((mR+mG+mB)/3.);return;}
  if(uPal==3){fragColor=satWarn(255.-(mR+mG+mB)/3.);return;}

  fragColor=vec4(lut(mR).r,lut(mG).g,lut(mB).b,1.);
}`;

function makeShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error("Shader: " + gl.getShaderInfoLog(sh));
  return sh;
}

function makeProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, makeShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, makeShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error("Program: " + gl.getProgramInfoLog(prog));
  return prog;
}

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha:false, preserveDrawingBuffer:true });
    if (!gl) throw new Error("WebGL2 not supported");
    this.gl = gl;
    this.prog = makeProgram(gl, VS, FS);
    this.imgTex = null;
    this._buildQuad();
    this._buildLUT();
    this._cacheUniforms();
  }

  _buildQuad() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1,  1,-1, 1,1, -1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _buildLUT() {
    const gl = this.gl;
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 6, 0, gl.RGBA, gl.UNSIGNED_BYTE, LUT_DATA);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _cacheUniforms() {
    const gl = this.gl;
    const names = ["uImg","uLUT","uNChan","uChan","uFn","uPal","uRot",
      "uFlipH","uFlipV","uDip","uScale","uOffset","uSMin","uSMax",
      "uWBC","uWBG","uSz","uVP","uPan","uZoom","uMaxRaw"];
    this.u = {};
    for (const n of names) this.u[n] = gl.getUniformLocation(this.prog, n);
  }

  upload(data, width, height, numChannels) {
    const gl = this.gl;
    if (this.imgTex) gl.deleteTexture(this.imgTex);
    this.imgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    const fmt = numChannels===1 ? [gl.R32F, gl.RED] : [gl.RGB32F, gl.RGB];
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt[0], width, height, 0, fmt[1], gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.imgWidth = width;
    this.imgHeight = height;
    this.imgChannels = numChannels;
  }

  draw() {
    if (!this.imgTex) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.1, 0.1, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.uniform1i(this.u.uImg, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.u.uLUT, 1);

    gl.uniform1i(this.u.uNChan, S.image.numChannels);
    gl.uniform1i(this.u.uChan,  S.channels);
    gl.uniform1i(this.u.uFn,    S.imgFn);
    gl.uniform1i(this.u.uPal,   S.palette);
    gl.uniform1i(this.u.uRot,   S.rotation);
    gl.uniform1i(this.u.uFlipH, S.flipH ? 1 : 0);
    gl.uniform1i(this.u.uFlipV, S.flipV ? 1 : 0);
    gl.uniform1f(this.u.uDip,    S.dipFactor);
    gl.uniform1f(this.u.uScale,  S.scale);
    gl.uniform1f(this.u.uOffset, S.offset);
    gl.uniform1f(this.u.uSMin,   S.scaleMin);
    gl.uniform1f(this.u.uSMax,   S.scaleMax);
    gl.uniform3f(this.u.uWBC, S.wbColor[0], S.wbColor[1], S.wbColor[2]);
    gl.uniform4f(this.u.uWBG, S.wbGrey[0],  S.wbGrey[1],  S.wbGrey[2],  S.wbGrey[3]);
    gl.uniform2f(this.u.uSz, S.image.width, S.image.height);
    gl.uniform2f(this.u.uVP,   this.canvas.width, this.canvas.height);
    gl.uniform2f(this.u.uPan,  S.panX, S.panY);
    gl.uniform1f(this.u.uZoom, S.zoomFactor);
    gl.uniform1f(this.u.uMaxRaw, (1 << S.image.bpp) - 1);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE LOADING
// ══════════════════════════════════════════════════════════════════════════════

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const { width, height, data } = id;

      // Detect greyscale
      let grey = true;
      for (let i=0; i<data.length; i+=4) {
        if (data[i]!==data[i+1] || data[i]!==data[i+2]) { grey=false; break; }
      }

      const nChan = grey ? 1 : 3;
      const floats = new Float32Array(width*height*nChan);
      let minV=255, maxV=0;

      for (let i=0; i<width*height; i++) {
        const s=i*4;
        if (nChan===1) {
          const v = data[s]/255;
          floats[i] = v;
          if (data[s]<minV) minV=data[s];
          if (data[s]>maxV) maxV=data[s];
        } else {
          floats[i*3]   = data[s]/255;
          floats[i*3+1] = data[s+1]/255;
          floats[i*3+2] = data[s+2]/255;
          const lum = data[s]*0.299+data[s+1]*0.587+data[s+2]*0.114;
          if (lum<minV) minV=lum;
          if (lum>maxV) maxV=lum;
        }
      }

      resolve({ width, height, numChannels:nChan, bpp:8,
                data:floats, minValue:minV, maxValue:maxV });
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// EXIF PARSER (minimal inline JPEG EXIF reader, no dependencies)
// ══════════════════════════════════════════════════════════════════════════════

async function extractExif(url) {
  try {
    const resp = await fetch(url);
    const buf  = await resp.arrayBuffer();
    const view = new DataView(buf);

    // Must be JPEG (FFD8)
    if (view.getUint16(0) !== 0xFFD8) return null;

    let offset = 2;
    while (offset < view.byteLength - 2) {
      const marker = view.getUint16(offset);
      if (marker === 0xFFE1) { // APP1 — EXIF
        const len = view.getUint16(offset+2);
        // "Exif\0\0"
        if (view.getUint32(offset+4)===0x45786966 && view.getUint16(offset+8)===0) {
          return parseExifIFD(view, offset+10, len-8);
        }
      }
      if (marker === 0xFFDA) break; // Start of scan — no more metadata
      const len = view.getUint16(offset+2);
      offset += 2 + len;
    }
    return null;
  } catch { return null; }
}

function parseExifIFD(view, exifStart, maxLen) {
  // TIFF header
  const littleEndian = view.getUint16(exifStart) === 0x4949;
  const rd16 = (o) => view.getUint16(exifStart+o, littleEndian);
  const rd32 = (o) => view.getUint32(exifStart+o, littleEndian);
  const rdStr = (o, len) => {
    let s="";
    for (let i=0;i<len&&(exifStart+o+i)<view.byteLength;i++){
      const c=view.getUint8(exifStart+o+i);
      if(c===0)break; s+=String.fromCharCode(c);
    }
    return s.trim();
  };
  const rdRat = (o) => {
    const num=rd32(o), den=rd32(o+4);
    return den ? num/den : 0;
  };

  if (rd16(4) !== 42) return null; // TIFF magic
  const ifd0 = rd32(6);

  const tags0 = readIFD(view, exifStart, ifd0, littleEndian);
  const exifOffset = tags0[0x8769]; // ExifIFD pointer

  const result = {};
  const makeParts = [];
  if (tags0[0x010F]) makeParts.push(rdStr(tags0[0x010F], 64));
  if (tags0[0x0110]) makeParts.push(rdStr(tags0[0x0110], 64));
  if (makeParts.length) result.make = makeParts.join(" ");
  if (tags0[0x0131]) result.firmware = rdStr(tags0[0x0131], 64);

  if (exifOffset) {
    const tagsE = readIFD(view, exifStart, exifOffset, littleEndian);
    // ISO
    if (tagsE[0x8827]) result.iso = rd16(tagsE[0x8827]);
    // Aperture (FNumber rational)
    if (tagsE[0x829D]) result.aperture = rdRat(tagsE[0x829D]);
    // Shutter (ExposureTime rational → ms)
    if (tagsE[0x829A]) result.shutterMs = rdRat(tagsE[0x829A]) * 1000;
    // Date
    if (tagsE[0x9003]) {
      let d = rdStr(tagsE[0x9003], 20);
      d = d.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
      result.date = d;
    }
    // EV
    if (result.aperture && result.shutterMs && result.iso) {
      const s = result.shutterMs/1000;
      result.ev = Math.log2(result.aperture**2/s) + Math.log2(result.iso/100);
    }
  }

  return Object.keys(result).length ? result : null;
}

function readIFD(view, exifStart, ifdOffset, le) {
  const tags = {};
  const count = view.getUint16(exifStart+ifdOffset, le);
  for (let i=0; i<count; i++) {
    const base = exifStart+ifdOffset+2+i*12;
    if (base+12 > view.byteLength) break;
    const tag    = view.getUint16(base,   le);
    const type   = view.getUint16(base+2, le);
    const count2 = view.getUint32(base+4, le);
    const valOff = base+8;

    // For strings and rationals, store offset; for shorts store value directly
    if (type===2) { // ASCII
      const off = count2>4 ? view.getUint32(valOff, le) : (valOff-exifStart);
      tags[tag] = off;
    } else if (type===5 || type===10) { // Rational / SRational
      tags[tag] = view.getUint32(valOff, le); // offset to rational
    } else if (type===3) { // SHORT
      tags[tag] = view.getUint16(valOff, le);
    } else if (type===4) { // LONG
      tags[tag] = view.getUint32(valOff, le);
    }
  }
  return tags;
}

// ══════════════════════════════════════════════════════════════════════════════
// WHITE BALANCE (ported from ImageData.cpp — non-destructive via uniforms)
// ══════════════════════════════════════════════════════════════════════════════

function computeWBColor(img, x1,y1,x2,y2) {
  const { width, data } = img;
  const rX=Math.floor(Math.max(0,Math.min(x1,x2)));
  const rY=Math.floor(Math.max(0,Math.min(y1,y2)));
  const rW=Math.floor(Math.abs(x2-x1));
  const rH=Math.floor(Math.abs(y2-y1));
  if (rW<1||rH<1) return S.wbColor;
  const avg=[0,0,0]; let qty=0;
  for (let r=0;r<rH;r++) for (let c=0;c<rW;c++) {
    const i=((rY+r)*width+(rX+c))*3;
    avg[0]+=data[i]*255; avg[1]+=data[i+1]*255; avg[2]+=data[i+2]*255; qty++;
  }
  if (!qty) return S.wbColor;
  avg[0]/=qty; avg[1]/=qty; avg[2]/=qty;
  const goal=(avg[0]+avg[1]+avg[2])/3;
  if (!goal) return S.wbColor;
  return [
    goal/Math.max(avg[0],1e-9),
    goal/Math.max(avg[1],1e-9),
    goal/Math.max(avg[2],1e-9),
  ];
}

function computeWBGrey(img, x1,y1,x2,y2) {
  const { width, data } = img;
  const rX=Math.floor(Math.max(0,Math.min(x1,x2)));
  const rY=Math.floor(Math.max(0,Math.min(y1,y2)));
  const rW=Math.floor(Math.abs(x2-x1));
  const rH=Math.floor(Math.abs(y2-y1));
  if (rW<2||rH<2) return S.wbGrey;
  const avg=[[0,0],[0,0]], qty=[[0,0],[0,0]];
  for (let r=0;r<rH;r++) for (let c=0;c<rW;c++) {
    const col=rX+c, row=rY+r;
    avg[col%2][row%2]+=data[row*width+col]*255;
    qty[col%2][row%2]++;
  }
  for (let c=0;c<2;c++) for (let r=0;r<2;r++)
    if(qty[c][r]) avg[c][r]/=qty[c][r];
  const goal=(avg[0][0]+avg[1][0]+avg[0][1]+avg[1][1])/4;
  if (!goal) return S.wbGrey;
  return [
    goal/Math.max(avg[0][0],1e-9),
    goal/Math.max(avg[1][0],1e-9),
    goal/Math.max(avg[0][1],1e-9),
    goal/Math.max(avg[1][1],1e-9),
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// OVERLAY DRAWING (ported from ImageWindow.cpp draw* methods)
// ══════════════════════════════════════════════════════════════════════════════

const FONT = '11px "Courier New",monospace';
const PAD=20, MAR=5;

function imgToView(ix, iy) {
  return [ix*S.zoomFactor+S.panX, iy*S.zoomFactor+S.panY];
}
function viewToImg(vx, vy) {
  return [(vx-S.panX)/S.zoomFactor, (vy-S.panY)/S.zoomFactor];
}

function drawAll(ctx, ow, oh) {
  ctx.clearRect(0,0,ow,oh);
  ctx.font = FONT;
  if (S.showRulers)   drawRulers(ctx, ow, oh);
  if (S.showColorbar) drawColorbar(ctx, ow, oh);
  drawROI(ctx);
  if (S.showInfo)     drawInfoBox(ctx, ow, oh);
  if (S.showCursor)   drawCursorBox(ctx, ow, oh);
  if (S.showHelp)     drawHelp(ctx, ow, oh);
}

function lh(ctx) {
  const m=ctx.measureText("M");
  return (m.actualBoundingBoxAscent||8)+(m.actualBoundingBoxDescent||2)+2;
}

function tw(ctx, s) { return ctx.measureText(s).width; }

function blackBox(ctx, x,y,w,h) {
  ctx.fillStyle="rgba(0,0,0,0.85)"; ctx.fillRect(x,y,w,h);
}

// ── Info box ──────────────────────────────────────────────────────────────────
function drawInfoBox(ctx, ow, oh) {
  if (!S.image) return;
  const img=S.image, lineH=lh(ctx);
  const lines=[];

  const name=S.imageUrl.split("/").pop()||S.imageUrl;
  lines.push(name);

  const rot=["","  90°","  180°","  270°"][S.rotation];
  const fl=S.flipH&&S.flipV?" H+V flip":S.flipH?" H flip":S.flipV?" V flip":"";
  lines.push(`W=${img.width} H=${img.height}  ${S.zoomFactor.toFixed(2)}×${rot}${fl}`);

  if (S.exif) {
    const e=S.exif;
    if (e.iso!=null&&e.shutterMs!=null)
      lines.push(`ISO ${e.iso}  ${e.shutterMs.toFixed(2)} ms${e.aperture!=null?`  f/${e.aperture.toFixed(1)}`:""}${e.ev!=null?`  EV ${e.ev.toFixed(2)}`:""}`);
    if (e.date) lines.push(`${e.date}${e.make?" — "+e.make:""}`);
  }

  // Cursor info
  const [ix,iy]=viewToImg(S.cursorX,S.cursorY);
  const dispW=(S.rotation===1||S.rotation===3)?img.height:img.width;
  const dispH=(S.rotation===1||S.rotation===3)?img.width:img.height;
  let curX=ix+(S.zeroIdx?0:1)-0.5;
  let curY=iy+(S.zeroIdx?0:1)-0.5;
  if(S.yFlip) curY=dispH-curY;
  const rX=curX-(S.zeroIdx?0:1)-dispW/2+0.5;
  const rY=curY-(S.zeroIdx?0:1)-dispH/2+0.5;
  const R=Math.sqrt(rX*rX+rY*rY);
  const theta=Math.atan2(rY,rX)*180/Math.PI;
  let line5=`X=${curX.toFixed(1)} Y=${curY.toFixed(1)}  R=${R.toFixed(1)} θ=${theta.toFixed(1)}°`;

  const px=Math.floor(ix), py=Math.floor(iy);
  if(px>=0&&px<img.width&&py>=0&&py<img.height) {
    const maxV=(1<<img.bpp)-1;
    if(img.numChannels===1) {
      line5+=`  → ${Math.round(img.data[py*img.width+px]*maxV)}`;
    } else {
      const i=(py*img.width+px)*3;
      const rv=Math.round(img.data[i]*maxV);
      const gv=Math.round(img.data[i+1]*maxV);
      const bv=Math.round(img.data[i+2]*maxV);
      const R2=(S.channels&CHAN_R)?String(rv):"OFF";
      const G2=(S.channels&CHAN_G)?String(gv):"OFF";
      const B2=(S.channels&CHAN_B)?String(bv):"OFF";
      line5+=`  → ${R2}, ${G2}, ${B2}`;
    }
  }
  lines.push(line5);

  const maxW=Math.max(...lines.map(l=>tw(ctx,l)));
  const bw=maxW+MAR*2, bh=lineH*lines.length+MAR*2;
  const bx=ow-PAD-bw, by=PAD;
  blackBox(ctx,bx,by,bw,bh);
  ctx.fillStyle="#fff";
  lines.forEach((l,i)=>{
    ctx.fillText(l, bx+bw-tw(ctx,l)-MAR, by+MAR+lineH*(i+1)-2);
  });
}

// ── Cursor box ────────────────────────────────────────────────────────────────
function drawCursorBox(ctx, ow, oh) {
  if (!S.image) return;
  const [ix,iy]=viewToImg(S.cursorX,S.cursorY);
  const lineH=lh(ctx);
  const l1=`X = ${(ix+(S.zeroIdx?0:1)-0.5).toFixed(1)}, Y = ${(iy+(S.zeroIdx?0:1)-0.5).toFixed(1)}`;
  const l2="";
  const bw=tw(ctx,l1)+MAR*2, bh=lineH*2+MAR*2;
  let bx=S.cursorX-ow/2*0+14, by=S.cursorY+14; // relative to viewport
  bx=Math.max(0,Math.min(ow-bw,bx));
  by=Math.max(0,Math.min(oh-bh,by));
  blackBox(ctx,bx,by,bw,bh);
  ctx.fillStyle="#fff";
  ctx.fillText(l1, bx+MAR, by+MAR+lineH);
}

// ── Rulers ────────────────────────────────────────────────────────────────────
function drawRulers(ctx, ow, oh) {
  if (!S.image) return;
  const img=S.image;
  const TICK=12, CORNER=28, MIN_SPACE=80;
  const lineH=lh(ctx);

  const dispW=(S.rotation===1||S.rotation===3)?img.height:img.width;
  const dispH=(S.rotation===1||S.rotation===3)?img.width:img.height;

  // Horizontal
  let xImg=0.5;
  while(true) {
    let [xDraw]=imgToView(xImg,0);
    while(xDraw<CORNER) { const old=xDraw; while(xDraw===old){xImg+=1;[xDraw]=imgToView(xImg,0);} }
    if(xDraw>ow-CORNER||xImg>dispW) break;

    ctx.lineWidth=3; ctx.strokeStyle="#000";
    ctx.beginPath();ctx.moveTo(xDraw,0);ctx.lineTo(xDraw,TICK);ctx.stroke();
    ctx.beginPath();ctx.moveTo(xDraw,oh);ctx.lineTo(xDraw,oh-TICK);ctx.stroke();
    ctx.lineWidth=1; ctx.strokeStyle="#fff";
    ctx.beginPath();ctx.moveTo(xDraw,0);ctx.lineTo(xDraw,TICK);ctx.stroke();
    ctx.beginPath();ctx.moveTo(xDraw,oh);ctx.lineTo(xDraw,oh-TICK);ctx.stroke();

    const label=String(Math.floor(xImg)+(S.zeroIdx?0:1));
    const lw2=tw(ctx,label);
    ctx.fillStyle="#000"; ctx.fillRect(xDraw+2,TICK-lineH+2,lw2+2,lineH);
    ctx.fillRect(xDraw+2,oh-TICK-1,lw2+2,lineH);
    ctx.fillStyle="#fff";
    ctx.fillText(label,xDraw+3,TICK);
    ctx.fillText(label,xDraw+3,oh-TICK+lineH-2);

    const oldX=xImg;
    xImg=Math.floor(viewToImg(xDraw+MIN_SPACE,0)[0])+0.5;
    if(xImg<=oldX) xImg=oldX+1;
    if(xImg>dispW) break;
  }

  // Vertical
  let yImg=0.5;
  while(true) {
    let [,yDraw]=imgToView(0,yImg);
    while(yDraw<CORNER) { const old=yDraw; while(yDraw===old){yImg+=1;[,yDraw]=imgToView(0,yImg);} }
    if(yDraw>oh-CORNER||yImg>dispH) break;

    ctx.lineWidth=3; ctx.strokeStyle="#000";
    ctx.beginPath();ctx.moveTo(0,yDraw);ctx.lineTo(TICK,yDraw);ctx.stroke();
    ctx.beginPath();ctx.moveTo(ow,yDraw);ctx.lineTo(ow-TICK,yDraw);ctx.stroke();
    ctx.lineWidth=1; ctx.strokeStyle="#fff";
    ctx.beginPath();ctx.moveTo(0,yDraw);ctx.lineTo(TICK,yDraw);ctx.stroke();
    ctx.beginPath();ctx.moveTo(ow,yDraw);ctx.lineTo(ow-TICK,yDraw);ctx.stroke();

    let yCoord=Math.floor(yImg)+(S.zeroIdx?0:1);
    if(S.yFlip) yCoord=dispH-Math.floor(yImg);
    const label=String(yCoord);
    const lw2=tw(ctx,label);
    ctx.fillStyle="#000"; ctx.fillRect(1,yDraw+2,lw2+2,lineH); ctx.fillRect(ow-lw2-2,yDraw+2,lw2+2,lineH);
    ctx.fillStyle="#fff"; ctx.fillText(label,2,yDraw+2+lineH-2); ctx.fillText(label,ow-lw2-1,yDraw+2+lineH-2);

    const oldY=yImg;
    yImg=Math.floor(viewToImg(0,yDraw+MIN_SPACE)[1])+0.5;
    if(yImg<=oldY) yImg=oldY+1;
    if(yImg>dispH) break;
  }
}

// ── Colorbar ──────────────────────────────────────────────────────────────────
function drawColorbar(ctx, ow, oh) {
  if (!S.image) return;
  const lineH=lh(ctx);
  const BAR_W=256, BAR_H=10;

  let title=PALETTE_NAMES[S.palette];
  const ds=S.dipFactor.toFixed(3);
  if(S.imgFn===ImgFn.Log10Darken)  title+=` log darken (${ds})`;
  if(S.imgFn===ImgFn.Log10Brighten)title+=` log brighten (${ds})`;
  if(S.imgFn===ImgFn.Darken)       title+=` parabolic darken (${ds})`;
  if(S.imgFn===ImgFn.Brighten)     title+=` parabolic brighten (${ds})`;
  if(S.scaling===Scaling.Fit)      title+=" fit";

  const minTxt=S.scaleMin.toFixed(1), maxTxt=S.scaleMax.toFixed(1);
  const bw=BAR_W+MAR*2, bh=BAR_H+lineH+5+MAR*2;
  const bx=ow-PAD-bw, by=oh-PAD-bh;

  blackBox(ctx,bx,by,bw,bh);

  // Draw bar from LUT
  for(let x=0;x<BAR_W;x++){
    const i=(S.palette*256+Math.round(x/BAR_W*255))*4;
    ctx.fillStyle=`rgb(${LUT_DATA[i]},${LUT_DATA[i+1]},${LUT_DATA[i+2]})`;
    ctx.fillRect(bx+MAR+x, by+MAR+lineH+5, 1, BAR_H);
  }

  ctx.fillStyle="#fff";
  ctx.fillText(minTxt, bx+MAR, by+MAR+lineH);
  ctx.fillText(maxTxt, bx+bw-MAR-tw(ctx,maxTxt), by+MAR+lineH);
  ctx.fillText(title, bx+bw/2-tw(ctx,title)/2, by+MAR+lineH);
}

// ── ROI ───────────────────────────────────────────────────────────────────────
function drawROI(ctx) {
  if(!S.roi.valid) return;
  const [sx1,sy1]=imgToView(S.roi.x1,S.roi.y1);
  const [sx2,sy2]=imgToView(S.roi.x2,S.roi.y2);

  const stroke=(style,lw)=>{
    ctx.strokeStyle=style; ctx.lineWidth=lw;
    ctx.beginPath();ctx.moveTo(sx1,sy1);ctx.lineTo(sx2,sy2);ctx.stroke();
    ctx.strokeRect(Math.min(sx1,sx2),Math.min(sy1,sy2),Math.abs(sx2-sx1),Math.abs(sy2-sy1));
  };
  stroke("#000",3); stroke("#fff",1);

  const dx=Math.abs(S.roi.x2-S.roi.x1), dy=Math.abs(S.roi.y2-S.roi.y1);
  const diag=Math.sqrt(dx*dx+dy*dy), area=dx*dy;
  let label;
  if(S.unitPerPix===1)
    label=`dx=${Math.round(dx)} dy=${Math.round(dy)} → d=${diag.toFixed(1)} px  area=${Math.round(area)} px²`;
  else {
    const u=S.unitName;
    label=`dx=${Math.round(dx)} (${(dx*S.unitPerPix).toFixed(3)}) dy=${Math.round(dy)} (${(dy*S.unitPerPix).toFixed(3)}) → d=${diag.toFixed(1)} (${(diag*S.unitPerPix).toFixed(3)}) ${u}  area=${Math.round(area)} px²`;
  }
  const lw2=tw(ctx,label), lineH=lh(ctx);
  const cx=(sx1+sx2)/2-lw2/2, cy=(sy1+sy2)/2-lineH/2;
  blackBox(ctx,cx-2,cy-lineH,lw2+4,lineH+4);
  ctx.fillStyle="#fff"; ctx.fillText(label,cx,cy);
}

// ── Help ──────────────────────────────────────────────────────────────────────
const HELP_LINES=[
  "pxlpeep","",
  "── Mouse ──",
  "Left drag              pan",
  "Shift+Left drag     select ROI",
  "Wheel                  zoom",
  "","── Zoom ──",
  "Ctrl+1            zoom to fit",
  "Ctrl+2               zoom 1:1",
  "","── Palette ──",
  "V / Shift+V     cycle colormaps",
  "F / Shift+F     cycle functions",
  "= / -       dip factor ±",
  "S           toggle fit/user scale",
  "","── Channels ──",
  "R          toggle red  (Shift: solo)",
  "G          toggle green(Shift: solo)",
  "B          toggle blue (Shift: solo)",
  "","── White Balance ──",
  "W          WB from ROI (draw first)",
  "Shift+W    reset white balance",
  "","── Transform ──",
  "A / Shift+A   rotate CW / CCW",
  "L             flip horizontal",
  "T             flip vertical",
  "Y             flip Y origin",
  "0             zero/one indexing",
  "","── Overlays ──",
  "I    info box   Space cursor box",
  "C    colorbar   X     rulers",
  "","── Save ──",
  "Ctrl+S          save original",
  "Ctrl+Shift+S    save mapped",
  "Ctrl+Alt+S      save screenshot",
  "","Any key shows this help",
];

function drawHelp(ctx, ow, oh) {
  const lineH=lh(ctx);
  const maxW=Math.max(...HELP_LINES.map(l=>tw(ctx,l)));
  const bw=maxW+MAR*2, bh=lineH*HELP_LINES.length+MAR*2;
  const bx=ow-PAD-bw, by=PAD;
  blackBox(ctx,bx,by,bw,bh);
  ctx.fillStyle="#fff";
  HELP_LINES.forEach((l,i)=>ctx.fillText(l,bx+MAR,by+MAR+lineH*(i+1)-2));
}

// ══════════════════════════════════════════════════════════════════════════════
// KEYBOARD HANDLER (ported from ImageWindow::handleKeyPress)
// ══════════════════════════════════════════════════════════════════════════════

function onKeyDown(e) {
  if (e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
  const ctrl=e.ctrlKey||e.metaKey, shift=e.shiftKey, alt=e.altKey;
  let handled=true;

  switch(e.key) {
    case "1": if(ctrl){zoomToFit();} else handled=false; break;
    case "2": if(ctrl){zoomTo1to1();}else handled=false; break;

    case "v":case "V":
      S.palette=((S.palette+(shift?-1:1))%6+6)%6; break;

    case "f":case "F":
      S.imgFn=((S.imgFn+(shift?-1:1))%5+5)%5;
      recalcScale(); break;

    case "=":case "+":
      S.dipFactor*=1.25; recalcScale(); break;
    case "-":
      S.dipFactor/=1.25; recalcScale(); break;

    case "s":case "S":
      if(ctrl&&shift) {save("screenshot");break;}
      if(ctrl&&alt)   {save("mapped");    break;}
      if(ctrl)        {save("original");  break;}
      if(S.scaling===Scaling.Fit) {
        S.scaling=Scaling.User;
        S.userMin=0; S.userMax=S.image?(1<<S.image.bpp)-1:255;
      } else { S.scaling=Scaling.Fit; }
      recalcScale(); break;

    case "r":case "R":
      if(ctrl){handled=false;break;}
      S.channels=shift?CHAN_R:(S.channels^CHAN_R)||CHAN_R; break;
    case "g":case "G":
      S.channels=shift?CHAN_G:(S.channels^CHAN_G)||CHAN_G; break;
    case "b":case "B":
      S.channels=shift?CHAN_B:(S.channels^CHAN_B)||CHAN_B; break;

    case "a":case "A":
      S.rotation=((S.rotation+(shift?-1:1))%4+4)%4;
      S.roi.valid=false; break;
    case "l":case "L": S.flipH=!S.flipH; break;
    case "t":case "T": S.flipV=!S.flipV; break;

    case "i":case "I": S.showInfo=!S.showInfo; break;
    case " ":          S.showCursor=!S.showCursor; break;
    case "c":case "C":
      if(ctrl&&shift){save("screenshot");break;}
      if(ctrl&&alt)  {save("mapped");    break;}
      if(ctrl)       {save("original");  break;}
      S.showColorbar=!S.showColorbar; break;
    case "x":case "X": S.showRulers=!S.showRulers; break;

    case "y":case "Y": S.yFlip=!S.yFlip; break;
    case "0":          S.zeroIdx=!S.zeroIdx; break;

    case "w":case "W":
      if(ctrl){handled=false;break;}
      if(shift){S.wbColor=[1,1,1];S.wbGrey=[1,1,1,1];break;}
      if(S.roi.valid&&S.image){
        const roi=S.roi;
        if(S.image.numChannels===1)
          S.wbGrey=computeWBGrey(S.image,roi.x1,roi.y1,roi.x2,roi.y2);
        else
          S.wbColor=computeWBColor(S.image,roi.x1,roi.y1,roi.x2,roi.y2);
      }
      break;

    default:
      if(!ctrl&&!alt&&e.key.length===1) S.showHelp=true;
      handled=false; break;
  }

  if(handled){e.preventDefault();e.stopPropagation();refreshToolbar();}
  requestFrame();
}

function onKeyUp() {
  if(S.showHelp){S.showHelp=false;requestFrame();}
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVE
// ══════════════════════════════════════════════════════════════════════════════

function save(mode) {
  const name=S.imageUrl.split("/").pop()?.replace(/\.[^.]+$/,"")||"image";

  if(mode==="original") {
    const a=document.createElement("a");
    a.href=S.imageUrl; a.download=S.imageUrl.split("/").pop()||"image"; a.click();
    return;
  }

  // Composite: WebGL + overlay for screenshot
  const out=document.createElement("canvas");
  out.width=glCanvas.width; out.height=glCanvas.height;
  const ctx=out.getContext("2d");
  ctx.drawImage(glCanvas,0,0);
  if(mode==="screenshot") ctx.drawImage(ovCanvas,0,0);

  out.toBlob(blob=>{
    if(!blob)return;
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`${name}_${mode}_${Date.now()}.png`; a.click();
    URL.revokeObjectURL(url);
  },"image/png");
}

// ══════════════════════════════════════════════════════════════════════════════
// ZOOM / PAN
// ══════════════════════════════════════════════════════════════════════════════

function zoomToFit() {
  if(!S.image) return;
  const iw=(S.rotation===1||S.rotation===3)?S.image.height:S.image.width;
  const ih=(S.rotation===1||S.rotation===3)?S.image.width:S.image.height;
  const wL=Math.log(window.innerWidth /iw)/Math.log(ZOOM_STEP);
  const hL=Math.log(window.innerHeight/ih)/Math.log(ZOOM_STEP);
  S.zoomLevel=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,Math.floor(Math.min(wL,hL))));
  S.zoomFactor=Math.pow(ZOOM_STEP,S.zoomLevel);
  S.panX=(window.innerWidth -iw*S.zoomFactor)/2;
  S.panY=(window.innerHeight-ih*S.zoomFactor)/2;
  requestFrame();
}

function zoomTo1to1() {
  if(!S.image) return;
  S.zoomLevel=0; S.zoomFactor=1;
  S.panX=(window.innerWidth -S.image.width )/2;
  S.panY=(window.innerHeight-S.image.height)/2;
  requestFrame();
}

function zoomAt(delta, vx, vy) {
  const newLevel=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,S.zoomLevel+delta));
  if(newLevel===S.zoomLevel) return;
  const old=S.zoomFactor;
  S.zoomLevel=newLevel;
  S.zoomFactor=Math.pow(ZOOM_STEP,S.zoomLevel);
  // Keep image point under cursor fixed
  const ix=(vx-S.panX)/old, iy=(vy-S.panY)/old;
  S.panX=vx-ix*S.zoomFactor;
  S.panY=vy-iy*S.zoomFactor;
  requestFrame();
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOLBAR (plain DOM — no framework needed)
// ══════════════════════════════════════════════════════════════════════════════

function buildToolbar() {
  const tb = document.createElement("div");
  tb.id="pxlpeep-toolbar";
  Object.assign(tb.style,{
    position:"fixed",top:"8px",left:"8px",zIndex:"2147483647",
    background:"rgba(20,20,20,0.93)",border:"1px solid #444",
    borderRadius:"8px",padding:"8px 10px",display:"flex",
    flexDirection:"column",gap:"5px",fontFamily:"monospace",
    fontSize:"11px",color:"#eee",userSelect:"none",minWidth:"220px",
  });

  const row=(...children)=>{
    const d=document.createElement("div");
    Object.assign(d.style,{display:"flex",gap:"4px",alignItems:"center",flexWrap:"wrap"});
    children.forEach(c=>d.appendChild(c));
    return d;
  };

  const lbl=(text,w="52px")=>{
    const s=document.createElement("span");
    s.textContent=text; Object.assign(s.style,{color:"#888",minWidth:w}); return s;
  };

  const btn=(text,title,onclick,style={})=>{
    const b=document.createElement("button");
    b.textContent=text; b.title=title||"";
    Object.assign(b.style,{
      padding:"2px 6px",borderRadius:"4px",cursor:"pointer",
      fontSize:"11px",fontFamily:"monospace",border:"1px solid #555",
      background:"#333",color:"#ddd",...style,
    });
    b.addEventListener("click",onclick);
    b.addEventListener("mouseenter",()=>b.style.background="#555");
    b.addEventListener("mouseleave",()=>b.style.background=b._active?"#fff":"#333");
    b._setActive=(v)=>{
      b._active=v;
      b.style.background=v?"#eee":"#333";
      b.style.color=v?"#000":"#ddd";
    };
    return b;
  };

  const cycleBtn=(label,getVal,getNames,onChange)=>{
    const b=document.createElement("button");
    Object.assign(b.style,{
      flex:"1",padding:"2px 6px",borderRadius:"4px",cursor:"pointer",
      fontSize:"11px",fontFamily:"monospace",border:"1px solid #555",
      background:"#333",color:"#ddd",textAlign:"center",
    });
    b.addEventListener("click",e=>{
      const dir=e.shiftKey?-1:1;
      onChange(dir); refresh();
    });
    b._refresh=()=>{ b.textContent=getNames()[getVal()]; };
    return b;
  };

  // ── Header ──
  const header=document.createElement("div");
  Object.assign(header.style,{display:"flex",justifyContent:"space-between",alignItems:"center"});
  const title=document.createElement("span");
  title.textContent="pxlpeep"; title.style.fontWeight="bold"; title.style.color="#aaa";
  const collapseBtn=btn("▲","Collapse",()=>{
    tb.style.display="none";
    floatBtn.style.display="block";
  });
  header.appendChild(title); header.appendChild(collapseBtn);
  tb.appendChild(header);

  // ── Zoom ──
  const zoomInfo=document.createElement("span");
  zoomInfo.style.color="#aaa";
  const zoomRow=row(
    lbl("zoom"),
    btn("fit","Zoom to fit",()=>{zoomToFit();refresh();}),
    btn("1:1","Zoom 1:1",()=>{zoomTo1to1();refresh();}),
    zoomInfo
  );
  tb.appendChild(zoomRow);

  // ── Palette ──
  const palBtn=cycleBtn("palette",()=>S.palette,()=>PALETTE_NAMES,dir=>{
    S.palette=((S.palette+dir)%6+6)%6;
  });
  tb.appendChild(row(lbl("palette"),palBtn));
  tb.appendChild(document.createElement("div")).style.cssText="font-size:9px;color:#666;padding-left:52px";

  // ── Function ──
  const fnBtn=cycleBtn("fn",()=>S.imgFn,()=>FN_NAMES,dir=>{
    S.imgFn=((S.imgFn+dir)%5+5)%5; recalcScale();
  });
  tb.appendChild(row(lbl("fn"),fnBtn));

  // ── Dip factor ──
  const dipVal=document.createElement("span");
  dipVal.style.cssText="flex:1;text-align:center;";
  const dipRow=row(
    lbl("dip"),
    btn("−","",()=>{S.dipFactor/=1.25;recalcScale();refresh();}),
    dipVal,
    btn("+","",()=>{S.dipFactor*=1.25;recalcScale();refresh();}),
  );
  tb.appendChild(dipRow);

  // ── Scale ──
  const scaleInfo=document.createElement("span");
  scaleInfo.style.cssText="font-size:10px;color:#888;";
  const scaleBtn=btn("","Toggle fit/user",()=>{
    if(S.scaling===Scaling.Fit){S.scaling=Scaling.User;S.userMin=0;S.userMax=S.image?(1<<S.image.bpp)-1:255;}
    else S.scaling=Scaling.Fit;
    recalcScale(); refresh();
  });
  tb.appendChild(row(lbl("scale"),scaleBtn,scaleInfo));

  // ── Channels ──
  const chR=btn("R","Toggle red (Shift: solo)",e=>{
    S.channels=e.shiftKey?CHAN_R:(S.channels^CHAN_R)||CHAN_R; requestFrame(); refresh();
  },{color:"#f88"});
  const chG=btn("G","Toggle green (Shift: solo)",e=>{
    S.channels=e.shiftKey?CHAN_G:(S.channels^CHAN_G)||CHAN_G; requestFrame(); refresh();
  },{color:"#8f8"});
  const chB=btn("B","Toggle blue (Shift: solo)",e=>{
    S.channels=e.shiftKey?CHAN_B:(S.channels^CHAN_B)||CHAN_B; requestFrame(); refresh();
  },{color:"#88f"});
  const chRow=row(lbl("ch"),chR,chG,chB);
  tb.appendChild(chRow);

  // ── Rotate/flip ──
  tb.appendChild(row(
    lbl("rotate"),
    btn("↺ CCW","Rotate CCW",()=>{S.rotation=((S.rotation-1)%4+4)%4;S.roi.valid=false;requestFrame();refresh();}),
    btn("↻ CW", "Rotate CW", ()=>{S.rotation=(S.rotation+1)%4;          S.roi.valid=false;requestFrame();refresh();}),
  ));
  const flipH2=btn("⇄H","Flip horizontal",()=>{S.flipH=!S.flipH;requestFrame();refresh();});
  const flipV2=btn("⇅V","Flip vertical",  ()=>{S.flipV=!S.flipV;requestFrame();refresh();});
  tb.appendChild(row(lbl("flip"),flipH2,flipV2));

  // ── WB ──
  tb.appendChild(row(
    lbl("WB"),
    btn("from ROI","Apply WB from selection (draw ROI first)",()=>{
      if(S.roi.valid&&S.image){
        if(S.image.numChannels===1) S.wbGrey=computeWBGrey(S.image,S.roi.x1,S.roi.y1,S.roi.x2,S.roi.y2);
        else S.wbColor=computeWBColor(S.image,S.roi.x1,S.roi.y1,S.roi.x2,S.roi.y2);
        requestFrame();
      }
    }),
    btn("reset","Reset white balance",()=>{S.wbColor=[1,1,1];S.wbGrey=[1,1,1,1];requestFrame();}),
  ));

  // ── Overlays ──
  const togInfo=btn("info","Toggle info box",()=>{S.showInfo=!S.showInfo;requestFrame();refresh();});
  const togRul =btn("rulers","Toggle rulers",()=>{S.showRulers=!S.showRulers;requestFrame();refresh();});
  const togCbar=btn("colorbar","Toggle colorbar",()=>{S.showColorbar=!S.showColorbar;requestFrame();refresh();});
  const togCur =btn("cursor","Toggle cursor box",()=>{S.showCursor=!S.showCursor;requestFrame();refresh();});
  tb.appendChild(row(lbl("show"),togInfo,togRul,togCbar,togCur));

  // ── EXIF ──
  const exifDiv=document.createElement("div");
  Object.assign(exifDiv.style,{fontSize:"10px",color:"#888",borderTop:"1px solid #333",paddingTop:"4px"});
  tb.appendChild(exifDiv);

  // ── Save ──
  const saveRow=document.createElement("div");
  Object.assign(saveRow.style,{display:"flex",gap:"4px",flexWrap:"wrap",borderTop:"1px solid #333",paddingTop:"4px"});
  saveRow.appendChild(btn("💾 original","Save original image",()=>save("original")));
  saveRow.appendChild(btn("💾 mapped","Save with palette applied",()=>save("mapped")));
  saveRow.appendChild(btn("📷 screenshot","Save screenshot",()=>save("screenshot")));
  tb.appendChild(saveRow);

  // ── Float button (collapsed state) ──
  const floatBtn=document.createElement("button");
  floatBtn.textContent="▼ pxlpeep";
  Object.assign(floatBtn.style,{
    position:"fixed",top:"8px",left:"8px",zIndex:"2147483647",
    background:"rgba(20,20,20,0.93)",color:"#eee",border:"1px solid #444",
    borderRadius:"6px",padding:"4px 8px",cursor:"pointer",fontFamily:"monospace",
    fontSize:"11px",display:"none",
  });
  floatBtn.addEventListener("click",()=>{
    tb.style.display="flex"; floatBtn.style.display="none";
  });

  const refresh=()=>{
    zoomInfo.textContent=S.zoomFactor.toFixed(2)+"×";
    palBtn._refresh(); fnBtn._refresh();
    dipVal.textContent=S.dipFactor.toFixed(3);
    scaleBtn.textContent=S.scaling===Scaling.Fit?"fit":"user";
    scaleInfo.textContent=`${S.scaleMin.toFixed(0)}–${S.scaleMax.toFixed(0)}`;
    chR._setActive(!!(S.channels&CHAN_R));
    chG._setActive(!!(S.channels&CHAN_G));
    chB._setActive(!!(S.channels&CHAN_B));
    flipH2._setActive(S.flipH); flipV2._setActive(S.flipV);
    togInfo._setActive(S.showInfo); togRul._setActive(S.showRulers);
    togCbar._setActive(S.showColorbar); togCur._setActive(S.showCursor);
    if(S.exif){
      const e=S.exif; let html="";
      if(e.make) html+=`<div>${e.make}</div>`;
      if(e.date) html+=`<div>${e.date}</div>`;
      if(e.iso!=null){
        html+=`<div>ISO ${e.iso}`;
        if(e.shutterMs!=null) html+=`  ${e.shutterMs.toFixed(1)} ms`;
        if(e.aperture!=null)  html+=`  f/${e.aperture.toFixed(1)}`;
        if(e.ev!=null)        html+=`  EV ${e.ev.toFixed(2)}`;
        html+="</div>";
      }
      exifDiv.innerHTML=html;
    }
    requestFrame();
  };

  document.body.appendChild(tb);
  document.body.appendChild(floatBtn);
  return refresh;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN — PAGE TAKEOVER + EVENT WIRING
// ══════════════════════════════════════════════════════════════════════════════

// Suppress native image display
document.body.style.margin="0";
document.body.style.background="#1a1a1a";
document.body.style.overflow="hidden";
const nativeImg=document.querySelector("img");
if(nativeImg) nativeImg.style.display="none";

// Create canvases
const glCanvas=document.createElement("canvas");
const ovCanvas=document.createElement("canvas");
let renderer;

function sizeCanvases() {
  const w=window.innerWidth, h=window.innerHeight;
  glCanvas.width=w; glCanvas.height=h;
  ovCanvas.width=w; ovCanvas.height=h;
  renderer?.resize(w,h);
}

[glCanvas,ovCanvas].forEach((c,i)=>{
  Object.assign(c.style,{
    position:"fixed",top:"0",left:"0",
    width:"100vw",height:"100vh",
    zIndex:String(2147483640+i),
    display:"block",
  });
  document.body.appendChild(c);
});

ovCanvas.style.cursor="crosshair";

sizeCanvases();

// WebGL renderer
try {
  renderer=new Renderer(glCanvas);
} catch(e) {
  const msg=document.createElement("div");
  msg.textContent="pxlpeep: WebGL2 not available. "+e.message;
  Object.assign(msg.style,{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
    color:"#fff",background:"#300",padding:"20px",borderRadius:"8px",fontFamily:"monospace"});
  document.body.appendChild(msg);
}

// Overlay context
const ovCtx=ovCanvas.getContext("2d");

// Render loop
let rafPending=false;
function requestFrame() {
  if(rafPending) return;
  rafPending=true;
  requestAnimationFrame(()=>{
    rafPending=false;
    renderer?.draw();
    drawAll(ovCtx, ovCanvas.width, ovCanvas.height);
  });
}

// Load image
const refreshToolbar=buildToolbar();

loadImage(S.imageUrl).then(img=>{
  S.image=img;
  S.userMin=0; S.userMax=(1<<img.bpp)-1;
  recalcScale();
  renderer?.upload(img.data, img.width, img.height, img.numChannels);
  zoomToFit();
  refreshToolbar();
  requestFrame();
});

// EXIF async
extractExif(S.imageUrl).then(exif=>{
  if(exif){S.exif=exif; refreshToolbar();}
});

// ── Mouse events ──────────────────────────────────────────────────────────────
let panDrag=null, roiDrag=null, wheelAcc=0;

ovCanvas.addEventListener("mousedown",e=>{
  if(e.button===0&&!e.shiftKey) {
    panDrag={sx:e.clientX,sy:e.clientY,px:S.panX,py:S.panY};
    ovCanvas.style.cursor="grabbing";
    e.preventDefault();
  } else if(e.button===0&&e.shiftKey) {
    const [ix,iy]=viewToImg(e.clientX,e.clientY);
    roiDrag={x:ix,y:iy};
    S.roi={x1:ix,y1:iy,x2:ix,y2:iy,valid:false};
    e.preventDefault();
  }
});

ovCanvas.addEventListener("mousemove",e=>{
  S.cursorX=e.clientX; S.cursorY=e.clientY;
  if(panDrag) {
    S.panX=panDrag.px+(e.clientX-panDrag.sx);
    S.panY=panDrag.py+(e.clientY-panDrag.sy);
  } else if(roiDrag) {
    const img=S.image;
    const [ix,iy]=viewToImg(e.clientX,e.clientY);
    const cx=Math.max(0,Math.min(img?.width??1e9, ix));
    const cy=Math.max(0,Math.min(img?.height??1e9,iy));
    const dx=Math.abs(cx-roiDrag.x), dy=Math.abs(cy-roiDrag.y);
    S.roi={x1:roiDrag.x,y1:roiDrag.y,x2:cx,y2:cy,valid:dx>=1&&dy>=1};
  }
  requestFrame();
});

ovCanvas.addEventListener("mouseup",()=>{
  panDrag=null; roiDrag=null;
  ovCanvas.style.cursor="crosshair";
});

ovCanvas.addEventListener("contextmenu",e=>e.preventDefault());

// Wheel (non-passive)
ovCanvas.addEventListener("wheel",e=>{
  e.preventDefault();
  wheelAcc+=e.deltaY;
  if(wheelAcc<-DELTA_THRESH){wheelAcc=0;zoomAt(+1,e.clientX,e.clientY);}
  else if(wheelAcc>DELTA_THRESH){wheelAcc=0;zoomAt(-1,e.clientX,e.clientY);}
},{passive:false});

// Keyboard
window.addEventListener("keydown",onKeyDown);
window.addEventListener("keyup",onKeyUp);

// Resize
window.addEventListener("resize",()=>{sizeCanvases();requestFrame();});

// Test hooks
window.__pxlpeep = { S, computeWBColor, computeWBGrey, recalcScale, loadImage, zoomToFit, zoomTo1to1 };

// Initial frame
requestFrame();
