// Frink (Freeze + ink) v0.4 — frontend
// Modos: 'screen' (congelar pantalla) e 'image' (lámina: anotar un archivo de
// imagen a resolución nativa; Enter exporta PNG + JSON y deja AMBOS archivos en
// el portapapeles). En modo lámina: rueda = zoom, espacio o botón central = mover.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;

const appWindow = getCurrentWindow();
const bg = document.getElementById("bg");
const fxc = document.getElementById("fx"); // fondo con los efectos de las órdenes aplicados
const fxctx = fxc.getContext("2d");
const board = document.getElementById("board");
const sel = document.getElementById("selection");
const hint = document.getElementById("hint");
const toolbar = document.getElementById("toolbar");
const droppanel = document.getElementById("droppanel");
const fileinput = document.getElementById("fileinput");
const mcpPrompt = document.getElementById("mcpprompt");
const ctx = board.getContext("2d");

const DEST_FOLDER = ""; // vacío = Imágenes/Frink
const EXPORT_SCALE = 2; // solo modo pantalla; la lámina ya sale a resolución nativa

// --- Estado ---
let capMode = "screen"; // 'screen' | 'image' (lámina)
let sourceName = "";
let sourcePath = "";
let bgReady = false;
let region = null;      // { x, y, w, h } en px de la IMAGEN original
let selecting = false;  // en lámina, la zona solo se elige tras pulsar ⛶/R
let mode = null;        // 'select' | 'draw' | null
let startImg = null;    // inicio de selección (px de imagen)
let shapes = [];        // modelo vectorial (px de imagen)
let current = null;
let poly = null;
let polyCursor = null;
let textInput = null;
let spaceDown = false;  // espacio = herramienta mano
let panning = null;

let tool = "pen";
let color = "#ff6f8b";
let size = 5;           // grosor lógico (px de pantalla al trazar)
let fillOn = false;     // relleno para rectángulo/elipse
let pendingOrder = null; // orden armada desde la paleta: la siguiente zona la lleva
let dimState = null;     // cota en curso: { p1, cursor }
let floatEl = null;      // input flotante genérico (cota, reemplaza…)
let floatCb = null;

// Paleta de órdenes: intención DECLARADA, no inferida. kind area = rodear zona;
// kind line = trazar una guía.
const ORDERS = {
  borra:        { label: "BORRA ESTO", kind: "area" },
  blur:         { label: "PIXELA / BLUR", kind: "area" },
  aclara:       { label: "ACLARA", kind: "area" },
  oscurece:     { label: "OSCURECE", kind: "area" },
  mas_color:    { label: "MÁS COLOR", kind: "area" },
  menos_color:  { label: "MENOS COLOR", kind: "area" },
  cambia_color: { label: "CAMBIA COLOR A…", kind: "area", usesColor: true },
  reemplaza:    { label: "REEMPLAZA POR…", kind: "area", needsText: true },
  manten:       { label: "MANTÉN ESTO", kind: "area" },
  pregunta:     { label: "¿QUÉ ES ESTO?", kind: "area" },
  linea_fuga:   { label: "LÍNEA DE FUGA", kind: "line" },
  horizonte:    { label: "HORIZONTE", kind: "line" },
  cine_guia:    { label: "CIÑE A ESTA GUÍA", kind: "line" },
};

// --- Vista: rectángulo lógico de ventana donde se muestra la imagen ---
let view = { ox: 0, oy: 0, dw: 1, dh: 1 };
let fitScale = 1;
const kx = () => bg.naturalWidth / view.dw;
const ky = () => bg.naturalHeight / view.dh;
const toPhys = (e) => ({
  x: (e.clientX - view.ox) * kx(),
  y: (e.clientY - view.oy) * ky(),
});
const inView = (e) =>
  e.clientX >= view.ox && e.clientX <= view.ox + view.dw &&
  e.clientY >= view.oy && e.clientY <= view.oy + view.dh;

function applyView() {
  for (const el of [bg, fxc, board]) {
    el.style.left = view.ox + "px";
    el.style.top = view.oy + "px";
    el.style.width = view.dw + "px";
    el.style.height = view.dh + "px";
  }
  updateSel();
}

function updateSel() {
  if (!region) { sel.hidden = true; return; }
  const fx = kx(), fy = ky();
  sel.style.left = view.ox + region.x / fx + "px";
  sel.style.top = view.oy + region.y / fy + "px";
  sel.style.width = region.w / fx + "px";
  sel.style.height = region.h / fy + "px";
  sel.hidden = false;
}

function layout() {
  if (!bg.naturalWidth) return;
  if (capMode === "screen") {
    view = { ox: 0, oy: 0, dw: window.innerWidth, dh: window.innerHeight };
    fitScale = view.dw / bg.naturalWidth;
  } else {
    const mx = 46, myTop = 64, myBot = 56;
    const availW = window.innerWidth - mx * 2;
    const availH = window.innerHeight - myTop - myBot;
    const s = Math.min(availW / bg.naturalWidth, availH / bg.naturalHeight);
    fitScale = s;
    const dw = bg.naturalWidth * s;
    const dh = bg.naturalHeight * s;
    view = {
      ox: (window.innerWidth - dw) / 2,
      oy: myTop + (availH - dh) / 2,
      dw, dh,
    };
  }
  applyView();
}
window.addEventListener("resize", layout);

function setupBoard() {
  board.width = bg.naturalWidth;
  board.height = bg.naturalHeight;
  fxc.width = bg.naturalWidth;
  fxc.height = bg.naturalHeight;
  redraw();
}

function onBgLoad() {
  bgReady = true;
  fxSig = "";
  layout();
  setupBoard();
  updateHint();
}

// ---------- Zoom (rueda) y mano (espacio / botón central) — modo lámina ----------
window.addEventListener(
  "wheel",
  (e) => {
    if (capMode !== "image" || !bgReady) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = (view.dw * f) / bg.naturalWidth;
    if (newScale < fitScale * 0.4 || newScale > 8) return;
    view.ox = e.clientX - (e.clientX - view.ox) * f;
    view.oy = e.clientY - (e.clientY - view.oy) * f;
    view.dw *= f;
    view.dh *= f;
    applyView();
  },
  { passive: false }
);

