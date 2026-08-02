// pxlpeep content script — fully self-contained, no dependencies.
// Ported from pxlpeep C++ (Qt/FreeImage) by shaperilio.
// ─────────────────────────────────────────────────────────────────────────────

if (window.__pxlpeepActive) { throw new Error("pxlpeep: already active"); }
window.__pxlpeepActive = true;

// App version — CalVer YY.M.micro (e.g. 26.7.0; see CLAUDE.md). This is the runtime
// copy: the main-world injection has no chrome.runtime to read the manifest, so the
// version is baked in here and kept in lockstep with package.json by `npm run stamp`.
const PXLPEEP_VERSION = "26.7.0";

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS (ported from enums in ImageWindow.h / colormapper.h)
// ══════════════════════════════════════════════════════════════════════════════

const Scaling  = { Fit:0, Centered:1, User:2 };
const ImgFn    = { OneToOne:0, LogBrighten:1, LogDarken:2, ParabolicBrighten:3, ParabolicDarken:4 };
const Rotation = { Zero:0, CCW90:1, CCW180:2, CCW270:3 };
const Palette  = { Grey:0, GreyInv:1, GreySat:2, GreySatInv:3, ColorExp:4, CETL07:5, CETL07Inv:6 };
const CHAN_R   = 1, CHAN_G = 2, CHAN_B = 4;

const PALETTE_NAMES = ["Grey","Inv. grey","Grey+sat","Inv. grey+sat","Color expansion","CET-L07","Inv. CET-L07"];
const FN_NAMES      = ["1:1","log brighten","log darken","parabolic brighten","parabolic darken"];
const NUM_PALETTES  = PALETTE_NAMES.length;   // single source: LUT rows, shader row divisor, cycle modulo

// CET-L07 — Peter Kovesi's perceptually-uniform *linear* blue→magenta→white map (colorcet.com, CC0).
// Ends near white so all three channels rise → safe under the per-channel byte swap below.
// 256 RGB triples (R,G,B interleaved) packed base64; verified monotonic + evenly spaced in CIELAB L*.
const CETL07 = Uint8Array.from(atob(
  "AAJLAANNAANPAARRAARTAARVAAVYAAVaAAVcAAVeAAVgAAViAAVkAAVmAAVoAQVqAQVtAQVvAQVxAgVzAgV1AgV3AwV5AwV8AwV+BAWABAWCBAWEBAaHBQaJBQaLBQaNBQaQBgaSBgaUBgaWBgaZBgabBgadBgafBgaiBgekBQemBQepBQerBQetBQivBQiyBQi0BQi2BQm4Bgm6Bgq9Bwq/CArBCQvDCwvFDAzHDQzJDw3LEA3NEg7PEw7RFQ/TFg/VGBDWGRHYGxHaHRLcHhLeIBPfIhThJBTjJhXkKBXmKhbnLBbpLxfqMRfsNBjtNxjuORnvPBnwPxnyQhrzRRr0SBr1Sxv1TRv2UBv3Uxv4Vhv4WRz5XRz6YBz6Yxz6Zhz7aRz7bBz7bxz8chz8dRz8eBz8exz8fhz8gBz9gxz9hhz9iRz9ixz9jhz9kRz9kx39lh3+mR3+mx3+nh3+oB3+ox3+pR3+qB3+qh3+rR3+rx3+sR3+tB3+thz+uRz+uxz+vR3+wB3+wh3+xB3+xh7+yB7+yh/+zCD+ziH+0CL+0iP+1CT+1iX+1yb+2Sf+2yn+3Cr+3iz+4C3+4S7+4zD+5DL+5TP+5zX+6Df+6Tj+6zr+7Dz+7T7+7j/+70H+8EP+8UX+8kf+80n+9Ev+9U3+9k/+91H++FP++FX++Vf++ln++lv++13++1/+/GH+/GP+/GX+/Wf+/Wr+/Wz9/W79/nD9/nL9/nT9/nb9/nj9/nv9/n39/n/9/oH9/oP9/oX9/of9/oj9/or9/oz9/o79/pD9/pL9/pT9/pX9/pf9/pn9/pv9/pz9/p79/qD9/qL9/qP9/qX9/qf9/qj9/qr9/qz9/q39/q/9/rH+/rL+/rT+/rX+/rf+/rn+/rr+/rz+/r3+/r/+/sH+/sL+/8T+/8X+/8f+/8j+/8r+/8v+/83+/87+/9D+/9H+/9P+/9T+/9b+/9f+/9n+/9r+/9z+/93+/9/+/+D+/+L+/+P+/+X+/ub+/uj+/un+/uv+"
), c=>c.charCodeAt(0));

// Filesystem-safe short tokens for self-documenting "save mapped" filenames (the
// C++ used raw enum ints, "_s2_f0_m0_r0"; these say what they mean). Index by enum.
const SCALE_TAG   = ["fit","centered","user"];
const FN_TAG      = ["linear","logBright","logDark","parabBright","parabDark"];
const PALETTE_TAG = ["grey","greyInv","greySat","greySatInv","colorExp","cetL07","cetL07Inv"];
const ROT_DEG     = [0,90,180,270];

const ZOOM_STEP    = Math.SQRT2;
const MAX_ZOOM     = 16, MIN_ZOOM = -16;
const DELTA_THRESH = 100; // wheel accumulator threshold

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

const S = {
  // image
  image: null,          // { width, height, numChannels, bpp, data:Float32Array, minValue, maxValue }
  imageUrl: window.__pxlpeepImageUrl || location.href,
  // Human-readable source, for display + save names only (never for fetching). On
  // desktop this is the real file path (Rust injects __pxlpeepImagePath); imageUrl
  // there is an asset:// URL with the path percent-encoded, which must never reach
  // the UI or a filename.
  imagePath: window.__pxlpeepImagePath || window.__pxlpeepImageUrl || location.href,
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
  showRulers: true,
  showGrid: false,
  showColorbar: true,
  showHelp: false,

  // ROI (in image coordinates)
  // WB tool: persistent corner-snapped box (or null). wbPeek bypasses the correction
  // in the shader while Alt+W is held (a momentary "show original").
  wbBox: null,
  wbPeek: false,
  // Measure tool: center-snapped line segments {x1,y1,x2,y2}. Latched cursor boxes:
  // center-snapped points {ix,iy}. Both accumulate as stacks (Shift+key pops one).
  measures: [],
  latched: [],
  // Tool-scoped Esc: each group stamps _seq at its last placement; Esc clears the
  // group with the highest seq (the most-recently-used tool), one press per group.
  _seq: 0, wbSeq: 0, measSeq: 0, latSeq: 0,

  // save options
  forceJpeg: false,

  // coordinate system
  yFlip: false,
  zeroIdx: true,

  // unit calibration
  unitPerPix: 1,
  unitName: "units",
  calibrated: false,   // separate flag, not unitPerPix===1 (a real 1-unit/px calibration is valid)

  // cursor (viewport coords)
  cursorX: 0, cursorY: 0,
};

// ══════════════════════════════════════════════════════════════════════════════
// ENVIRONMENT SEAM
// ══════════════════════════════════════════════════════════════════════════════
// The one place the two shells differ. These are the browser defaults; the Tauri
// shell (content/desktop.js) sets window.__pxlpeepEnv to override individual keys —
// at minimum `isDesktop:true`, which switches on the desktop-only reload — and
// inherits every key it doesn't replace. Object.assign, not `||`, so the desktop
// can flip one flag without having to re-supply save/copyImage. Everything else in
// this file is shell-agnostic, so features get written once, here, not twice.
const env = Object.assign({
  isDesktop: false,
  // Save a Blob under a suggested filename (browser: trigger a download).
  save(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },
  // Copy an image Blob to the clipboard (browser: async Clipboard API, PNG only).
  copyImage(blob) {
    return navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  },
}, window.__pxlpeepEnv);

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
    case ImgFn.LogBrighten: {
      if (v > 0) { const r = Math.log10(v*dip*dip); return r > 0 ? r : 0; }
      return 0;
    }
    case ImgFn.LogDarken: {
      if (v > 0) { const r = Math.log10(v/Math.max(dip*dip,1e-9)); return r > 0 ? r : 0; }
      return 0;
    }
    case ImgFn.ParabolicBrighten: {
      const r = parabolicResponse(v, minV, maxV, dip);
      return Math.max(minV, Math.min(maxV, r));
    }
    case ImgFn.ParabolicDarken: {
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

// Recompute the image min/max over the WHITE-BALANCED values, so Fit-scale and the
// colorbar track a WB correction. WB is applied non-destructively as shader gains, so
// we fold the same gains in here: per-channel gains for color, per-Bayer-quad gains
// for grey (identity gains reproduce the raw per-channel range from load). Call after
// any WB change, then recalcScale().
function recomputeMinMax() {
  const img = S.image;
  if (!img) return;
  const { width, height, data, numChannels } = img;
  let minV = Infinity, maxV = -Infinity;
  if (numChannels === 1) {
    const g = S.wbGrey; // [g00,g10,g01,g11], indexed (x%2)+(y%2)*2 — matches the shader
    for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
      const v = data[y*width+x]*255*g[(x%2)+(y%2)*2];
      if (v<minV) minV=v; if (v>maxV) maxV=v;
    }
  } else {
    const gr=S.wbColor[0], gg=S.wbColor[1], gb=S.wbColor[2];
    for (let i=0; i<width*height; i++) {
      const s=i*3;
      const r=data[s]*255*gr, g=data[s+1]*255*gg, b=data[s+2]*255*gb;
      if (r<minV) minV=r; if (r>maxV) maxV=r;
      if (g<minV) minV=g; if (g>maxV) maxV=g;
      if (b<minV) minV=b; if (b>maxV) maxV=b;
    }
  }
  img.minValue = minV; img.maxValue = maxV;
}

// ══════════════════════════════════════════════════════════════════════════════
// LUT (ported from colormapper.h)
// ══════════════════════════════════════════════════════════════════════════════