window.addEventListener("mousedown", (e) => {
  if (capMode !== "image" || !bgReady) return;
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    panning = { sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
    document.body.style.cursor = "grabbing";
  }
});

// ---------- Redibujado vectorial ----------
// Cada shape guarda su grosor/tamaño en px de IMAGEN (fijado al crearlo),
// así el zoom posterior no altera lo ya dibujado.
function strokeWidth(shape) {
  if (shape.type === "rect" || shape.type === "ellipse") return shape.sw;
  if (shape.type === "marker") return shape.w * 3.2;
  if (shape.type === "erase") return shape.w * 4.5;
  return shape.w;
}

function drawPath(c, pts) {
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  if (pts.length < 3) {
    for (const p of pts) c.lineTo(p.x, p.y);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  c.stroke();
}

// Etiqueta legible sobre la imagen (chip de color con texto blanco)
function drawLabel(c, x, y, text, color, px) {
  c.save();
  c.font = `700 ${px}px system-ui, -apple-system, sans-serif`;
  const w = c.measureText(text).width;
  const pad = px * 0.45;
  c.fillStyle = color;
  c.globalAlpha = 0.92;
  c.beginPath();
  c.roundRect(x - pad, y - px - pad, w + pad * 2, px + pad * 2, px * 0.35);
  c.fill();
  c.globalAlpha = 1;
  c.fillStyle = "#fff";
  c.textBaseline = "bottom";
  c.fillText(text, x, y + pad * 0.2);
  c.restore();
}


// ================== Órdenes que SE EJECUTAN sobre la imagen ==================
// Estas órdenes no son solo una etiqueta para la IA: aplican el efecto de verdad
// sobre el fondo, dentro del polígono dibujado. Siguen yendo al JSON igualmente.
const EFFECT_ORDERS = new Set([
  "borra", "blur", "aclara", "oscurece", "mas_color", "menos_color", "cambia_color",
]);
const isEffect = (s) =>
  s.type === "order" && EFFECT_ORDERS.has(s.order) && s.points && s.points.length > 2;

function polyBBox(pts, W, H, pad = 0) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x; if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x; if (p.y > y2) y2 = p.y;
  }
  const px = (x2 - x1) * pad, py = (y2 - y1) * pad;
  x1 = Math.max(0, Math.floor(x1 - px)); y1 = Math.max(0, Math.floor(y1 - py));
  x2 = Math.min(W, Math.ceil(x2 + px)); y2 = Math.min(H, Math.ceil(y2 + py));
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

function newCanvas(w, h) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

function tracePoly(c, pts, ox = 0, oy = 0) {
  c.beginPath();
  c.moveTo(pts[0].x - ox, pts[0].y - oy);
  for (const p of pts.slice(1)) c.lineTo(p.x - ox, p.y - oy);
  c.closePath();
}

// Máscara del polígono dentro de su bbox (alpha 0..255)
function polyMask(pts, b) {
  const m = newCanvas(b.w, b.h);
  const mc = m.getContext("2d");
  mc.fillStyle = "#fff";
  tracePoly(mc, pts, b.x, b.y);
  mc.fill();
  return mc.getImageData(0, 0, b.w, b.h).data;
}

// Ajuste por píxel (brillo/saturación/color) solo dentro del polígono
function pixelEffect(c, s, W, H) {
  const b = polyBBox(s.points, W, H);
  if (b.w < 1 || b.h < 1) return;
  const mask = polyMask(s.points, b);
  const img = c.getImageData(b.x, b.y, b.w, b.h);
  const d = img.data;
  let tr = 0, tg = 0, tb = 0;
  if (s.order === "cambia_color") {
    const hx = (s.target_color || s.color || "#ff0000").replace("#", "");
    tr = parseInt(hx.slice(0, 2), 16); tg = parseInt(hx.slice(2, 4), 16); tb = parseInt(hx.slice(4, 6), 16);
  }
  const tl = 0.299 * tr + 0.587 * tg + 0.114 * tb || 1;
  for (let i = 0; i < d.length; i += 4) {
    const a = mask[i + 3] / 255;
    if (a === 0) continue;
    let r = d[i], g = d[i + 1], bl = d[i + 2];
    let nr = r, ng = g, nb = bl;
    const L = 0.299 * r + 0.587 * g + 0.114 * bl;
    switch (s.order) {
      case "aclara":   nr = r + (255 - r) * 0.45; ng = g + (255 - g) * 0.45; nb = bl + (255 - bl) * 0.45; break;
      case "oscurece": nr = r * 0.5; ng = g * 0.5; nb = bl * 0.5; break;
      case "mas_color":   nr = L + (r - L) * 1.9; ng = L + (g - L) * 1.9; nb = L + (bl - L) * 1.9; break;
      case "menos_color": nr = L + (r - L) * 0.15; ng = L + (g - L) * 0.15; nb = L + (bl - L) * 0.15; break;
      case "cambia_color": { // conserva la luz, adopta el color
        const k = L / tl;
        nr = tr * k; ng = tg * k; nb = tb * k; break;
      }
    }
    d[i] = r + (Math.min(255, Math.max(0, nr)) - r) * a;
    d[i + 1] = g + (Math.min(255, Math.max(0, ng)) - g) * a;
    d[i + 2] = bl + (Math.min(255, Math.max(0, nb)) - bl) * a;
  }
  c.putImageData(img, b.x, b.y);
}

// PIXELA: mosaico dentro del polígono. La reducción se hace a mitades sucesivas
// para PROMEDIAR de verdad (un texto pixelado queda ilegible, no "muestreado").
function downscaleAvg(src, sx, sy, sw, sh, tw, th) {
  let cur = newCanvas(sw, sh);
  cur.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  while (cur.width / 2 >= tw && cur.height / 2 >= th) {
    const nx = newCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
    const c2 = nx.getContext("2d");
    c2.imageSmoothingEnabled = true;
    c2.imageSmoothingQuality = "high";
    c2.drawImage(cur, 0, 0, nx.width, nx.height);
    cur = nx;
  }
  const out = newCanvas(tw, th);
  const oc = out.getContext("2d");
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = "high";
  oc.drawImage(cur, 0, 0, tw, th);
  return out;
}

function pixelate(c, s, W, H) {
  const b = polyBBox(s.points, W, H);
  if (b.w < 2 || b.h < 2) return;
  const block = Math.max(8, Math.round(Math.max(b.w, b.h) / 24));
  const tw = Math.max(1, Math.ceil(b.w / block)), th = Math.max(1, Math.ceil(b.h / block));
  const small = downscaleAvg(c.canvas, b.x, b.y, b.w, b.h, tw, th);
  c.save();
  tracePoly(c, s.points);
  c.clip();
  c.imageSmoothingEnabled = false;
  c.drawImage(small, 0, 0, tw, th, b.x, b.y, tw * block, th * block);
  c.restore();
  c.imageSmoothingEnabled = true;
}

// BORRA: elimina el contenido y lo rellena con el entorno (relleno push-pull:
// promedia hacia dentro los colores del borde, sin rastro del objeto)
function eraseFill(c, s, W, H) {
  const b = polyBBox(s.points, W, H, 0.35);
  if (b.w < 2 || b.h < 2) return;
  const base = newCanvas(b.w, b.h);
  const bc = base.getContext("2d");
  bc.drawImage(c.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  // agujero: fuera el contenido del polígono (algo dilatado para no arrastrar bordes)
  bc.globalCompositeOperation = "destination-out";
  bc.lineWidth = Math.max(4, Math.min(b.w, b.h) * 0.03);
  bc.lineJoin = "round";
  tracePoly(bc, s.points, b.x, b.y);
  bc.fill();
  bc.stroke();
  bc.globalCompositeOperation = "source-over";
  // pirámide: bajar a 1 px y volver rellenando huecos con el nivel grueso
  const levels = [base];
  while (levels[levels.length - 1].width > 1 || levels[levels.length - 1].height > 1) {
    const prev = levels[levels.length - 1];
    const nx = newCanvas(Math.max(1, prev.width >> 1), Math.max(1, prev.height >> 1));
    const ncx = nx.getContext("2d");
    ncx.imageSmoothingEnabled = true;
    ncx.drawImage(prev, 0, 0, nx.width, nx.height);
    levels.push(nx);
  }
  for (let i = levels.length - 2; i >= 0; i--) {
    const lv = levels[i].getContext("2d");
    lv.globalCompositeOperation = "destination-over";
    lv.imageSmoothingEnabled = true;
    // varias pasadas: el nivel grueso rellena lo que quede semitransparente
    for (let k = 0; k < 3; k++) lv.drawImage(levels[i + 1], 0, 0, levels[i].width, levels[i].height);
    lv.globalCompositeOperation = "source-over";
  }
  // Refinado: difusión armónica dentro del hueco, resuelta de lo grueso a lo
  // fino (multimalla): reconstruye los degradados del entorno sin fantasmas.
  const holeAt = (gw, gh) => {
    const sc = gw / b.w;
    const hole = newCanvas(gw, gh), hc = hole.getContext("2d");
    hc.fillStyle = "#fff"; hc.strokeStyle = "#fff";
    hc.lineWidth = Math.max(1, bc.lineWidth * sc);
    hc.save(); hc.scale(sc, gh / b.h); tracePoly(hc, s.points, b.x, b.y); hc.restore();
    hc.fill(); hc.stroke();
    return hc.getImageData(0, 0, gw, gh).data;
  };
  const maxSide = Math.max(b.w, b.h);
  const finest = Math.min(1, 180 / maxSide);
  const scales = [];
  for (let s2 = finest; Math.max(b.w, b.h) * s2 >= 12; s2 /= 2) scales.unshift(s2);
  if (!scales.length) scales.push(finest);
  let prev = null;
  let g = null;
  for (const sc of scales) {
    const gw = Math.max(3, Math.round(b.w * sc)), gh = Math.max(3, Math.round(b.h * sc));
    g = newCanvas(gw, gh);
    const gc = g.getContext("2d");
    gc.imageSmoothingEnabled = true;
    gc.drawImage(levels[0], 0, 0, gw, gh);           // entorno real (y relleno inicial)
    const hm = holeAt(gw, gh);
    if (prev) {                                       // dentro del hueco: parte del nivel grueso
      const up = newCanvas(gw, gh), uc = up.getContext("2d");
      uc.imageSmoothingEnabled = true;
      uc.drawImage(prev, 0, 0, gw, gh);
      const ud = uc.getImageData(0, 0, gw, gh).data;
      const gi0 = gc.getImageData(0, 0, gw, gh);
      for (let i = 0; i < hm.length; i += 4) if (hm[i + 3] > 0) {
        gi0.data[i] = ud[i]; gi0.data[i + 1] = ud[i + 1]; gi0.data[i + 2] = ud[i + 2];
      }
      gc.putImageData(gi0, 0, 0);
    }
    const gi = gc.getImageData(0, 0, gw, gh), gd = gi.data;
    const idx = [];
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++)
      if (hm[(y * gw + x) * 4 + 3] > 0) idx.push((y * gw + x) * 4);
    const row = gw * 4;
    for (let it = 0; it < 250; it++) {
      for (const i of idx) for (let ch = 0; ch < 3; ch++)
        gd[i + ch] = (gd[i - 4 + ch] + gd[i + 4 + ch] + gd[i - row + ch] + gd[i + row + ch]) / 4;
    }
    gc.putImageData(gi, 0, 0);
    prev = g;
  }
  // Pasada final a resolución completa: costura invisible con el entorno.
  const F = newCanvas(b.w, b.h), Fc = F.getContext("2d");
  Fc.drawImage(levels[0], 0, 0);
  const hmF = holeAt(b.w, b.h);
  const up = newCanvas(b.w, b.h), upc = up.getContext("2d");
  upc.imageSmoothingEnabled = true;
  upc.imageSmoothingQuality = "high";
  upc.drawImage(g, 0, 0, b.w, b.h);
  const ud = upc.getImageData(0, 0, b.w, b.h).data;
  const Fi = Fc.getImageData(0, 0, b.w, b.h), Fd = Fi.data;
  const fidx = [];
  for (let y = 1; y < b.h - 1; y++) for (let x = 1; x < b.w - 1; x++) {
    const i = (y * b.w + x) * 4;
    if (hmF[i + 3] > 0) {
      Fd[i] = ud[i]; Fd[i + 1] = ud[i + 1]; Fd[i + 2] = ud[i + 2]; Fd[i + 3] = 255;
      fidx.push(i);
    }
  }
  const frow = b.w * 4;
  const iters = fidx.length < 400000 ? 80 : 20;
  for (let it = 0; it < iters; it++) {
    // alternar el sentido del barrido evita sesgos diagonales
    if (it % 2 === 0) {
      for (let k = 0; k < fidx.length; k++) { const i = fidx[k];
        for (let ch = 0; ch < 3; ch++) Fd[i + ch] = (Fd[i - 4 + ch] + Fd[i + 4 + ch] + Fd[i - frow + ch] + Fd[i + frow + ch]) / 4; }
    } else {
      for (let k = fidx.length - 1; k >= 0; k--) { const i = fidx[k];
        for (let ch = 0; ch < 3; ch++) Fd[i + ch] = (Fd[i - 4 + ch] + Fd[i + 4 + ch] + Fd[i - frow + ch] + Fd[i + frow + ch]) / 4; }
    }
  }
  Fc.putImageData(Fi, 0, 0);
  // composición: F ya contiene el original fuera del hueco, sin costuras
  c.save();
  tracePoly(c, s.points);
  c.clip();
  c.drawImage(F, b.x, b.y);
  c.restore();
}