function buildLUT() {
  // 256 × NUM_PALETTES RGBA8 packed into a flat Uint8Array (row = palette)
  const NUM_PAL = NUM_PALETTES, SIZE = 256;
  const data = new Uint8Array(SIZE * NUM_PAL * 4);

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
          // simpleExpansion: B=i, G=0, R=0  (matches C++ which gives blue-only for values 0-255)
          data[base]=0; data[base+1]=0; data[base+2]=i; data[base+3]=255; break;
        case Palette.CETL07:
          data[base]=CETL07[i*3]; data[base+1]=CETL07[i*3+1]; data[base+2]=CETL07[i*3+2]; data[base+3]=255; break;
        case Palette.CETL07Inv: { const j=(255-i)*3;   // reversed LUT, same trick as Inv. grey
          data[base]=CETL07[j]; data[base+1]=CETL07[j+1]; data[base+2]=CETL07[j+2]; data[base+3]=255; break;
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
  return texture(uLUT,vec2(t,(float(uPal)+.5)/${NUM_PALETTES}.));
}

vec4 satWarn(float v){
  if(v<=0.)  return vec4(0,0,1,1);
  if(v<13.)  return vec4(.5,.5,1,1);
  if(v>=255.)return vec4(1,0,0,1);
  if(v>242.) return vec4(1,.5,.5,1);
  float g=v/255.; return vec4(g,g,g,1);
}

// C++ simpleExpansion with maxDisp=16777215: maps [0,255] to 24-bit then extracts R/G/B.
// For 8-bit images this produces grey (val*0x10101 has R=G=B=val).
vec4 colorExpand(float mapped){
  float t=clamp(mapped/255.,0.,1.);
  float v24=floor(t*16777215.+.5);
  return vec4(floor(v24/65536.)/255.,
              floor(mod(v24,65536.)/256.)/255.,
              mod(v24,256.)/255.,1.);
}

void main(){
  vec2 fragPx=vec2(vUV.x,(1.-vUV.y))*uVP;
  vec2 dispSz=(uRot==1||uRot==3)?uSz.yx:uSz.xy;
  vec2 dispUV=(fragPx-uPan)/(uZoom*dispSz);
  if(dispUV.x<0.||dispUV.x>1.||dispUV.y<0.||dispUV.y>1.){fragColor=vec4(0.,0.50196078,0.,1.);return;}// non-image bg = Qt::darkGreen (#008000), from the C++ pxlpeep
  vec2 uv=xform(dispUV);
  vec4 tx=texture(uImg,uv);
  vec2 pc=uv*uSz;

  if(uNChan==1){
    int cx=int(mod(pc.x,2.)),cy=int(mod(pc.y,2.));
    float wb= cx==0&&cy==0?uWBG.x: cx==1&&cy==0?uWBG.y: cx==0&&cy==1?uWBG.z:uWBG.w;
    float raw=tx.r*uMaxRaw*wb;
    float mapped=(fn(raw)-uOffset)*uScale;
    if(uPal==4){fragColor=colorExpand(mapped);return;}
    if(uPal==2){fragColor=satWarn(mapped);return;}
    if(uPal==3){fragColor=satWarn(255.-mapped);return;}
    fragColor=lut(mapped); return;
  }

  bool aR=(uChan&1)!=0,aG=(uChan&2)!=0,aB=(uChan&4)!=0;
  float rR=aR?tx.r*uMaxRaw*uWBC.r:0.;
  float rG=aG?tx.g*uMaxRaw*uWBC.g:0.;
  float rB=aB?tx.b*uMaxRaw*uWBC.b:0.;

  // Solo channel: C++ uses translatePixel (full palette color), same as single-channel image.
  int nA=(aR?1:0)+(aG?1:0)+(aB?1:0);
  if(nA==1){
    float solo=aR?rR:aG?rG:rB;
    float mapped=(fn(solo)-uOffset)*uScale;
    if(uPal==4){fragColor=colorExpand(mapped);return;}
    fragColor=lut(mapped); return;
  }

  // Multi-channel (2+ active): apply the palette PER CHANNEL through its own colour coordinate —
  // out.R=lut(R).r, out.G=lut(G).g, out.B=lut(B).b — so a palette whose R/G/B channels all rise
  // (e.g. CET-L07, which ends near white) keeps a colour image believable rather than inverting it.
  // (The C++ translatePixelMultiChan took the *blue* byte for every channel, which inverts any
  // palette whose blue channel falls; grey is the identity LUT, so both agree there.)
  // For ColorExpansion: C++ val = floor(m*65793), output = val & 0xFF = floor(m*65793) mod 256.
  float mR=(fn(rR)-uOffset)*uScale;
  float mG=(fn(rG)-uOffset)*uScale;
  float mB=(fn(rB)-uOffset)*uScale;
  if(uPal==4){
    fragColor=vec4(
      mod(floor(clamp(mR,0.,255.)*65793.),256.)/255.,
      mod(floor(clamp(mG,0.,255.)*65793.),256.)/255.,
      mod(floor(clamp(mB,0.,255.)*65793.),256.)/255.,
      1.);
    return;
  }
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, NUM_PALETTES, 0, gl.RGBA, gl.UNSIGNED_BYTE, LUT_DATA);
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
    gl.clearColor(0.0, 0.50196078, 0.0, 1); // Qt::darkGreen (#008000), like the C++ pxlpeep
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
    const _wbc=S.wbPeek?[1,1,1]:S.wbColor, _wbg=S.wbPeek?[1,1,1,1]:S.wbGrey;
    gl.uniform3f(this.u.uWBC, _wbc[0], _wbc[1], _wbc[2]);
    gl.uniform4f(this.u.uWBG, _wbg[0], _wbg[1], _wbg[2], _wbg[3]);
    gl.uniform2f(this.u.uSz, S.image.width, S.image.height);
    const dpr=window.devicePixelRatio||1;
    gl.uniform2f(this.u.uVP,   this.canvas.width/dpr, this.canvas.height/dpr);
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

  // Render at given pixel dimensions with identity pan/zoom (for export).
  // Caller must restore canvas size (call sizeCanvases()) after reading pixels.
  drawToSize(w, h) {
    if (!this.imgTex) return;
    const gl = this.gl;
    this.canvas.width = w; this.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
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
    // Mapped export re-renders the CORRECTED image at native size — the transient Alt+W
    // peek must not leak into a saved/copied PNG, so use the real gains here (unlike draw()).
    gl.uniform3f(this.u.uWBC, S.wbColor[0], S.wbColor[1], S.wbColor[2]);
    gl.uniform4f(this.u.uWBG, S.wbGrey[0], S.wbGrey[1], S.wbGrey[2], S.wbGrey[3]);
    gl.uniform2f(this.u.uSz, S.image.width, S.image.height);
    gl.uniform2f(this.u.uVP, w, h);
    gl.uniform2f(this.u.uPan, 0, 0);
    gl.uniform1f(this.u.uZoom, 1.0);
    gl.uniform1f(this.u.uMaxRaw, (1 << S.image.bpp) - 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE LOADING
// ══════════════════════════════════════════════════════════════════════════════

// Errors carry a `kind` so the UI can explain what actually went wrong.
class FetchError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const FETCH_TIMEOUT_MS = 30000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]); // transient server states
const MAX_RETRIES = 3;

// Delay before the next attempt: honor Retry-After (delta-seconds or HTTP-date,
// capped at 30s) when the server sends it, otherwise exponential backoff + jitter.
function retryDelayMs(resp, attempt) {
  const ra = resp.headers.get("retry-after");
  if (ra) {
    const s = /^\d+$/.test(ra.trim()) ? +ra : (Date.parse(ra) - Date.now()) / 1000;
    if (s > 0) return Math.min(s, 30) * 1000;
  }
  return Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
}

// Fetch the source bytes exactly once, auto-retrying transient server errors
// (429/502/503/504) with backoff. Pixel decode, EXIF, and save reuse the Blob.
let _sourceBlobPromise = null;
function getSourceBlob(url) {
  if (_sourceBlobPromise) return _sourceBlobPromise;

  let attempt = 0;
  const attemptFetch = () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal })
      .then(r => {
        if (r.ok) return r.blob();
        if (RETRYABLE_STATUS.has(r.status) && attempt < MAX_RETRIES) {
          const wait = retryDelayMs(r, attempt++);
          reportRetry(r.status, attempt, wait);
          clearTimeout(timer);
          return new Promise(res => setTimeout(res, wait)).then(attemptFetch);
        }
        throw new FetchError("http", `Server returned ${r.status} ${r.statusText}`.trim(), r.status);
      })
      .catch(e => {
        if (e instanceof FetchError) throw e;
        if (e.name === "AbortError") throw new FetchError("timeout", `Timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
        throw new FetchError("network", "Network error — could not reach the host");
      })
      .finally(() => clearTimeout(timer));
  };

  _sourceBlobPromise = attemptFetch();
  // Drop the cached rejection on failure so a manual Retry re-fetches cleanly.
  _sourceBlobPromise.catch(() => { _sourceBlobPromise = null; });
  return _sourceBlobPromise;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    getSourceBlob(url).then(blob => {
      // Decode from a same-origin blob URL: no CORS request, no canvas taint.
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(blobUrl);
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
            // Fit/colorbar span the per-channel value range (matches the C++), not
            // luminance — so a single saturated channel still drives Fit scaling.
            if (data[s]  <minV) minV=data[s];   if (data[s]  >maxV) maxV=data[s];
            if (data[s+1]<minV) minV=data[s+1]; if (data[s+1]>maxV) maxV=data[s+1];
            if (data[s+2]<minV) minV=data[s+2]; if (data[s+2]>maxV) maxV=data[s+2];
          }
        }

        resolve({ width, height, numChannels:nChan, bpp:8,
                  data:floats, minValue:minV, maxValue:maxV });
      };
      img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new FetchError("decode", "Downloaded, but couldn't decode the image (unsupported format or corrupt data)")); };
      img.src = blobUrl;
    }).catch(reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// EXIF PARSER (minimal inline JPEG EXIF reader, no dependencies)
// ══════════════════════════════════════════════════════════════════════════════

async function extractExif(url) {
  try {
    const blob = await getSourceBlob(url);
    const buf  = await blob.arrayBuffer();
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

// WB gains that neutralise the box, STACKED over the current correction: the region
// average is taken over the CORRECTED values (raw × current gains, clamped to 1.0 = the
// 255 display clip), and the incremental gain is multiplied onto the current gains. So a
// new WB composes over the existing one, and re-applying an already-neutral box is a
// no-op — except where a gain clipped a channel, which is the intended saturation
// dependence. `base` defaults to identity, so an unstacked call gives absolute gains.
function computeWBColor(img, x1,y1,x2,y2, base) {
  base=base||[1,1,1];
  const { width, data } = img;
  const rX=Math.floor(Math.max(0,Math.min(x1,x2)));
  const rY=Math.floor(Math.max(0,Math.min(y1,y2)));
  const rW=Math.floor(Math.abs(x2-x1));
  const rH=Math.floor(Math.abs(y2-y1));
  if (rW<1||rH<1) return base;
  const avg=[0,0,0]; let qty=0;
  for (let r=0;r<rH;r++) for (let c=0;c<rW;c++) {
    const i=((rY+r)*width+(rX+c))*3;
    avg[0]+=Math.min(1,data[i]  *base[0])*255;
    avg[1]+=Math.min(1,data[i+1]*base[1])*255;
    avg[2]+=Math.min(1,data[i+2]*base[2])*255; qty++;
  }
  if (!qty) return base;
  avg[0]/=qty; avg[1]/=qty; avg[2]/=qty;
  const goal=(avg[0]+avg[1]+avg[2])/3;
  if (!goal) return base;
  return [
    base[0]*goal/Math.max(avg[0],1e-9),
    base[1]*goal/Math.max(avg[1],1e-9),
    base[2]*goal/Math.max(avg[2],1e-9),
  ];
}

function computeWBGrey(img, x1,y1,x2,y2, base) {
  base=base||[1,1,1,1];
  const { width, data } = img;
  const rX=Math.floor(Math.max(0,Math.min(x1,x2)));
  const rY=Math.floor(Math.max(0,Math.min(y1,y2)));
  const rW=Math.floor(Math.abs(x2-x1));
  const rH=Math.floor(Math.abs(y2-y1));
  if (rW<2||rH<2) return base;
  const avg=[0,0,0,0], qty=[0,0,0,0];
  for (let r=0;r<rH;r++) for (let c=0;c<rW;c++) {
    const col=rX+c, row=rY+r, q=(col%2)+(row%2)*2;
    avg[q]+=Math.min(1,data[row*width+col]*base[q])*255;
    qty[q]++;
  }
  for (let q=0;q<4;q++) if(qty[q]) avg[q]/=qty[q];
  const goal=(avg[0]+avg[1]+avg[2]+avg[3])/4;
  if (!goal) return base;
  return [
    base[0]*goal/Math.max(avg[0],1e-9),
    base[1]*goal/Math.max(avg[1],1e-9),
    base[2]*goal/Math.max(avg[2],1e-9),
    base[3]*goal/Math.max(avg[3],1e-9),
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
  const dpr=window.devicePixelRatio||1;
  const lw=ow/dpr, lh_=oh/dpr;
  ctx.clearRect(0,0,ow,oh);
  ctx.save();
  ctx.scale(dpr,dpr);
  ctx.font = FONT;
  if (S.showGrid)     drawGrid(ctx, lw, lh_);
  if (S.showRulers)   drawRulers(ctx, lw, lh_);
  if (S.showColorbar) drawColorbar(ctx, lw, lh_);
  drawWBBox(ctx, lw, lh_);
  drawMeasures(ctx, lw, lh_);
  drawLatched(ctx, lw, lh_);
  if (S.showInfo)     drawInfoBox(ctx, lw, lh_);
  if (pHeld)          drawCursorBox(ctx, lw, lh_);   // live cursor box = hold P
  if (S.showHelp)     drawHelp(ctx, lw, lh_);
  ctx.restore();
}

function lh(ctx) {
  const m=ctx.measureText("M");
  return (m.actualBoundingBoxAscent||8)+(m.actualBoundingBoxDescent||2)+2;
}

function tw(ctx, s) { return ctx.measureText(s).width; }

function blackBox(ctx, x,y,w,h) {
  ctx.fillStyle="rgba(0,0,0,0.85)"; ctx.fillRect(x,y,w,h);
}

// Format a raw pixel sample applying the CURRENT channel on/off state, so a pinned cursor
// box reflects a channel toggle live (shows OFF) even though its raw value is frozen at pin
// time. raw: number (grey — no gating) | [r,g,b] | null (off-image → no value line).
function formatVal(raw){
  if(raw==null) return null;
  if(typeof raw==="number") return String(raw);
  const g=(flag,v)=>(S.channels&flag)?String(v):"OFF";
  return `${g(CHAN_R,raw[0])}, ${g(CHAN_G,raw[1])}, ${g(CHAN_B,raw[2])}`;
}

// Shared cursor readout — display X/Y, polar R/θ about the image center, and the
// pixel value(s) at (ix,iy). Used by BOTH the top-right info box and the cursor
// box so their numbers always agree. Returns val=null when (ix,iy) is off-image.
// `raw` is the ungated sample (frozen by latched pins; formatVal re-gates it live).
function pixelReadout(ix, iy) {
  const img=S.image;
  const dispW=(S.rotation===1||S.rotation===3)?img.height:img.width;
  const dispH=(S.rotation===1||S.rotation===3)?img.width:img.height;
  // 0-based, pixel-centre display coords (pixel k's centre → k). Y-origin flip reflects the
  // Y coordinate across the pixel-centre range [0, dispH-1], so the BOTTOM pixel reads 0.
  let cx0=ix-0.5, cy0=iy-0.5;
  if(S.yFlip) cy0=(dispH-1)-cy0;
  // R/θ about the image centre, in the (possibly flipped) display frame.
  const rX=cx0-(dispW-1)/2, rY=cy0-(dispH-1)/2;
  const R=Math.sqrt(rX*rX+rY*rY);
  const theta=Math.atan2(rY,rX)*180/Math.PI;
  // Displayed coordinate labels honour the 0/1-based toggle.
  const off=S.zeroIdx?0:1;
  const curX=cx0+off, curY=cy0+off;
  // Raw (ungated) pixel sample; channel on/off is applied by formatVal at display time so a
  // frozen (latched) sample still reflects live channel toggles.
  let raw=null;
  const px=Math.floor(ix), py=Math.floor(iy);
  if(px>=0&&px<img.width&&py>=0&&py<img.height) {
    const maxV=(1<<img.bpp)-1;
    if(img.numChannels===1) {
      raw=Math.round(img.data[py*img.width+px]*maxV);
    } else {
      const i=(py*img.width+px)*3;
      raw=[Math.round(img.data[i]*maxV), Math.round(img.data[i+1]*maxV), Math.round(img.data[i+2]*maxV)];
    }
  }
  return {curX, curY, R, theta, val:formatVal(raw), raw};
}

// ── Info box ──────────────────────────────────────────────────────────────────
// Human-readable basename of the current image, for the info box + save filenames.
// Splits on / and \, drops any query/hash, percent-decodes — so on desktop, where
// S.imagePath is the real file path, this is "rgb.png", not the asset:// URL's
// encoded absolute path. withExt keeps the extension (info box, original save);
// without, it's the stem the mapped/screenshot names build on.
function imageBaseName(withExt) {
  let seg=S.imagePath.split(/[?#]/)[0].split(/[/\\]/).pop()||"image";
  try { seg=decodeURIComponent(seg); } catch {}
  seg=seg||"image";
  return withExt ? seg : (seg.replace(/\.[^.]+$/,"")||"image");
}

function drawInfoBox(ctx, ow, oh) {
  if (!S.image) return;
  const img=S.image, lineH=lh(ctx);
  const lines=[];

  lines.push(S.imagePath);

  const rot=["","  90°","  180°","  270°"][S.rotation];
  const fl=S.flipH&&S.flipV?" H+V flip":S.flipH?" H flip":S.flipV?" V flip":"";
  lines.push(`W=${img.width}${unitSuffix(img.width)} H=${img.height}${unitSuffix(img.height)}  ${S.zoomFactor.toFixed(2)}×${rot}${fl}`);

  if (S.exif) {
    const e=S.exif;
    if (e.iso!=null&&e.shutterMs!=null)
      lines.push(`ISO ${e.iso}  ${e.shutterMs.toFixed(2)} ms${e.aperture!=null?`  f/${e.aperture.toFixed(1)}`:""}${e.ev!=null?`  EV ${e.ev.toFixed(2)}`:""}`);
    const meta=[e.date, e.make, e.firmware].filter(Boolean).join(" — ");
    if (meta) lines.push(meta);
  }

  // Cursor info — shared readout at the raw cursor position.
  const [ix,iy]=viewToImg(S.cursorX,S.cursorY);
  const rd=pixelReadout(ix,iy);
  let line5=`X=${rd.curX.toFixed(1)}${unitSuffix(rd.curX)} Y=${rd.curY.toFixed(1)}${unitSuffix(rd.curY)}  R=${rd.R.toFixed(1)}${unitSuffix(rd.R)} θ=${rd.theta.toFixed(1)}°`;
  if(rd.val!==null) line5+=`  → ${rd.val}`;
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
// Above a zoom threshold, snap to the CENTER of the pixel under the cursor: drop a
// nested-square marker there and anchor the info box to it, so the readout doesn't
// drift with the cursor. That's what makes a *screenshot* legible — the OS cursor
// isn't captured, so without the marker you can't tell which pixel the numbers
// describe. Below the threshold the box just floats at the cursor (fractional coords).
// Based on the C++ drawCursorInfoBox, which snapped to a half-pixel grid — fine there,
// since it showed only coordinates (X/Y/R/θ), for which a corner is a valid position.
// We add a pixel-value line, and a value at the corner where 4 pixels meet is
// meaningless — so we snap to whole pixels (the pixel center) instead.
const CURSOR_MARKER_ZOOM = 16; // zoomFactor at/above which we snap + mark (C++ markerZoomLevel)

// Live cursor box (shown while P is held): the marker + readout follow the cursor.
function drawCursorBox(ctx, ow, oh) {
  if (!S.image) return;
  const img=S.image;
  let [ix,iy]=viewToImg(S.cursorX,S.cursorY);
  ix=snapCentre(ix,img.width); iy=snapCentre(iy,img.height);   // bind the live box to the image, like measure/WB
  drawMarkerAndBox(ctx, ix, iy, ow, oh);
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

  // Vertical — anchor the tick grid at the Y-origin edge (top when unflipped, bottom when
  // flipped) so the origin tick is always placed, then march across the visible band.
  const dn = !S.yFlip;
  let yImg = dn ? 0.5 : dispH-0.5;
  while(true) {
    let [,yDraw]=imgToView(0,yImg);
    while(dn ? yDraw<CORNER : yDraw>oh-CORNER) {
      const old=yDraw;
      while(yDraw===old){ yImg+=dn?1:-1; if(yImg<0.5||yImg>dispH-0.5) break; [,yDraw]=imgToView(0,yImg); }
      if(yImg<0.5||yImg>dispH-0.5) break;
    }
    if(yImg<0.5 || yImg>dispH-0.5) break;
    if(dn ? yDraw>oh-CORNER : yDraw<CORNER) break;

    ctx.lineWidth=3; ctx.strokeStyle="#000";
    ctx.beginPath();ctx.moveTo(0,yDraw);ctx.lineTo(TICK,yDraw);ctx.stroke();
    ctx.beginPath();ctx.moveTo(ow,yDraw);ctx.lineTo(ow-TICK,yDraw);ctx.stroke();
    ctx.lineWidth=1; ctx.strokeStyle="#fff";
    ctx.beginPath();ctx.moveTo(0,yDraw);ctx.lineTo(TICK,yDraw);ctx.stroke();
    ctx.beginPath();ctx.moveTo(ow,yDraw);ctx.lineTo(ow-TICK,yDraw);ctx.stroke();

    let yCoord=Math.floor(yImg)+(S.zeroIdx?0:1);
    if(S.yFlip) yCoord=(dispH-1-Math.floor(yImg))+(S.zeroIdx?0:1);
    const label=String(yCoord);
    const lw2=tw(ctx,label);
    ctx.fillStyle="#000"; ctx.fillRect(1,yDraw+2,lw2+2,lineH); ctx.fillRect(ow-lw2-2,yDraw+2,lw2+2,lineH);
    ctx.fillStyle="#fff"; ctx.fillText(label,2,yDraw+2+lineH-2); ctx.fillText(label,ow-lw2-1,yDraw+2+lineH-2);

    const oldY=yImg;
    yImg=Math.floor(viewToImg(0,yDraw+(dn?MIN_SPACE:-MIN_SPACE))[1])+0.5;
    if(dn ? yImg<=oldY : yImg>=oldY) yImg=oldY+(dn?1:-1);
    if(yImg<0.5 || yImg>dispH-0.5) break;
  }
}

// ── Colorbar ──────────────────────────────────────────────────────────────────
function drawColorbar(ctx, ow, oh) {
  if (!S.image) return;
  const lineH=lh(ctx);
  const BAR_H=10;

  let title=PALETTE_NAMES[S.palette];
  const ds=S.dipFactor.toFixed(3);
  if(S.imgFn===ImgFn.LogDarken)             title+=` log darken (${ds})`;
  if(S.imgFn===ImgFn.LogBrighten)           title+=` log brighten (${ds})`;
  if(S.imgFn===ImgFn.ParabolicDarken)       title+=` parabolic darken (${ds})`;
  if(S.imgFn===ImgFn.ParabolicBrighten)     title+=` parabolic brighten (${ds})`;
  if(S.scaling===Scaling.Fit)               title+=" fit";

  const minTxt=S.scaleMin.toFixed(1), maxTxt=S.scaleMax.toFixed(1);

  // Dynamic width: grow by 256 until title + min + max labels fit (mirrors C++)
  let BAR_W=255;
  while(tw(ctx,title)+tw(ctx,minTxt)+tw(ctx,maxTxt)+50 > BAR_W) BAR_W+=256;

  const bw=BAR_W+MAR*2, bh=BAR_H+lineH+5+MAR*2;
  const bx=ow-PAD-bw, by=oh-PAD-bh;

  blackBox(ctx,bx,by,bw,bh);

  // Draw bar iterating over BAR_W logical pixels (matches C++ which iterates barWidth),
  // then scale each logical pixel to dpr physical pixels to avoid aliasing in ColorExp.
  const dpr=window.devicePixelRatio||1;
  const physW=Math.round(BAR_W*dpr), physH=Math.round(BAR_H*dpr);
  const imgData=ctx.createImageData(physW,physH);
  for(let lx=0;lx<BAR_W;lx++){
    const t = lx===0 ? 0 : lx/(BAR_W-1);
    const rawVal = S.scaleMin + t*(S.scaleMax-S.scaleMin);
    const fnVal  = applyFn(rawVal, S.imgFn, S.dipFactor, S.scaleMin, S.scaleMax);
    const mapped = Math.max(0, Math.min(255, (fnVal-S.offset)*S.scale));
    let cr, cg, cb;
    if(S.palette===Palette.ColorExp){
      const v24=Math.max(0,Math.min(16777215,Math.floor(mapped*65793)));
      cr=(v24>>16)&0xFF; cg=(v24>>8)&0xFF; cb=v24&0xFF;
    } else {
      const i=(S.palette*256+Math.round(mapped))*4;
      cr=LUT_DATA[i]; cg=LUT_DATA[i+1]; cb=LUT_DATA[i+2];
    }
    const pxA=Math.round(lx*dpr), pxB=Math.round((lx+1)*dpr);
    for(let px=pxA;px<pxB&&px<physW;px++){
      for(let py=0;py<physH;py++){
        const d=(py*physW+px)*4;
        imgData.data[d]=cr; imgData.data[d+1]=cg; imgData.data[d+2]=cb; imgData.data[d+3]=255;
      }
    }
  }
  ctx.putImageData(imgData,Math.round((bx+MAR)*dpr),Math.round((by+MAR+lineH+5)*dpr));

  ctx.fillStyle="#fff";
  ctx.fillText(minTxt, bx+MAR, by+MAR+lineH);
  ctx.fillText(maxTxt, bx+bw-MAR-tw(ctx,maxTxt), by+MAR+lineH);
  ctx.fillText(title, bx+bw/2-tw(ctx,title)/2, by+MAR+lineH);
}

// ── ROI ───────────────────────────────────────────────────────────────────────
// ── Pixel grid ────────────────────────────────────────────────────────────────
// Thin lines on pixel boundaries so a flat, constant-colour region still shows its
// scale when zoomed in. Black-flanked-white like the rulers, so it reads over any
// pixel value; hidden below GRID_MIN_ZOOM, where the lines would collapse into mush.
const GRID_MIN_ZOOM = 64; // 64× is the first zoom where the rulers show one tick per pixel
function drawGrid(ctx, ow, oh) {
  if (!S.image || S.zoomFactor < GRID_MIN_ZOOM) return;
  const dispW=(S.rotation===1||S.rotation===3)?S.image.height:S.image.width;
  const dispH=(S.rotation===1||S.rotation===3)?S.image.width :S.image.height;
  const xOf=c=>c*S.zoomFactor+S.panX, yOf=r=>r*S.zoomFactor+S.panY;
  // Draw only within the image's visible extent — no lines out in the letterbox.
  const yTop=Math.max(0,yOf(0)),     yBot=Math.min(oh,yOf(dispH));
  const xLeft=Math.max(0,xOf(0)),    xRight=Math.min(ow,xOf(dispW));
  if (yBot<=yTop || xRight<=xLeft) return;
  const cStart=Math.max(0,   Math.ceil ((0 -S.panX)/S.zoomFactor));
  const cEnd  =Math.min(dispW,Math.floor((ow-S.panX)/S.zoomFactor));
  const rStart=Math.max(0,   Math.ceil ((0 -S.panY)/S.zoomFactor));
  const rEnd  =Math.min(dispH,Math.floor((oh-S.panY)/S.zoomFactor));
  const pass=(style,w)=>{
    ctx.strokeStyle=style; ctx.lineWidth=w; ctx.beginPath();
    for(let c=cStart;c<=cEnd;c++){ const x=Math.round(xOf(c))+0.5; ctx.moveTo(x,yTop); ctx.lineTo(x,yBot); }
    for(let r=rStart;r<=rEnd;r++){ const y=Math.round(yOf(r))+0.5; ctx.moveTo(xLeft,y); ctx.lineTo(xRight,y); }
    ctx.stroke();
  };
  pass("#000",3); pass("#fff",1);
}

// Unit annotation for a pixel value: "" when uncalibrated, else " (X.XXX unit)".
function unitSuffix(px){
  return !S.calibrated ? "" : ` (${(px*S.unitPerPix).toFixed(3)} ${S.unitName})`;
}

// A right-aligned black readout box anchored near (ax,ay), clamped on-canvas. Shared by
// the cursor box, latched boxes, measures, and the WB box so their look always agrees.
function drawLabelBox(ctx, ax, ay, lines, ow, oh, dirX, dirY){
  dirX = dirX===undefined ? 1 : dirX;   // +1: box extends right of ax, -1: to the left
  dirY = dirY===undefined ? 1 : dirY;   // +1: below ay,               -1: above
  const lineH=lh(ctx);
  const maxW=Math.max(...lines.map(l=>tw(ctx,l)));
  const bw=maxW+MAR*2, bh=lineH*lines.length+MAR*2;
  const ax2 = dirX>=0 ? ax : ax-bw, ay2 = dirY>=0 ? ay : ay-bh;
  const bx=Math.max(0,Math.min(ow-bw,ax2)), by=Math.max(0,Math.min(oh-bh,ay2));
  blackBox(ctx,bx,by,bw,bh);
  ctx.fillStyle="#fff";
  lines.forEach((l,i)=>ctx.fillText(l, bx+bw-tw(ctx,l)-MAR, by+MAR+lineH*(i+1)-2));
}

// Nested black/white/black pixel-centre marker (18px).
function drawPixelMarker(ctx, refX, refY){
  const third=3, half=9, size=18;
  ctx.fillStyle="#000"; ctx.fillRect(refX-half,         refY-half,         size,         size);
  ctx.fillStyle="#fff"; ctx.fillRect(refX-half+third,   refY-half+third,   size-2*third,  size-2*third);
  ctx.fillStyle="#000"; ctx.fillRect(refX-half+2*third, refY-half+2*third, size-4*third,  size-4*third);
}

// Black-flanked-white "+" marker (same 18px extent); +0.5 keeps the odd-width strokes crisp.
function drawPlusMarker(ctx, refX, refY){
  const half=9;
  const plus=(style,w)=>{
    ctx.strokeStyle=style; ctx.lineWidth=w;
    ctx.beginPath();
    ctx.moveTo(refX-half,refY); ctx.lineTo(refX+half,refY);
    ctx.moveTo(refX,refY-half); ctx.lineTo(refX,refY+half);
    ctx.stroke();
  };
  plus("#000",3); plus("#fff",1);
}

// The X/Y/R/θ/value readout lines for a pixelReadout result.
function cursorLines(rd){
  const lines=[
    // X/Y are whole numbers (the readout always snaps to a pixel centre), so no decimal.
    `X = ${rd.curX.toFixed(0)}${unitSuffix(rd.curX)}, Y = ${rd.curY.toFixed(0)}${unitSuffix(rd.curY)}`,
    `R = ${rd.R.toFixed(1)}${unitSuffix(rd.R)}, θ = ${rd.theta.toFixed(1)}°`,
  ];
  if(rd.val!==null) lines.push(rd.val);
  return lines;
}

// Marker + readout box at display point (ix,iy). The readout ALWAYS snaps to the pixel centre
// (floor+0.5) regardless of zoom, so the shown X/Y names the exact pixel the value is sampled
// from — and the marker sits on that same pixel, never misleading. The zoom threshold only
// picks the marker GLYPH: a nested square at/above CURSOR_MARKER_ZOOM, a "+" below. Shared by
// the live cursor box and every latched box; valOverride supplies a latched box's frozen value.
function drawMarkerAndBox(ctx, ix, iy, ow, oh, valOverride){
  const rx=Math.floor(ix)+0.5, ry=Math.floor(iy)+0.5;
  let [refX,refY]=imgToView(rx,ry);
  if (Math.round(S.zoomFactor*100) >= CURSOR_MARKER_ZOOM*100) {
    refX=Math.round(refX); refY=Math.round(refY);
    drawPixelMarker(ctx, refX, refY);
  } else {
    refX=Math.round(refX)+0.5; refY=Math.round(refY)+0.5;
    drawPlusMarker(ctx, refX, refY);
  }
  const rd=pixelReadout(rx,ry);
  if(valOverride!==undefined) rd.val=valOverride;
  drawLabelBox(ctx, refX+10, refY+10, cursorLines(rd), ow, oh);
}

// Latched boxes recompute X/Y/R/θ + units LIVE from their (rotation-transformed) display
// coords — so they track the ruler and calibration. Only the RAW pixel sample is frozen at
// pin time (the display coords would mis-sample the raw texture after a rotation); channel
// on/off is re-applied live by formatVal, so hiding a channel updates a pin's value too.
// Marker is +/square by current zoom.
function drawLatched(ctx, ow, oh){
  for(const p of S.latched){
    drawMarkerAndBox(ctx, p.x, p.y, ow, oh, formatVal(p.raw));
  }
}

// WB box: corner-snapped rectangle + a w×h label (no diagonal — meaningless for WB).
function drawWBBox(ctx, ow, oh){
  if(!S.wbBox) return;
  const b=S.wbBox;
  const [sx1,sy1]=imgToView(b.x1,b.y1), [sx2,sy2]=imgToView(b.x2,b.y2);
  const x=Math.min(sx1,sx2), y=Math.min(sy1,sy2), w=Math.abs(sx2-sx1), h=Math.abs(sy2-sy1);
  ctx.strokeStyle="#000"; ctx.lineWidth=3; ctx.strokeRect(x,y,w,h);
  ctx.strokeStyle="#fff"; ctx.lineWidth=1; ctx.strokeRect(x,y,w,h);
  const dw=Math.abs(b.x2-b.x1), dh=Math.abs(b.y2-b.y1);
  drawLabelBox(ctx, x+w+4, y, [`${Math.round(dw)}${unitSuffix(dw)} × ${Math.round(dh)}${unitSuffix(dh)}`], ow, oh);
}

// One measure line + its dx/dy/L/θ box. dx,dy are SIGNED (the direction that makes θ
// flip when you reverse the drag); θ is math convention (0° east, CCW+, up=+90).
function drawOneMeasure(ctx, m, ow, oh){
  const [sx1,sy1]=imgToView(m.x1,m.y1), [sx2,sy2]=imgToView(m.x2,m.y2);
  ctx.strokeStyle="#000"; ctx.lineWidth=3; ctx.beginPath();ctx.moveTo(sx1,sy1);ctx.lineTo(sx2,sy2);ctx.stroke();
  ctx.strokeStyle="#fff"; ctx.lineWidth=1; ctx.beginPath();ctx.moveTo(sx1,sy1);ctx.lineTo(sx2,sy2);ctx.stroke();
  const dx=m.x2-m.x1, dyRaw=m.y2-m.y1, L=Math.hypot(dx,dyRaw);
  const theta=Math.atan2(-dyRaw,dx)*180/Math.PI;   // visual angle — yFlip-independent
  const dy=S.yFlip ? -dyRaw : dyRaw;                // dy in the DISPLAYED Y convention
  const sgn=v=>(v>=0?"+":"")+Math.round(v);
  const lines=[
    `dx = ${sgn(dx)}${unitSuffix(dx)}`,
    `dy = ${sgn(dy)}${unitSuffix(dy)}`,
    `L = ${L.toFixed(1)}${unitSuffix(L)}`,
    `θ = ${theta.toFixed(1)}°`,
  ];
  // Anchor the box in the line's heading direction, with hysteresis (Schmitt trigger) so a
  // near-horizontal/vertical line doesn't flip the corner on tiny mouse jitter. The chosen
  // sign is remembered on the measure (and live drag) and only flips past a ±HYST band.
  const HYST=15, ddx=sx2-sx1, ddy=sy2-sy1;
  m.cxSign = ddx>HYST ? 1 : ddx<-HYST ? -1 : (m.cxSign ?? (ddx>=0?1:-1));
  m.cySign = ddy>HYST ? 1 : ddy<-HYST ? -1 : (m.cySign ?? (ddy>=0?1:-1));
  drawLabelBox(ctx, sx2+10*m.cxSign, sy2+10*m.cySign, lines, ow, oh, m.cxSign, m.cySign);
}

function drawMeasures(ctx, ow, oh){
  for(const m of S.measures) drawOneMeasure(ctx, m, ow, oh);
  if(measureDrag) drawOneMeasure(ctx, measureDrag, ow, oh);
}

// ── Tool actions ───────────────────────────────────────────────────────────────
function revertWB(){ S.wbColor=[1,1,1]; S.wbGrey=[1,1,1,1]; recomputeMinMax(); recalcScale(); }
function applyWBFromBox(){
  if(!S.wbBox||!S.image) return;
  const b=S.wbBox;
  if(S.image.numChannels===1) S.wbGrey =computeWBGrey (S.image,b.x1,b.y1,b.x2,b.y2,S.wbGrey);
  else                        S.wbColor=computeWBColor(S.image,b.x1,b.y1,b.x2,b.y2,S.wbColor);
  recomputeMinMax(); recalcScale();
  S.wbSeq=++S._seq;
}
function addMeasure(m){ S.measures.push(m); S.measSeq=++S._seq; }
function addLatched(ix,iy){ S.latched.push({x:ix, y:iy, raw:pixelReadout(ix,iy).raw}); S.latSeq=++S._seq; }

// Rotate/flip transform the overlays with the image so they stay pinned to content (the
// readout boxes are drawn axis-aligned, so text stays upright). Display-pixel dims for
// the current rotation:
// Display-pixel <-> raw-texture mapping for a given rotation/flip, matching the shader
// xform() (flip THEN rotate).
function dispToRaw(dx,dy,rot,fH,fV){
  const iW=S.image.width, iH=S.image.height;
  const dW=(rot===1||rot===3)?iH:iW, dH=(rot===1||rot===3)?iW:iH;
  let u=dx/dW, v=dy/dH;
  if(fH) u=1-u; if(fV) v=1-v;
  if(rot===1){ const a=u; u=v;   v=1-a; }
  else if(rot===2){ u=1-u; v=1-v; }
  else if(rot===3){ const a=u; u=1-v; v=a; }
  return [u*iW, v*iH];
}
function rawToDisp(rx,ry,rot,fH,fV){
  const iW=S.image.width, iH=S.image.height;
  const dW=(rot===1||rot===3)?iH:iW, dH=(rot===1||rot===3)?iW:iH;
  let u=rx/iW, v=ry/iH;
  if(rot===1){ const a=u; u=1-v; v=a; }
  else if(rot===2){ u=1-u; v=1-v; }
  else if(rot===3){ const a=u; u=v;   v=1-a; }
  if(fH) u=1-u; if(fV) v=1-v;
  return [u*dW, v*dH];
}
// Remap every overlay point (and any in-progress drag anchor) from the OLD display frame
// to the current one, THROUGH raw texture coords — exact for any rotation×flip combo. A
// bare display-space rotation is wrong once a single flip is active (the shader flips
// before rotating). Call AFTER updating S.rotation/flip, with the pre-change state.
function retransformOverlays(oldRot, oldFH, oldFV){
  if(!S.image) return;
  const map=(x,y)=>{ const [rx,ry]=dispToRaw(x,y,oldRot,oldFH,oldFV); return rawToDisp(rx,ry,S.rotation,S.flipH,S.flipV); };
  for(const m of S.measures){ [m.x1,m.y1]=map(m.x1,m.y1); [m.x2,m.y2]=map(m.x2,m.y2); }
  for(const p of S.latched){ [p.x,p.y]=map(p.x,p.y); }
  if(S.wbBox){ const b=S.wbBox; [b.x1,b.y1]=map(b.x1,b.y1); [b.x2,b.y2]=map(b.x2,b.y2); }
  if(measureDrag){ [measureDrag.x1,measureDrag.y1]=map(measureDrag.x1,measureDrag.y1); [measureDrag.x2,measureDrag.y2]=map(measureDrag.x2,measureDrag.y2); }
  if(wbDrag){ [wbDrag.x0,wbDrag.y0]=map(wbDrag.x0,wbDrag.y0); }
}
// Esc clears the whole group of the most-recently-used tool (highest seq); repeated Esc
// walks back tool-by-tool. Shift+key still pops a single item from a given tool.
function escClear(){
  const g=[];
  if(S.wbBox)           g.push([S.wbSeq,   ()=>{S.wbBox=null;}]);
  if(S.measures.length) g.push([S.measSeq, ()=>{S.measures=[];}]);
  if(S.latched.length)  g.push([S.latSeq,  ()=>{S.latched=[];}]);
  if(!g.length) return;
  g.sort((a,b)=>b[0]-a[0]);
  g[0][1]();
}
// Calibrate user units off the most-recent measure line: unitPerPix = entered / L_px.
// A small in-app input overlay (not window.prompt, which WebView2 blocks); one text
// field "<number> <unit>".
function openCalibration(){
  if(!S.measures.length || document.getElementById("pxlpeep-calib")) return;
  const m=S.measures[S.measures.length-1];
  const Lpx=Math.hypot(m.x2-m.x1, m.y2-m.y1);
  if(Lpx<=0) return;
  const box=document.createElement("div");
  box.id="pxlpeep-calib";
  Object.assign(box.style,{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
    zIndex:"2147483647",background:"rgba(20,20,20,0.96)",border:"1px solid #555",borderRadius:"8px",
    padding:"16px 18px",font:"13px monospace",color:"#eee",boxShadow:"0 4px 20px rgba(0,0,0,0.6)"});
  const label=document.createElement("div");
  label.textContent=`This ${Math.round(Lpx)}px line is:`; label.style.marginBottom="8px";
  const input=document.createElement("input");
  input.type="text"; input.placeholder="10 mm";
  Object.assign(input.style,{font:"13px monospace",padding:"5px 7px",width:"160px",
    background:"#111",color:"#eee",border:"1px solid #555",borderRadius:"4px"});
  const hint=document.createElement("div");
  hint.textContent='number then unit, e.g. "10 mm" — Enter to set, Esc to cancel';
  Object.assign(hint.style,{marginTop:"7px",fontSize:"10px",color:"#888"});
  box.appendChild(label); box.appendChild(input); box.appendChild(hint);
  document.body.appendChild(box);
  const close=()=>{ box.remove(); requestFrame(); };
  input.addEventListener("keydown",ev=>{
    ev.stopPropagation();
    if(ev.key==="Enter"){
      const raw=input.value.trim(), sp=raw.search(/\s/);
      const numStr=sp<0?raw:raw.slice(0,sp);
      const unit=sp<0?"units":(raw.slice(sp+1).trim()||"units");
      const val=parseFloat(numStr);
      if(isFinite(val)&&val>0){ S.unitPerPix=val/Lpx; S.unitName=unit; S.calibrated=true; }
      close();
    } else if(ev.key==="Escape"){ close(); }
  });
  input.focus();
}

// ── Help ──────────────────────────────────────────────────────────────────────
// Sections mirror the toolbar's row groups (help groups into sections; the toolbar splits
// some sections into per-item rows — e.g. Mapping is one help section but four toolbar rows).
// Lines are GENERATED from (key, description) pairs with a fixed-width key column, so the two
// columns always line up in the monospace overlay font (no hand-counted spacing to drift).
const HELP_SECTIONS = [
  ["Mouse", [["Left drag","pan"],["Wheel","zoom"]]],
  ["Zoom", [["Ctrl+1","zoom to fit"],["Ctrl+2","zoom 1:1"]]],
  ["Position", [["Ctrl+3","center"],["Ctrl+4–7","image corners"]]],
  ["Image", [["F5","reload image"]]],
  ["Mapping", [
    ["V / Shift+V","cycle palette"],
    ["F / Shift+F","cycle function"],
    ["= / -","dip factor ±"],
    ["S","fit / full scale"],
  ]],
  ["Channels", [
    ["R","red   (Shift: solo)"],
    ["G","green (Shift: solo)"],
    ["B","blue  (Shift: solo)"],
  ]],
  ["Rotate / flip", [
    ["A / Shift+A","rotate CW / CCW"],
    ["L","flip horizontal"],
    ["T","flip vertical"],
  ]],
  ["Axes", [["Y","flip Y origin"],["0","0 / 1 indexing"]]],
  ["Tools (hold key + drag)", [
    ["W drag","white balance (stacks)"],
    ["Alt+W","peek pre-WB (hold)"],
    ["Shift+W","reset white balance"],
    ["M drag","measure line"],
    ["Shift+M","undo last measure"],
    ["U / Shift+U","set / clear units"],
    ["P (hold)","info box; click pins"],
    ["Shift+P","undo last box"],
    ["Esc","clear newest tool group"],
  ]],
  ["Overlays", [
    ["I","info box"],
    ["X","rulers"],
    ["C","colorbar"],
    ["D","pixel grid (64×+ zoom)"],
  ]],
  ["Save", [
    ["Ctrl+S","save original"],
    ["Ctrl+Alt+S","save mapped"],
    ["Ctrl+Shift+S","save screenshot"],
    ["J","force JPEG output"],
  ]],
  ["Copy", [
    ["Ctrl+C","copy mapped"],
    ["Ctrl+Shift+C","copy screenshot"],
  ]],
];
const HELP_LINES = (() => {
  const KEYW = 14;   // key column width; longest key ("Ctrl+Shift+S") is 12
  const data = [];
  for (const [, items] of HELP_SECTIONS)
    for (const [key, desc] of items) data.push(key.padEnd(KEYW) + desc);
  // Fill each section rule out to the widest content line so headers span the whole box.
  const width = Math.max(...data.map(l => l.length));
  const rule = title => ("── " + title + " ").padEnd(width, "─");
  const out = ["pxlpeep " + PXLPEEP_VERSION, ""];
  for (const [title, items] of HELP_SECTIONS) {
    out.push(rule(title));
    for (const [key, desc] of items) out.push(key.padEnd(KEYW) + desc);
    out.push("");
  }
  out.push("Any key shows this help");
  return out;
})();

function drawHelp(ctx, ow, oh) {
  // Shrink the font uniformly if the reference wouldn't otherwise fit the window height, so the
  // whole thing — including the Save/Copy shortcuts at the bottom — stays on-screen on short
  // windows (and as the menu keeps growing). On tall windows this is a no-op (11px as before).
  const avail=oh-2*PAD-2*MAR;
  let lineH=lh(ctx);
  if(lineH*HELP_LINES.length>avail){
    const scale=avail/(lineH*HELP_LINES.length);
    lineH*=scale;                                                  // scale the line PITCH to fit exactly
    ctx.font=`${Math.max(5,11*scale)}px "Courier New",monospace`;  // shrink glyphs to match the pitch
  }
  const maxW=Math.max(...HELP_LINES.map(l=>tw(ctx,l)));
  const bw=maxW+MAR*2, bh=lineH*HELP_LINES.length+MAR*2;
  const bx=ow-PAD-bw, by=PAD;
  blackBox(ctx,bx,by,bw,bh);
  ctx.fillStyle="#fff";
  HELP_LINES.forEach((l,i)=>ctx.fillText(l,bx+MAR,by+MAR+lineH*(i+1)-2));
  ctx.font=FONT;   // restore for any later overlay draw this frame
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
    case "3": if(ctrl){positionImage("center");}     else handled=false; break;
    case "4": if(ctrl){positionImage("topLeft");}    else handled=false; break;
    case "5": if(ctrl){positionImage("topRight");}   else handled=false; break;
    case "6": if(ctrl){positionImage("bottomLeft");} else handled=false; break;
    case "7": if(ctrl){positionImage("bottomRight");}else handled=false; break;

    case "v":case "V":
      S.palette=((S.palette+(shift?-1:1))%NUM_PALETTES+NUM_PALETTES)%NUM_PALETTES; break;   // plain = next, Shift = previous

    case "f":case "F":
      S.imgFn=((S.imgFn+(shift?-1:1))%5+5)%5;               // plain = next, Shift = previous
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

    case "F5":
      // Desktop: reload the image. Browser: let the tab refresh (handled=false).
      if(env.isDesktop){reloadImage();} else handled=false; break;
    case "r":case "R":
      if(ctrl){ if(env.isDesktop){reloadImage();} else handled=false; break; }
      S.channels=shift?CHAN_R:(S.channels^CHAN_R)||CHAN_R; break;
    case "g":case "G":
      S.channels=shift?CHAN_G:(S.channels^CHAN_G)||CHAN_G; break;
    case "b":case "B":
      S.channels=shift?CHAN_B:(S.channels^CHAN_B)||CHAN_B; break;

    case "a":case "A": { const or=S.rotation,ofh=S.flipH,ofv=S.flipV;
      S.rotation=((S.rotation+(shift?-1:1))%4+4)%4; retransformOverlays(or,ofh,ofv); break; }
    case "l":case "L": { const or=S.rotation,ofh=S.flipH,ofv=S.flipV; S.flipH=!S.flipH; retransformOverlays(or,ofh,ofv); break; }
    case "t":case "T": { const or=S.rotation,ofh=S.flipH,ofv=S.flipV; S.flipV=!S.flipV; retransformOverlays(or,ofh,ofv); break; }

    case "i":case "I": S.showInfo=!S.showInfo; break;
    case " ":          break;   // retired — the live cursor box is now "hold P"
    case "c":case "C":
      if(ctrl&&shift){copyToClipboard("screenshot");break;}
      if(ctrl)       {copyToClipboard("mapped");    break;}
      S.showColorbar=!S.showColorbar; break;
    case "x":case "X": S.showRulers=!S.showRulers; break;
    case "d":case "D": S.showGrid=!S.showGrid; break;

    case "y":case "Y": S.yFlip=!S.yFlip; break;
    case "0":          S.zeroIdx=!S.zeroIdx; break;
    case "j":case "J": S.forceJpeg=!S.forceJpeg; break;   // toggle Force-JPEG (toolbar checkbox is the only indicator)

    case "w":case "W":
      if(ctrl){handled=false;break;}
      if(alt){ if(!S.wbPeek) S.wbPeek=true; break; }   // hold Alt+W = peek at pre-WB
      if(shift){ revertWB(); break; }                   // permanent revert (keeps the box)
      if(!wHeld){ wHeld=true; if(!wbDrag) wDragged=false; } // arm W+drag; tap clears box (keep wDragged if a drag is live)
      break;
    case "m":case "M":
      if(ctrl){handled=false;break;}
      if(shift){ if(!e.repeat) S.measures.pop(); break; }   // undo last measure
      if(!mHeld) mHeld=true;                                // arm M+drag
      break;
    case "p":case "P":
      if(ctrl){handled=false;break;}
      if(shift){ if(!e.repeat) S.latched.pop(); break; }    // undo last latched box
      if(!pHeld) pHeld=true;                                // arm P+click
      break;
    case "u":case "U":
      if(ctrl){handled=false;break;}
      if(shift){ S.calibrated=false; S.unitPerPix=1; S.unitName="units"; break; }  // cancel calibration
      if(!e.repeat) openCalibration();                      // set units off last measure
      break;
    case "Escape":
      if(!e.repeat) escClear();                             // clear newest tool group
      break;

    default:
      if(!ctrl&&!alt&&e.key.length===1) S.showHelp=true;
      handled=false; break;
  }

  if(handled){e.preventDefault();e.stopPropagation();refreshToolbar();}
  requestFrame();
}

function onKeyUp(e) {
  if(S.showHelp){S.showHelp=false;requestFrame();}
  const k=e.key;
  if(k==="w"||k==="W"){
    if(S.wbPeek){S.wbPeek=false;requestFrame();}
    if(wHeld){ if(!wDragged) S.wbBox=null; wHeld=false; requestFrame(); }  // bare tap clears the box
  } else if(k==="Alt"){
    if(S.wbPeek){S.wbPeek=false;requestFrame();}                          // peek ends on Alt release too
  } else if(k==="m"||k==="M"){ mHeld=false; }
  else if(k==="p"||k==="P"){ pHeld=false; requestFrame(); }  // repaint to clear the live box
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVE
// ══════════════════════════════════════════════════════════════════════════════

// A short, self-documenting tag string describing the current mapping — scaling,
// transfer function, palette, dip (when it applies), rotation, flips, and (for
// color) which channels are shown. Appended to "save mapped" filenames so a saved
// PNG says how it was produced. Mirrors the C++ getTranslationParamsString, but
// with readable tokens instead of raw enum ints ("_user_logBright_grey" vs "_s2_f1_m0").
function mappedSuffix() {
  const parts=[SCALE_TAG[S.scaling], FN_TAG[S.imgFn], PALETTE_TAG[S.palette]];
  if(S.imgFn!==ImgFn.OneToOne) parts.push("dip"+S.dipFactor.toFixed(2));
  if(S.rotation) parts.push("rot"+ROT_DEG[S.rotation]);
  if(S.flipH) parts.push("flipH");
  if(S.flipV) parts.push("flipV");
  if(S.image && S.image.numChannels>=3) {
    const ch=(S.channels&CHAN_R?"R":"-")+(S.channels&CHAN_G?"G":"-")+(S.channels&CHAN_B?"B":"-");
    if(ch!=="RGB") parts.push(ch);
  }
  return parts.join("_");
}

// Render the palette-mapped image at native pixel size (rotation applied) to a 2D
// canvas — the pixels the shader produces, no overlay. Shared by save + copy.
function mappedCanvas() {
  const rot=S.rotation;
  const w=(rot===1||rot===3)?S.image.height:S.image.width;
  const h=(rot===1||rot===3)?S.image.width :S.image.height;
  renderer.drawToSize(w,h);
  const out=document.createElement("canvas");
  out.width=w; out.height=h;
  out.getContext("2d").drawImage(glCanvas,0,0,w,h,0,0,w,h);
  sizeCanvases(); requestFrame();
  return out;
}

// Composite the WebGL view + the overlay canvas at the current viewport size — a
// literal screenshot of what's on screen (info box, rulers, ROI, help, and all).
function screenshotCanvas() {
  const out=document.createElement("canvas");
  out.width=glCanvas.width; out.height=glCanvas.height;
  const ctx=out.getContext("2d");
  ctx.drawImage(glCanvas,0,0);
  ctx.drawImage(ovCanvas,0,0);
  return out;
}

// Output MIME + extension for "save mapped": keep the source format when it
// round-trips through canvas (jpeg/webp/png), else PNG; forceJpeg wins.
function mappedMime() {
  const ext=(S.imageUrl.split("?")[0].split(".").pop()||"").toLowerCase();
  const mimeMap={jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",png:"image/png"};
  const mime=S.forceJpeg?"image/jpeg":(mimeMap[ext]||"image/png");
  const extOut=mime==="image/jpeg"?"jpg":mime==="image/webp"?"webp":"png";
  return { mime, extOut };
}

function save(mode) {
  const name=imageBaseName(false);

  if(mode==="original") {
    if(!S.forceJpeg) {
      const filename=imageBaseName(true);
      getSourceBlob(S.imageUrl).then(blob=>env.save(blob,filename));
    } else {
      getSourceBlob(S.imageUrl).then(blob=>{
        const blobUrl=URL.createObjectURL(blob);
        const img=new Image();
        img.onload=()=>{
          const c=document.createElement("canvas");
          c.width=img.naturalWidth; c.height=img.naturalHeight;
          c.getContext("2d").drawImage(img,0,0);
          c.toBlob(b=>{ if(b) env.save(b,`${name}.jpg`); },"image/jpeg",0.95);
          URL.revokeObjectURL(blobUrl);
        };
        img.src=blobUrl;
      });
    }
    return;
  }

  if(mode==="mapped") {
    if(!S.image||!renderer) return;
    const { mime, extOut }=mappedMime();
    mappedCanvas().toBlob(blob=>{
      if(blob) env.save(blob,`${name}_${mappedSuffix()}.${extOut}`);
    },mime,mime==="image/jpeg"?0.95:undefined);
    return;
  }

  // screenshot
  screenshotCanvas().toBlob(blob=>{
    if(blob) env.save(blob,`${name}_screenshot.png`);
  },"image/png");
}

// Copy the mapped image (Ctrl+C) or an on-screen screenshot (Ctrl+Shift+C) to the
// clipboard as PNG. Silent on success (like the C++); logs on failure — the async
// Clipboard API rejects if the document isn't focused or permission is denied.
function copyToClipboard(mode) {
  if(!S.image||!renderer) return;
  const canvas=mode==="screenshot"?screenshotCanvas():mappedCanvas();
  canvas.toBlob(blob=>{
    if(!blob) return;
    Promise.resolve(env.copyImage(blob)).catch(err=>
      console.warn("pxlpeep: clipboard copy failed:", err));
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

// Snap the image to a viewport anchor at the CURRENT zoom (unlike fit/1:1),
// leaving a 5% margin so the anchored corner/edge is clearly framed. Ported
// from the C++ Ctrl+3..7 — handy for checking image quality in the corners.
function positionImage(anchor) {
  if(!S.image) return;
  const rot=S.rotation;
  const dw=((rot===1||rot===3)?S.image.height:S.image.width )*S.zoomFactor;
  const dh=((rot===1||rot===3)?S.image.width :S.image.height)*S.zoomFactor;
  const vw=window.innerWidth, vh=window.innerHeight;
  const m=0.05*Math.min(vw,vh);
  // Top-left is the one corner the toolbar sits in, so clear it: place the corner just right of the
  // toolbar's CURRENT footprint (measured now, so collapsing/expanding it later won't move the image).
  const tb=document.getElementById("pxlpeep-toolbar");
  const tbR=tb&&getComputedStyle(tb).display!=="none" ? tb.getBoundingClientRect() : null;
  const leftClear = tbR ? Math.max(m, tbR.right+m) : m;
  const left=m, right=vw-m-dw, top=m, bottom=vh-m-dh;
  switch(anchor){
    case "center":      S.panX=(vw-dw)/2; S.panY=(vh-dh)/2; break;
    case "topLeft":     S.panX=leftClear; S.panY=top;    break;   // clear the toolbar
    case "topRight":    S.panX=right; S.panY=top;    break;
    case "bottomLeft":  S.panX=left;  S.panY=bottom; break;
    case "bottomRight": S.panX=right; S.panY=bottom; break;
  }
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
    position:"fixed",top:"20px",left:"40px",zIndex:"2147483647", // clear of the top/left rulers
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
    // Don't let a click leave the button focused — otherwise the NEXT keypress (a hotkey) flips it to
    // :focus-visible and paints a bright ring that reads like a stuck "active" state. Keyboard Tab
    // focus still works (and legitimately shows the ring); these buttons all have hotkeys anyway.
    b.addEventListener("mousedown",e=>e.preventDefault());
    b.addEventListener("mouseenter",()=>b.style.background="#555");
    b.addEventListener("mouseleave",()=>b.style.background=b._active?"#fff":"#333");
    b._setActive=(v)=>{
      b._active=v;
      b.style.background=v?"#eee":"#333";
      b.style.color=v?"#000":"#ddd";
    };
    return b;
  };

  // ── Header — the whole title bar IS the collapse toggle. It stays put (same spot, same
  // color) across states, so a click collapses and a click in the same place re-expands;
  // only the body below and the arrow glyph change. "pxlpeep" + arrow sit together at the
  // left in both states, anchored to the box's fixed top-left corner. ──
  const header=document.createElement("div");
  Object.assign(header.style,{display:"flex",alignItems:"center",gap:"6px",cursor:"pointer",userSelect:"none"});
  header.title="Collapse / expand the toolbar";
  const title=document.createElement("span");
  title.textContent="pxlpeep "+PXLPEEP_VERSION; title.style.fontWeight="bold"; title.style.color="#aaa";
  const collapseArrow=document.createElement("span");
  collapseArrow.textContent="▲"; Object.assign(collapseArrow.style,{color:"#aaa",fontSize:"10px"});
  header.appendChild(title); header.appendChild(collapseArrow);
  tb.append(header);

  // Body — everything below the header, hidden as one unit when collapsed (the box then
  // shrinks to just the title bar).
  const body=document.createElement("div");
  Object.assign(body.style,{display:"flex",flexDirection:"column",gap:"5px"});
  tb.append(body);

  // ── Zoom ──
  const zoomInfo=document.createElement("span");
  zoomInfo.style.color="#aaa";
  const zoomRow=row(
    lbl("zoom"),
    btn("fit","[Ctrl+1] Zoom to fit the whole image in the window",()=>{zoomToFit();refresh();}),
    btn("1:1","[Ctrl+2] Zoom to 1:1 — one screen pixel per image pixel",()=>{zoomTo1to1();refresh();}),
    zoomInfo
  );
  body.appendChild(zoomRow);

  // ── Position presets (mirror of Ctrl+3–7) ──
  body.appendChild(row(
    lbl("position"),
    btn("⊙","[Ctrl+3] Center the image in the window",()=>{positionImage("center");refresh();}),
    btn("◤","[Ctrl+4] Anchor the image to the top-left",()=>{positionImage("topLeft");refresh();}),
    btn("◥","[Ctrl+5] Anchor the image to the top-right",()=>{positionImage("topRight");refresh();}),
    btn("◣","[Ctrl+6] Anchor the image to the bottom-left",()=>{positionImage("bottomLeft");refresh();}),
    btn("◢","[Ctrl+7] Anchor the image to the bottom-right",()=>{positionImage("bottomRight");refresh();}),
  ));

  // ── Image (reload; grows to open/paste later) ──
  body.appendChild(row(
    lbl("image"),
    btn("⟳ reload","[F5] Reload the image — re-fetch the pixels, keep zoom/pan and all overlays",()=>{reloadImage();refresh();}),
  ));

  // ── Palette (prev ‹ name › next, like dip — label is the current selection, chevrons act) ──
  const palName=document.createElement("span");
  palName.style.cssText="flex:1;text-align:center;";
  body.appendChild(row(
    lbl("palette"),
    btn("‹","[Shift+V] Previous color palette / false-color LUT",()=>{S.palette=((S.palette-1)%NUM_PALETTES+NUM_PALETTES)%NUM_PALETTES;refresh();}),
    palName,
    btn("›","[V] Next color palette / false-color LUT",()=>{S.palette=((S.palette+1)%NUM_PALETTES+NUM_PALETTES)%NUM_PALETTES;refresh();}),
  ));

  // ── Function ──
  const fnName=document.createElement("span");
  fnName.style.cssText="flex:1;text-align:center;";
  body.appendChild(row(
    lbl("function"),
    btn("‹","[Shift+F] Previous transfer function",()=>{S.imgFn=((S.imgFn-1)%5+5)%5;recalcScale();refresh();}),
    fnName,
    btn("›","[F] Next transfer function",()=>{S.imgFn=((S.imgFn+1)%5+5)%5;recalcScale();refresh();}),
  ));

  // ── Dip factor ──
  const dipVal=document.createElement("span");
  dipVal.style.cssText="flex:1;text-align:center;";
  const dipRow=row(
    lbl("dip"),
    btn("−","[−] Weaken the dip factor — strength of the log/parabolic transfer curve (no effect unless fn is log/parabolic)",()=>{S.dipFactor/=1.25;recalcScale();refresh();}),
    dipVal,
    btn("+","[+] Strengthen the dip factor — strength of the log/parabolic transfer curve (no effect unless fn is log/parabolic)",()=>{S.dipFactor*=1.25;recalcScale();refresh();}),
  );
  body.appendChild(dipRow);

  // ── Scale (segmented: fit vs full range; "full" = 0..max, the honest name for what was
  //    called "user" — see ROADMAP for a real user-settable range) ──
  const scaleInfo=document.createElement("span");
  scaleInfo.style.cssText="font-size:10px;color:#888;";
  const scaleFitBtn =btn("fit", "[S] Fit the display range to the data (auto min/max)",()=>{
    S.scaling=Scaling.Fit; recalcScale(); refresh();
  });
  const scaleFullBtn=btn("full","[S] Use the full value range (0…max)",()=>{
    S.scaling=Scaling.User; S.userMin=0; S.userMax=S.image?(1<<S.image.bpp)-1:255; recalcScale(); refresh();
  });
  body.appendChild(row(lbl("scale"),scaleFitBtn,scaleFullBtn,scaleInfo));

  // ── Channels ──
  const chR=btn("R","[R / Shift+R] Toggle the red channel (Shift solos)",e=>{
    S.channels=e.shiftKey?CHAN_R:(S.channels^CHAN_R)||CHAN_R; requestFrame(); refresh();
  },{color:"#f88"});
  const chG=btn("G","[G / Shift+G] Toggle the green channel (Shift solos)",e=>{
    S.channels=e.shiftKey?CHAN_G:(S.channels^CHAN_G)||CHAN_G; requestFrame(); refresh();
  },{color:"#8f8"});
  const chB=btn("B","[B / Shift+B] Toggle the blue channel (Shift solos)",e=>{
    S.channels=e.shiftKey?CHAN_B:(S.channels^CHAN_B)||CHAN_B; requestFrame(); refresh();
  },{color:"#88f"});
  const chRow=row(lbl("channels"),chR,chG,chB);
  body.appendChild(chRow);

  // ── Rotate/flip ──
  body.appendChild(row(
    lbl("rotate"),
    btn("↺ CCW","[Shift+A] Rotate the view 90° counter-clockwise",()=>{const or=S.rotation,fh=S.flipH,fv=S.flipV;S.rotation=((S.rotation-1)%4+4)%4;retransformOverlays(or,fh,fv);requestFrame();refresh();}),
    btn("↻ CW", "[A] Rotate the view 90° clockwise", ()=>{const or=S.rotation,fh=S.flipH,fv=S.flipV;S.rotation=(S.rotation+1)%4;        retransformOverlays(or,fh,fv);requestFrame();refresh();}),
  ));
  const flipH2=btn("⇄H","[L] Flip the view horizontally",()=>{const or=S.rotation,fh=S.flipH,fv=S.flipV;S.flipH=!S.flipH;retransformOverlays(or,fh,fv);requestFrame();refresh();});
  const flipV2=btn("⇅V","[T] Flip the view vertically",  ()=>{const or=S.rotation,fh=S.flipH,fv=S.flipV;S.flipV=!S.flipV;retransformOverlays(or,fh,fv);requestFrame();refresh();});
  body.appendChild(row(lbl("flip"),flipH2,flipV2));

  // (White balance is key/gesture-only for now — no toolbar row until ROADMAP #12 designs how
  //  the tool family is surfaced. W+drag applies, Alt+W peeks, Shift+W resets.)

  // ── Overlays ──
  const togInfo=btn("info","[I] Toggle the top-right info box",()=>{S.showInfo=!S.showInfo;requestFrame();refresh();});
  const togRul =btn("rulers","[X] Toggle the rulers",()=>{S.showRulers=!S.showRulers;requestFrame();refresh();});
  const togCbar=btn("colorbar","[C] Toggle the color bar",()=>{S.showColorbar=!S.showColorbar;requestFrame();refresh();});
  const togGrid=btn("grid","[D] Toggle the pixel grid (only visible above 64× zoom)",()=>{S.showGrid=!S.showGrid;requestFrame();refresh();});
  body.appendChild(row(lbl("overlays"),togInfo,togRul,togCbar,togGrid));

  // ── Axes / coordinate conventions. flip Y is an on/off toggle (white = flipped); 0-based vs
  //    1-based is a segmented pair (white = the active one) so the current mode is unambiguous. ──
  const flipYBtn=btn("flip Y","[Y] Flip the Y origin to the bottom (math-style axes)",()=>{S.yFlip=!S.yFlip;requestFrame();refresh();});
  const zero0Btn=btn("0-based","[0] Use 0-based pixel coordinates",()=>{S.zeroIdx=true; requestFrame();refresh();});
  const zero1Btn=btn("1-based","[0] Use 1-based pixel coordinates",()=>{S.zeroIdx=false;requestFrame();refresh();});
  body.appendChild(row(lbl("axes"),flipYBtn,zero0Btn,zero1Btn));

  // ── EXIF ──
  const exifDiv=document.createElement("div");
  Object.assign(exifDiv.style,{fontSize:"10px",color:"#888",borderTop:"1px solid #333",paddingTop:"4px"});
  body.appendChild(exifDiv);

  // ── Save ──
  const saveRow=document.createElement("div");
  Object.assign(saveRow.style,{display:"flex",gap:"4px",flexWrap:"wrap",borderTop:"1px solid #333",paddingTop:"4px"});
  saveRow.appendChild(btn("💾 original","[Ctrl+S] Save the original image file, unmodified",()=>save("original")));
  saveRow.appendChild(btn("💾 mapped","[Ctrl+Alt+S] Save the image with the current palette + transfer function baked in",()=>save("mapped")));
  saveRow.appendChild(btn("💾 screenshot","[Ctrl+Shift+S] Save a screenshot of the current view, overlays included",()=>save("screenshot")));
  body.appendChild(saveRow);

  // ── Copy to clipboard (mirror of Ctrl+C / Ctrl+Shift+C) ──
  const copyRow=document.createElement("div");
  Object.assign(copyRow.style,{display:"flex",gap:"4px",flexWrap:"wrap"});
  copyRow.appendChild(btn("📋 mapped","[Ctrl+C] Copy the mapped image to the clipboard",()=>copyToClipboard("mapped")));
  copyRow.appendChild(btn("📋 screenshot","[Ctrl+Shift+C] Copy a screenshot to the clipboard",()=>copyToClipboard("screenshot")));
  body.appendChild(copyRow);

  const jpegRow=document.createElement("label");
  jpegRow.title="[J] Force JPEG output for the original + mapped saves (otherwise the source format is kept)";
  Object.assign(jpegRow.style,{display:"flex",alignItems:"center",gap:"5px",paddingTop:"3px",fontSize:"11px",color:"#ccc",cursor:"pointer"});
  const jpegCb=document.createElement("input");
  jpegCb.type="checkbox"; jpegCb.checked=S.forceJpeg;
  jpegCb.addEventListener("change",()=>{S.forceJpeg=jpegCb.checked;});
  jpegRow.appendChild(jpegCb);
  jpegRow.appendChild(document.createTextNode("Force JPEG output (original + mapped)"));
  body.appendChild(jpegRow);

  // ── Collapse toggle — clicking the header folds the toolbar down to just its title bar
  // ("pxlpeep" + a down arrow) and shrinks the box; clicking it again restores everything.
  // Same element in both states, so nothing anchoring moves. ──
  let collapsed=false;
  const setCollapsed=v=>{
    collapsed=v;
    body.style.display=v?"none":"flex";
    collapseArrow.textContent=v?"▼":"▲";   // ▼ = click to expand, ▲ = click to collapse
    tb.style.minWidth=v?"0":"220px";        // shrink to fit "pxlpeep ▼" when collapsed
  };
  header.addEventListener("click",()=>setCollapsed(!collapsed));

  const refresh=()=>{
    zoomInfo.textContent=S.zoomFactor.toFixed(2)+"×";
    palName.textContent=PALETTE_NAMES[S.palette];
    fnName.textContent=FN_NAMES[S.imgFn];
    dipVal.textContent=S.dipFactor.toFixed(3);
    scaleFitBtn._setActive(S.scaling===Scaling.Fit);
    scaleFullBtn._setActive(S.scaling===Scaling.User);
    scaleInfo.textContent=`${S.scaleMin.toFixed(0)}–${S.scaleMax.toFixed(0)}`;
    flipYBtn._setActive(S.yFlip);
    zero0Btn._setActive(S.zeroIdx);
    zero1Btn._setActive(!S.zeroIdx);
    chR._setActive(!!(S.channels&CHAN_R));
    chG._setActive(!!(S.channels&CHAN_G));
    chB._setActive(!!(S.channels&CHAN_B));
    flipH2._setActive(S.flipH); flipV2._setActive(S.flipV);
    togInfo._setActive(S.showInfo); togRul._setActive(S.showRulers);
    togCbar._setActive(S.showColorbar);
    togGrid._setActive(S.showGrid);
    jpegCb.checked=S.forceJpeg;
    if(S.exif){
      const e=S.exif; let html="";
      const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
      if(e.make)     html+=`<div>${esc(e.make)}</div>`;
      if(e.date)     html+=`<div>${esc(e.date)}</div>`;
      if(e.firmware) html+=`<div>${esc(e.firmware)}</div>`;
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
  const dpr=window.devicePixelRatio||1;
  const w=window.innerWidth, h=window.innerHeight;
  glCanvas.width=w*dpr; glCanvas.height=h*dpr;
  ovCanvas.width=w*dpr; ovCanvas.height=h*dpr;
  renderer?.resize(w*dpr,h*dpr);
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
ovCanvas.style.touchAction="none"; // pointer events: keep touch gestures from canceling drags

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

// ── Status / error overlay ──────────────────────────────────────────────────
// A single centered DOM element (not canvas) so it works before the WebGL
// renderer exists and survives a GL failure. Used for both "Loading…" and errors.
let statusEl=null;
function setStatus(node){
  clearStatus();
  statusEl=document.createElement("div");
  Object.assign(statusEl.style,{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
    zIndex:"2147483647",color:"#eee",background:"#222",padding:"20px 24px",borderRadius:"8px",
    font:"14px/1.5 system-ui,sans-serif",textAlign:"center",maxWidth:"80vw",
    boxShadow:"0 4px 24px rgba(0,0,0,.5)"});
  if(typeof node==="string") statusEl.textContent=node; else statusEl.appendChild(node);
  document.body.appendChild(statusEl);
}
function clearStatus(){ statusEl?.remove(); statusEl=null; }

// Called by getSourceBlob between backoff attempts; only updates the loading
// overlay if it's currently showing (never pops UI on a cached/save refetch).
function reportRetry(status, attempt, waitMs){
  if(!statusEl) return;
  setStatus(`Server busy (HTTP ${status}) — retrying in ${Math.ceil(waitMs/1000)}s… (attempt ${attempt}/${MAX_RETRIES})`);
}

function errorMessage(err){
  if(err?.kind==="http"){
    if(err.status===503||err.status===429) return `${err.message}.\nThe host may be throttling requests — try again in a moment.`;
    if(err.status===404) return `${err.message}.\nThe image no longer exists at this URL.`;
    if(err.status===403) return `${err.message}.\nAccess to this image was denied.`;
    return err.message+".";
  }
  if(err?.kind) return err.message+".";
  return "Failed to load image.";
}
function showLoadError(err){
  const box=document.createElement("div");
  const msg=document.createElement("div");
  msg.textContent=errorMessage(err);
  msg.style.whiteSpace="pre-line";
  const url=document.createElement("div");
  url.textContent=S.imagePath;
  Object.assign(url.style,{marginTop:"10px",color:"#888",fontSize:"11px",wordBreak:"break-all"});
  const retry=document.createElement("button");
  retry.textContent="Retry";
  Object.assign(retry.style,{marginTop:"14px",padding:"6px 18px",cursor:"pointer",
    border:"1px solid #555",borderRadius:"6px",background:"#333",color:"#eee",font:"13px system-ui,sans-serif"});
  retry.onclick=()=>startLoad();
  box.append(msg,url,retry);
  setStatus(box);
}

function startLoad(keepView){
  setStatus("Loading…");
  loadImage(S.imageUrl).then(img=>{
    clearStatus();
    S.image=img;
    S.userMin=0; S.userMax=(1<<img.bpp)-1;
    recalcScale();
    renderer?.upload(img.data, img.width, img.height, img.numChannels);
    if(!keepView) zoomToFit();   // reload keeps the current zoom/pan; only the initial open fits
    refreshToolbar();
    requestFrame();
  }).catch(showLoadError);

  // EXIF async (best-effort; shares the single fetch, never surfaces errors)
  extractExif(S.imageUrl).then(exif=>{
    if(exif){S.exif=exif; refreshToolbar();}
  });
}

// Reload (Ctrl+R / F5 on desktop; the toolbar ⟳ button in both shells): drop the memoized
// source blob and re-run the full load — re-fetch, re-decode, re-parse EXIF — but change
// NOTHING else. keepView=true preserves the current zoom/pan, and every overlay (measures,
// pins, WB box) is left untouched, even if a reloaded image with new dimensions leaves them
// off-image. This is the "stop-motion" debug loop: rewrite the file, reload, see the result
// on the very same pixels (see MOTIVATION.md → camera calibration; ROADMAP #14 auto-reload).
function reloadImage(){
  _sourceBlobPromise = null;
  startLoad(true);
}
startLoad();

// ── Mouse events ──────────────────────────────────────────────────────────────
// Pointer events (not mouse events) so drags can capture the pointer: pan/ROI
// keep tracking outside the window, and the release is always delivered — with
// mouse events, a mouseup outside the window left the drag stuck "on".
let panDrag=null, wbDrag=null, measureDrag=null, wheelAcc=0;
// Held tool-modifier keys (set/cleared by the keyboard handlers + window blur); a left
// drag/click means WB / measure / latch depending on which is down, else pan.
let wHeld=false, mHeld=false, pHeld=false, wDragged=false;

const snapCorner=(v,max)=>Math.max(0,Math.min(max,Math.round(v)));           // pixel EDGE (WB encloses whole pixels)
const snapCentre=(v,max)=>Math.max(0.5,Math.min(max-0.5,Math.floor(v)+0.5)); // pixel CENTRE (measure / latch)

function endDrag() {
  panDrag=null; wbDrag=null; measureDrag=null;
  ovCanvas.style.cursor="crosshair";
}

ovCanvas.addEventListener("pointerdown",e=>{
  if(e.button!==0) return;
  try { ovCanvas.setPointerCapture(e.pointerId); } catch {} // pointer may already be gone
  const img=S.image;
  const [ix,iy]=viewToImg(e.clientX,e.clientY);
  if(wHeld && img) {                       // WB: corner-snapped box, applied on release
    wDragged=true;
    const x=snapCorner(ix,img.width), y=snapCorner(iy,img.height);
    wbDrag={x0:x,y0:y}; S.wbBox={x1:x,y1:y,x2:x,y2:y};
  } else if(mHeld && img) {                // measure: centre-snapped line
    const x=snapCentre(ix,img.width), y=snapCentre(iy,img.height);
    measureDrag={x1:x,y1:y,x2:x,y2:y};
  } else if(pHeld && img) {                // latch a frozen cursor box, centre-snapped + clamped to the image (like measure)
    addLatched(snapCentre(ix,img.width), snapCentre(iy,img.height));
  } else {                                 // pan
    panDrag={sx:e.clientX,sy:e.clientY,px:S.panX,py:S.panY};
    ovCanvas.style.cursor="grabbing";
  }
  e.preventDefault(); requestFrame();
});

ovCanvas.addEventListener("pointermove",e=>{
  S.cursorX=e.clientX; S.cursorY=e.clientY;
  // Self-heal: if the button was released where we couldn't see it, end the drag.
  if((panDrag||wbDrag||measureDrag)&&!(e.buttons&1)) endDrag();
  const img=S.image;
  if(panDrag) {
    S.panX=panDrag.px+(e.clientX-panDrag.sx);
    S.panY=panDrag.py+(e.clientY-panDrag.sy);
  } else if(wbDrag && img) {
    const [ix,iy]=viewToImg(e.clientX,e.clientY);
    S.wbBox={x1:wbDrag.x0,y1:wbDrag.y0,x2:snapCorner(ix,img.width),y2:snapCorner(iy,img.height)};
  } else if(measureDrag && img) {
    const [ix,iy]=viewToImg(e.clientX,e.clientY);
    measureDrag.x2=snapCentre(ix,img.width); measureDrag.y2=snapCentre(iy,img.height);
  }
  requestFrame();
});

ovCanvas.addEventListener("pointerup",e=>{
  if(wbDrag) {
    const b=S.wbBox;
    if(b && Math.abs(b.x2-b.x1)>=1 && Math.abs(b.y2-b.y1)>=1) applyWBFromBox();
    else S.wbBox=null;                     // zero-size: discard
  } else if(measureDrag) {
    const m=measureDrag;
    if(Math.abs(m.x2-m.x1)>=1 || Math.abs(m.y2-m.y1)>=1) addMeasure({...m});   // carry cxSign/cySign
  }
  endDrag(); refreshToolbar(); requestFrame();
});
ovCanvas.addEventListener("pointercancel",endDrag);

ovCanvas.addEventListener("contextmenu",e=>e.preventDefault());

// Wheel (non-passive)
ovCanvas.addEventListener("wheel",e=>{
  e.preventDefault();
  wheelAcc+=e.deltaY;
  if(wheelAcc<-DELTA_THRESH){wheelAcc=0;zoomAt(+1,e.clientX,e.clientY);refreshToolbar();}
  else if(wheelAcc>DELTA_THRESH){wheelAcc=0;zoomAt(-1,e.clientX,e.clientY);refreshToolbar();}
},{passive:false});

// Keyboard
window.addEventListener("keydown",onKeyDown);
window.addEventListener("keyup",onKeyUp);
// Never leave a tool key "stuck" if we miss its keyup (focus lost mid-hold).
window.addEventListener("blur",()=>{ wHeld=mHeld=pHeld=false; S.wbPeek=false; requestFrame(); });

// Resize
window.addEventListener("resize",()=>{sizeCanvases();requestFrame();});

// Test hooks
window.__pxlpeep = { S, env, PXLPEEP_VERSION, computeWBColor, computeWBGrey, recalcScale, recomputeMinMax, loadImage, zoomToFit, zoomTo1to1, pixelReadout, mappedSuffix, save, copyToClipboard, reloadImage, applyWBFromBox, revertWB, escClear, addMeasure, addLatched, openCalibration, unitSuffix, retransformOverlays, dispToRaw, rawToDisp, cursorLines };

// Initial frame
requestFrame();