// Fondo final = imagen + efectos de las órdenes, respetando MANTÉN ESTO
function renderBase(c) {
  const W = c.canvas.width, H = c.canvas.height;
  c.clearRect(0, 0, W, H);
  c.drawImage(bg, 0, 0, W, H);
  let any = false;
  for (const s of shapes) {
    if (!isEffect(s)) continue;
    any = true;
    if (s.order === "borra") eraseFill(c, s, W, H);
    else if (s.order === "blur") pixelate(c, s, W, H);
    else pixelEffect(c, s, W, H);
  }
  if (!any) return false;
  // MANTÉN ESTO: esas zonas vuelven a la imagen original
  for (const s of shapes) {
    if (s.type === "order" && s.order === "manten" && s.points.length > 2) {
      c.save();
      tracePoly(c, s.points);
      c.clip();
      c.clearRect(0, 0, W, H);
      c.drawImage(bg, 0, 0, W, H);
      c.restore();
    }
  }
  return true;
}

function refreshFx() {
  if (!bgReady || !fxc.width) return;
  const any = shapes.some(isEffect);
  fxc.style.visibility = any ? "visible" : "hidden";
  if (any) renderBase(fxctx);
}
// ==============================================================================

function renderShape(c, s, forExport = false) {
  c.save();
  c.lineCap = "round";
  c.lineJoin = "round";
  if (s.type === "erase") {
    c.globalCompositeOperation = "destination-out";
    c.strokeStyle = "rgba(0,0,0,1)";
  } else {
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    if (s.type === "marker") c.globalAlpha = 0.4;
  }
  c.lineWidth = strokeWidth(s);

  if (s.type === "text") {
    c.font = `600 ${s.fpx}px system-ui, -apple-system, sans-serif`;
    c.textBaseline = "top";
    c.fillText(s.text, s.x, s.y);
  } else if (s.type === "poly") {
    c.beginPath();
    c.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points.slice(1)) c.lineTo(p.x, p.y);
    c.stroke();
  } else if (s.type === "spline") {
    // Catmull-Rom: curva suave que PASA por todos los puntos
    const pts = s.points;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      c.lineTo(pts[1].x, pts[1].y);
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        c.bezierCurveTo(
          p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
          p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
          p2.x, p2.y
        );
      }
    }
    c.stroke();
  } else if (s.type === "rect" || s.type === "ellipse") {
    c.beginPath();
    if (s.type === "rect") {
      c.rect(s.x, s.y, s.w, s.h);
    } else {
      c.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
    }
    if (s.fill) c.fill();
    else c.stroke();
  } else if (s.type === "dimension") {
    const { p1, p2 } = s;
    c.beginPath();
    c.moveTo(p1.x, p1.y);
    c.lineTo(p2.x, p2.y);
    c.stroke();
    // ticks perpendiculares en los extremos (estilo cota de plano)
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const L = Math.hypot(dx, dy) || 1;
    const t = s.lpx * 0.5;
    const nx = -dy / L, ny = dx / L;
    for (const p of [p1, p2]) {
      c.beginPath();
      c.moveTo(p.x - nx * t, p.y - ny * t);
      c.lineTo(p.x + nx * t, p.y + ny * t);
      c.stroke();
    }
    const label =
      (s.length != null ? `${s.length} ${s.unit}` : "¿?") +
      (s.note ? " · " + s.note : "");
    drawLabel(c, (p1.x + p2.x) / 2 + nx * t * 2, (p1.y + p2.y) / 2 + ny * t * 2, label, s.color, s.lpx);
  } else if (s.type === "order") {
    // las órdenes ejecutadas ya se ven en la imagen: en el PNG exportado no
    // llevan contorno ni etiqueta (quedan documentadas en el JSON)
    if (forExport && (isEffect(s) || s.order === "manten")) { c.restore(); return; }
    c.setLineDash([s.lpx * 0.7, s.lpx * 0.45]);
    c.beginPath();
    c.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points.slice(1)) c.lineTo(p.x, p.y);
    if (s.kind === "area" && s.points.length > 2) {
      c.closePath();
      c.stroke();
      if (!isEffect(s)) { // relleno suave solo en las órdenes para la IA
        c.globalAlpha = 0.1;
        c.fill();
        c.globalAlpha = 1;
      }
    } else {
      c.stroke();
    }
    c.setLineDash([]);
    let label = s.label;
    if (s.text) label += ": " + s.text;
    if (s.target_color) label += " " + s.target_color;
    drawLabel(c, s.points[0].x, s.points[0].y - s.lpx * 0.6, label, s.color, s.lpx);
  } else if (s.points && s.points.length) {
    drawPath(c, s.points);
  }
  c.restore();
}

// Los efectos se recalculan solo cuando cambia el conjunto de órdenes terminadas
// (no en cada movimiento del ratón mientras se dibuja una).
let fxSig = "";
function effectSignature() {
  const done = shapes.filter(
    (s) => (isEffect(s) || (s.type === "order" && s.order === "manten")) &&
      !(mode === "order" && s === current)
  );
  return (bg.src || "").length + "|" + done.map((s) =>
    s.order + ":" + s.points.length + ":" + (s.target_color || "") + ":" +
    Math.round(s.points[0].x) + "," + Math.round(s.points[0].y)).join(";");
}
function redraw() {
  const sig = effectSignature();
  if (sig !== fxSig) { fxSig = sig; refreshFx(); }
  ctx.clearRect(0, 0, board.width, board.height);
  for (const s of shapes) renderShape(ctx, s);
  if (dimState && dimState.cursor) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, size * kx() * 0.5);
    ctx.setLineDash([8 * kx(), 8 * kx()]);
    ctx.beginPath();
    ctx.moveTo(dimState.p1.x, dimState.p1.y);
    ctx.lineTo(dimState.cursor.x, dimState.cursor.y);
    ctx.stroke();
    ctx.restore();
  }
  if (poly && poly.points.length) {
    renderShape(ctx, poly);
    if (polyCursor) {
      ctx.save();
      ctx.strokeStyle = poly.color;
      ctx.lineWidth = strokeWidth(poly);
      ctx.lineCap = "round";
      ctx.setLineDash([8 * kx(), 8 * kx()]);
      ctx.beginPath();
      const last = poly.points[poly.points.length - 1];
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(polyCursor.x, polyCursor.y);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ---------- Reset común ----------
function resetSession() {
  shapes = [];
  current = null;
  cancelPoly();
  removeTextInput(false);
  closeFloat(false);
  pendingOrder = null;
  dimState = null;
  const ob = document.getElementById("orders");
  if (ob) ob.classList.remove("active");
  const om = document.getElementById("ordermenu");
  if (om) om.hidden = true;
  region = null;
  selecting = false;
  mode = null;
  panning = null;
  spaceDown = false;
  document.body.style.cursor = "";
  sel.hidden = true;
  mcpPrompt.hidden = true;
  bgReady = false;
}

// ---------- Modo pantalla ----------
listen("start-capture", async () => {
  resetSession();
  capMode = "screen";
  document.body.classList.remove("lamina");
  document.body.classList.remove("dropmode");
  droppanel.hidden = true;
  sourceName = "";
  sourcePath = "";
  try {
    const b64 = await invoke("grab_screen");
    bg.onload = onBgLoad;
    bg.src = "data:image/png;base64," + b64;
  } catch (e) {
    console.error("grab_screen falló:", e);
  }
  updateHint();
});

// ---------- Modo lámina ----------
listen("start-file-mode", () => {
  resetSession();
  capMode = "image";
  document.body.classList.add("lamina");
  document.body.classList.add("dropmode"); // ventana pequeña: oculta barra y ayuda
  bg.removeAttribute("src");
  droppanel.hidden = false;
  sourceName = "";
  sourcePath = "";
  updateHint();
});

// Controles de la ventana pequeña
document.getElementById("dp-min").addEventListener("click", (e) => {
  e.stopPropagation();
  appWindow.minimize();
});
document.getElementById("dp-close").addEventListener("click", (e) => {
  e.stopPropagation();
  appWindow.hide();
});

function mimeFromExt(p) {
  p = p.toLowerCase();
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".bmp")) return "image/bmp";
  if (p.endsWith(".gif")) return "image/gif";
  return "image/png";
}

async function setLamina(dataUrl) {
  droppanel.hidden = true;
  document.body.classList.remove("dropmode");
  try {
    await invoke("expand_lamina"); // ventana pequeña -> pantalla completa
  } catch (_) {}
  bg.onload = onBgLoad;
  bg.src = dataUrl;
}

async function loadLaminaFromPath(path) {
  try {
    const b64 = await invoke("load_image", { path });
    sourcePath = path;
    sourceName = path.split(/[\\/]/).pop();
    setLamina(`data:${mimeFromExt(path)};base64,` + b64);
  } catch (e) {
    console.error("load_image falló:", e);
  }
}

document.querySelector("#droppanel .dp-box").addEventListener("click", () => fileinput.click());
fileinput.addEventListener("change", () => {
  const f = fileinput.files[0];
  if (!f) return;
  sourceName = f.name;
  sourcePath = "";
  const rd = new FileReader();
  rd.onload = () => setLamina(rd.result);
  rd.readAsDataURL(f);
  fileinput.value = "";
});

getCurrentWebview().onDragDropEvent((ev) => {
  const p = ev.payload;
  if (p.type === "drop" && capMode === "image" && p.paths && p.paths.length) {
    loadLaminaFromPath(p.paths[0]);
  }
});

// Petición de anotación iniciada por la IA (conector MCP)
listen("mcp-annotate", async (ev) => {
  resetSession();
  capMode = "image";
  document.body.classList.add("lamina");
  document.body.classList.remove("dropmode");
  bg.removeAttribute("src");
  droppanel.hidden = true;
  sourceName = "";
  sourcePath = "";
  mcpPrompt.textContent =
    "🤖 " + (ev.payload.prompt || "La IA pide una anotación — marca y pulsa Enter (Esc cancela)");
  mcpPrompt.hidden = false;
  if (ev.payload.path) await loadLaminaFromPath(ev.payload.path);
  updateHint();
});

// "Abrir con Frink": imagen pasada como argumento al arrancar
(async () => {
  try {
    const p = await invoke("take_startup_file");
    if (p) {
      capMode = "image";
      document.body.classList.add("lamina");
      await invoke("show_lamina_window");
      await loadLaminaFromPath(p);
      updateHint();
    }
  } catch (e) {
    console.error("startup file:", e);
  }
})();

// ---------- Ratón (dibujo y selección) ----------
board.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !bgReady || spaceDown || panning) return;
  if (capMode === "image" && !inView(e) && !selecting) return;

  // En los dos modos se dibuja directamente sobre todo: la zona de recorte es
  // OPCIONAL (tecla R o botón ⛶). Sin zona, se exporta la pantalla completa.
  const needSelect = selecting;
  if (needSelect) {
    mode = "select";
    startImg = toPhys(e);
    return;
  }
  if (pendingOrder) {
    mode = "order";
    const o = ORDERS[pendingOrder.id];
    const p = toPhys(e);
    current = {
      type: "order",
      order: pendingOrder.id,
      label: o.label,
      kind: o.kind,
      color,
      w: Math.max(2, size * kx() * 0.8),
      lpx: 14 * kx(),
      points: [p],
    };
    if (o.usesColor) current.target_color = color;
    shapes.push(current);
    redraw();
    return;
  }
  if (tool === "dim") {
    const p = toPhys(e);
    if (!dimState) {
      dimState = { p1: p, cursor: p };
      redraw();
      return;
    }
    const d = {
      type: "dimension",
      p1: dimState.p1,
      p2: p,
      length: null,
      unit: "m",
      note: "",
      color,
      w: Math.max(1.5, size * kx() * 0.5),
      lpx: 14 * kx(),
    };
    dimState = null;
    shapes.push(d);
    redraw();
    floatPrompt(e.clientX, e.clientY, "distancia real — ej: 4.5 alto puerta", (val) => {
      if (val === null || !val.trim()) {
        shapes.splice(shapes.indexOf(d), 1); // cota cancelada
        redraw();
        return;
      }
      const m = val.trim().match(/^([\d.,]+)\s*(km|cm|mm|m)?\s*(.*)$/i);
      if (m) {
        d.length = parseFloat(m[1].replace(",", "."));
        d.unit = (m[2] || "m").toLowerCase();
        d.note = m[3] || "";
      } else {
        d.note = val.trim();
      }
      redraw();
    });
    return;
  }
  if (tool === "poly" || tool === "spline") {
    const p = toPhys(e);
    if (!poly) poly = { type: tool, points: [], color, w: size * kx() };
    poly.points.push(p);
    redraw();
    return;
  }
  if (tool === "rect" || tool === "ellipse") {
    mode = "shape";
    const p = toPhys(e);
    current = {
      type: tool,
      color,
      sw: size * kx(),
      fill: fillOn,
      x0: p.x, y0: p.y,
      x: p.x, y: p.y, w: 0, h: 0,
    };
    shapes.push(current);
    redraw();
    return;
  }
  if (tool === "text") {
    e.preventDefault();
    placeTextInput(e.clientX, e.clientY);
    return;
  }
  mode = "draw";
  current = {
    type: tool === "erase" ? "erase" : tool,
    color,
    w: size * kx(),
    points: [toPhys(e)],
  };
  shapes.push(current);
  redraw();
});

board.addEventListener("dblclick", () => {
  if ((tool === "poly" || tool === "spline") && poly) finishPoly();
});

window.addEventListener("mousemove", (e) => {
  if (panning) {
    view.ox = panning.ox + (e.clientX - panning.sx);
    view.oy = panning.oy + (e.clientY - panning.sy);
    applyView();
    return;
  }
  if (mode === "select") {
    const cur = toPhys(e);
    const x = Math.max(0, Math.min(startImg.x, cur.x));
    const y = Math.max(0, Math.min(startImg.y, cur.y));
    const x2 = Math.min(bg.naturalWidth, Math.max(startImg.x, cur.x));
    const y2 = Math.min(bg.naturalHeight, Math.max(startImg.y, cur.y));
    region = { x, y, w: x2 - x, h: y2 - y };
    updateSel();
  } else if (mode === "shape" && current) {
    const p = toPhys(e);
    current.x = Math.min(current.x0, p.x);
    current.y = Math.min(current.y0, p.y);
    current.w = Math.abs(p.x - current.x0);
    current.h = Math.abs(p.y - current.y0);
    redraw();
  } else if (mode === "order" && current) {
    const p = toPhys(e);
    if (current.kind === "line") current.points = [current.points[0], p];
    else current.points.push(p);
    redraw();
  } else if (mode === "draw" && current) {
    current.points.push(toPhys(e));
    redraw();
  } else if (tool === "dim" && dimState) {
    dimState.cursor = toPhys(e);
    redraw();
  } else if ((tool === "poly" || tool === "spline") && poly) {
    polyCursor = toPhys(e);
    redraw();
  }
});

window.addEventListener("mouseup", () => {
  if (panning) {
    panning = null;
    document.body.style.cursor = spaceDown ? "grab" : "";
  }
  if (mode === "select") {
    selecting = false;
    updateHint();
  }
  if (mode === "shape" && current && (current.w < 3 || current.h < 3)) {
    shapes.pop(); // descartar formas accidentales minúsculas
    redraw();
  }
  if (mode === "order" && current) {
    if (current.points.length < 2) {
      shapes.pop();
    } else if (ORDERS[current.order].needsText) {
      const cur = current;
      floatPrompt(
        view.ox + cur.points[0].x / kx(),
        view.oy + cur.points[0].y / ky(),
        "texto de la orden…",
        (val) => {
          if (val && val.trim()) cur.text = val.trim();
          redraw();
        }
      );
    }
    pendingOrder = null;
    const ob = document.getElementById("orders");
    if (ob) ob.classList.remove("active");
    updateHint();
  }
  const wasOrder = mode === "order";
  mode = null;
  current = null;
  if (wasOrder) redraw(); // ahora sí: aplica el efecto de la orden recién cerrada
});

// ---------- Input flotante genérico (cota, texto de orden) ----------
function floatPrompt(cx, cy, placeholder, cb) {
  closeFloat(false);
  const input = document.createElement("input");
  input.id = "floatinput";
  input.type = "text";
  input.placeholder = placeholder;
  input.style.left = Math.min(cx, window.innerWidth - 270) + "px";
  input.style.top = Math.min(cy + 8, window.innerHeight - 52) + "px";
  document.body.appendChild(input);
  floatEl = input;
  floatCb = cb;
  setTimeout(() => input.focus(), 0);
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") closeFloat(true);
    else if (ev.key === "Escape") closeFloat(false);
  });
  input.addEventListener("blur", () => closeFloat(true));
}

function closeFloat(commit) {
  if (!floatEl) return;
  const el = floatEl, cb = floatCb;
  floatEl = null;
  floatCb = null;
  const v = el.value;
  el.remove();
  if (cb) cb(commit ? v : null);
}

// ---------- Polilínea (puntos) ----------
function finishPoly() {
  if (poly && poly.points.length > 1) shapes.push(poly);
  poly = null;
  polyCursor = null;
  redraw();
}
function cancelPoly() {
  poly = null;
  polyCursor = null;
}

// ---------- Texto ----------
function placeTextInput(cx, cy) {
  removeTextInput(true);
  const input = document.createElement("input");
  input.id = "textinput";
  input.type = "text";
  input.style.left = cx + "px";
  input.style.top = cy + "px";
  input.style.color = color;
  input.style.fontSize = size * 6 + "px";
  input.dataset.px = cx;
  input.dataset.py = cy;
  document.body.appendChild(input);
  textInput = input;
  setTimeout(() => input.focus(), 0);

  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") removeTextInput(true);
    else if (ev.key === "Escape") removeTextInput(false);
  });
  input.addEventListener("blur", () => removeTextInput(true));
}

function removeTextInput(commit) {
  if (!textInput) return;
  const inp = textInput;
  textInput = null;
  const text = inp.value.trim();
  if (commit && text) {
    shapes.push({
      type: "text",
      text,
      x: (Number(inp.dataset.px) - view.ox) * kx(),
      y: (Number(inp.dataset.py) - view.oy) * ky(),
      color: inp.style.color,
      fpx: size * 6 * kx(),
    });
  }
  inp.remove();
  redraw();
}

// ---------- Teclado ----------
document.addEventListener("keydown", async (e) => {
  if (textInput || floatEl) return;

  if (e.key === " " && capMode === "image") {
    if (!spaceDown) {
      spaceDown = true;
      if (!panning) document.body.style.cursor = "grab";
    }
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    if (pendingOrder) {
      pendingOrder = null;
      const ob = document.getElementById("orders");
      if (ob) ob.classList.remove("active");
      updateHint();
      return;
    }
    if (dimState) { dimState = null; redraw(); return; }
    if (poly) { cancelPoly(); redraw(); return; }
    try { await invoke("mcp_cancel"); } catch (_) {}
    await appWindow.hide();
  } else if (e.key === "Enter") {
    if (poly) { finishPoly(); return; }
    await exportar();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    shapes.pop();
    redraw();
  } else if (e.key === "1") setTool("pen");
  else if (e.key === "2") setTool("marker");
  else if (e.key === "3") setTool("poly");
  else if (e.key === "4") setTool("spline");
  else if (e.key === "5") setTool("rect");
  else if (e.key === "6") setTool("ellipse");
  else if (e.key === "7") setTool("text");
  else if (e.key === "8") setTool("erase");
  else if (e.key === "9") setTool("dim");
  else if (e.key.toLowerCase() === "f") toggleFill();
  else if (e.key.toLowerCase() === "r") {
    region = null;
    sel.hidden = true;
    selecting = true;
    updateHint();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.key === " ") {
    spaceDown = false;
    if (!panning) document.body.style.cursor = "";
  }
});

// ---------- Barra de herramientas ----------
const HINTS = {
  select: "Arrastra para elegir la zona",
  pen: "Lápiz: arrastra para dibujar",
  marker: "Rotulador: arrastra para resaltar",
  poly: "Puntos rectos: clic para vértices · doble clic o Enter cierra",
  spline: "Spline: clic para puntos, curva suave · doble clic o Enter cierra",
  rect: "Rectángulo: arrastra · F o ◼ para relleno",
  ellipse: "Elipse: arrastra · F o ◼ para relleno",
  text: "Texto: clic donde quieras escribir · Enter confirma",
  erase: "Goma: arrastra sobre la tinta para borrarla",
  dim: "Cota: clic en dos puntos y escribe la distancia real (da escala a la imagen)",
};

function toggleFill() {
  fillOn = !fillOn;
  document.getElementById("fill").classList.toggle("active", fillOn);
}

function updateHint() {
  let base;
  if (pendingOrder) {
    const o = ORDERS[pendingOrder.id];
    const ejecuta = EFFECT_ORDERS.has(pendingOrder.id) || pendingOrder.id === "manten";
    hint.textContent =
      "Orden " + o.label + " — " +
      (o.kind === "line" ? "traza la guía (arrastra)" : "rodea la zona (arrastra)") +
      (ejecuta ? " · se aplica al soltar" : " · la ejecutará la IA") +
      " · Esc cancela";
    return;
  }
  if (capMode === "image" && !bgReady) {
    base = "Suelta una imagen o haz clic en el panel";
  } else if (selecting) {
    base = HINTS.select;
  } else {
    base = HINTS[tool];
  }
  const exp = capMode === "image"
    ? "rueda = zoom · espacio = mover · Enter = exportar PNG+JSON"
    : (region ? "Enter = exportar la zona" : "Enter = exportar pantalla completa · R = recortar una zona") + " · Esc = salir";
  hint.textContent = base + " · " + exp;
}

function setTool(t) {
  if (poly) finishPoly();
  dimState = null;
  tool = t;
  document
    .querySelectorAll("#toolbar [data-tool]")
    .forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  updateHint();
}

function setColor(c) {
  color = c;
  document
    .querySelectorAll("#toolbar [data-color]")
    .forEach((b) => b.classList.toggle("active", b.dataset.color === c));
  if (tool === "erase") setTool("pen");
}

const sizeSlider = document.getElementById("size");
const sizeVal = document.getElementById("sizeval");
sizeSlider.addEventListener("input", () => {
  size = Number(sizeSlider.value);
  sizeVal.textContent = sizeSlider.value;
});

// Menú de órdenes (se construye desde ORDERS)
const ordersBtn = document.getElementById("orders");
const orderMenu = document.getElementById("ordermenu");
// Dos grupos honestos: lo que Frink ejecuta ya mismo y lo que solo puede hacer una IA
const ORDER_GROUPS = [
  ["Se aplica ya en la imagen", ["borra", "blur", "aclara", "oscurece", "mas_color", "menos_color", "cambia_color", "manten"]],
  ["Para la IA (va en el JSON)", ["reemplaza", "pregunta", "linea_fuga", "horizonte", "cine_guia"]],
];
for (const [title, ids] of ORDER_GROUPS) {
  const h = document.createElement("div");
  h.className = "om-head";
  h.textContent = title;
  orderMenu.appendChild(h);
  for (const id of ids) {
    const o = ORDERS[id];
    const b = document.createElement("button");
    b.dataset.order = id;
    b.textContent = o.label + (o.kind === "line" ? "  ⟋" : "");
    orderMenu.appendChild(b);
  }
}
orderMenu.addEventListener("mousedown", (e) => e.stopPropagation());
orderMenu.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (poly) finishPoly();
  dimState = null;
  pendingOrder = { id: b.dataset.order };
  orderMenu.hidden = true;
  ordersBtn.classList.add("active");
  updateHint();
});

toolbar.addEventListener("mousedown", (e) => e.stopPropagation());
toolbar.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  b.blur();
  if (b.dataset.tool) setTool(b.dataset.tool);
  else if (b.dataset.color) setColor(b.dataset.color);
  else if (b.id === "fill") toggleFill();
  else if (b.id === "orders") {
    orderMenu.hidden = !orderMenu.hidden;
    if (orderMenu.hidden && !pendingOrder) ordersBtn.classList.remove("active");
    else ordersBtn.classList.add("active");
  }
  else if (b.id === "undo") { shapes.pop(); redraw(); }
  else if (b.id === "rezone") { region = null; sel.hidden = true; selecting = true; updateHint(); }
  else if (b.id === "done") exportar();
  else if (b.id === "close") appWindow.hide();
});

setTool("pen");
setColor(color);
updateHint();

// ---------- JSON de anotaciones (coordenadas en px de la imagen original) ----------
// Precisión sub-píxel: floats con 2 decimales
const r2 = (v) => Math.round(v * 100) / 100;

function buildJson(rImg) {
  const anns = shapes.map((s) => {
    if (s.type === "text") {
      return {
        type: "text",
        text: s.text,
        x: r2(s.x),
        y: r2(s.y),
        color: s.color,
        font_px: r2(s.fpx),
      };
    }
    if (s.type === "rect" || s.type === "ellipse") {
      const g = {
        type: s.type,
        color: s.color,
        width_px: r2(s.sw),
        fill: !!s.fill,
        bbox: [r2(s.x), r2(s.y), r2(s.x + s.w), r2(s.y + s.h)],
      };
      if (s.type === "ellipse") {
        g.center = [r2(s.x + s.w / 2), r2(s.y + s.h / 2)];
        g.radii = [r2(s.w / 2), r2(s.h / 2)];
      }
      return g;
    }
    if (s.type === "dimension") {
      return {
        type: "dimension",
        p1: [r2(s.p1.x), r2(s.p1.y)],
        p2: [r2(s.p2.x), r2(s.p2.y)],
        length_px: r2(Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y)),
        length: s.length,
        unit: s.unit,
        note: s.note || "",
        color: s.color,
      };
    }
    const pts = s.points.map((p) => [r2(p.x), r2(p.y)]);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [px, py] of pts) {
      if (px < x1) x1 = px;
      if (py < y1) y1 = py;
      if (px > x2) x2 = px;
      if (py > y2) y2 = py;
    }
    const base = {
      type: s.type,
      color: s.color,
      width_px: r2(strokeWidth(s)),
      bbox: [x1, y1, x2, y2],
      points: pts,
    };
    if (s.type === "order") {
      base.order = s.order;
      base.label = s.label;
      base.kind = s.kind; // area = zona cerrada · line = guía
      if (s.text) base.text = s.text;
      if (s.target_color) base.target_color = s.target_color;
    }
    return base;
  });
  return JSON.stringify(
    {
      frink: "0.6",
      mode: capMode === "image" ? "lamina" : "pantalla",
      source_image: sourceName || null,
      source_path: sourcePath || null,
      image_size: [bg.naturalWidth, bg.naturalHeight],
      exported_region_px: {
        x: r2(rImg.x),
        y: r2(rImg.y),
        w: r2(rImg.w),
        h: r2(rImg.h),
      },
      export_scale: capMode === "image" ? 1 : EXPORT_SCALE,
      note: "Coordenadas en píxeles (float) de la imagen original (image_size). exported_region_px es el recorte del PNG adjunto; el PNG mide región × export_scale. Las 'dimension' dan escala real; las 'order' son comandos declarados.",
      annotations: anns,
      created: new Date().toISOString(),
    },
    null,
    1
  );
}

// ---------- Exportar ----------
async function exportar() {
  if (!bgReady) return;
  if (poly) finishPoly();
  removeTextInput(true);
  closeFloat(true);

  // región en px de imagen; por defecto, la imagen completa
  let r =
    region && region.w > 8 && region.h > 8
      ? region
      : { x: 0, y: 0, w: bg.naturalWidth, h: bg.naturalHeight };

  const K = capMode === "image" ? 1 : EXPORT_SCALE;
  const out = document.createElement("canvas");
  out.width = Math.round(r.w * K);
  out.height = Math.round(r.h * K);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";

  // fondo con los efectos de las órdenes ya aplicados (borra, pixela, aclara…)
  const baseCv = newCanvas(bg.naturalWidth, bg.naturalHeight);
  const baseCtx = baseCv.getContext("2d");
  const hasFx = renderBase(baseCtx);
  octx.drawImage(hasFx ? baseCv : bg, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);

  const ink = document.createElement("canvas");
  ink.width = out.width;
  ink.height = out.height;
  const ictx = ink.getContext("2d");
  ictx.setTransform(K, 0, 0, K, -r.x * K, -r.y * K);
  for (const s of shapes) renderShape(ictx, s, true);
  octx.drawImage(ink, 0, 0);

  const dataUrl = out.toDataURL("image/png");
  const stem =
    capMode === "image" && sourceName
      ? sourceName.replace(/\.[^.]+$/, "")
      : "captura";

  try {
    const saved = await invoke("deliver", {
      pngBase64: dataUrl,
      folder: DEST_FOLDER,
      json: buildJson(r),
      baseName: stem,
      asFiles: true, // PNG + JSON (+ imagen) en los dos modos
    });
    console.log("Guardado en", saved);
  } catch (err) {
    console.error("deliver falló:", err);
  }
  await appWindow.hide();
}
