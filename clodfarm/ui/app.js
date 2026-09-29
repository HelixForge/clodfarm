/* clodfarm UI. A living pixel farm: every Claude on the farm is a Claude critter that wanders, watches its sub-agents
 * at their plot, or naps when its budget says so; sub-agents are mini Claudes. Plain JS, no build step, no dependencies. */
"use strict";

// ================================================================== utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// the providers a bot can use (clodfarm/bots.py has the same list; the farm checks what's sent)
const BOT_PROVIDERS = {
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api", key: true, example: "qwen/qwen3-coder:free",
    hint: "Free models end in :free (openrouter.ai/models, filter by price). Make a key at openrouter.ai/keys. Free tiers allow a few requests a minute: the bot pauses when it hits that." },
  ollama: { label: "Ollama", url: "http://host.docker.internal:11434", key: false, example: "qwen3-coder",
    hint: "Ollama on the machine running the farm's container: pull a model that can use tools first (ollama pull qwen3-coder)." },
  custom: { label: "Anthropic-compatible", url: "", key: false, example: "",
    hint: "Any endpoint that speaks Anthropic's Messages API, like a LiteLLM gateway. The address is its base URL, without /v1." },
};
function hashStr(s) { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; }
/** replaceChildren that flattens arrays and drops null/false (plain replaceChildren would print "null"). */
function fill(el, ...kids) { el.replaceChildren(...kids.flat(3).filter(k => k != null && k !== false)); return el; }
const nowS = () => Date.now() / 1000;
function ago(ts) {
  if (!ts) return "-";
  const s = Math.max(0, nowS() - ts);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${(s / 3600).toFixed(1)}h ago` : `${(s / 86400).toFixed(1)}d ago`;
}
function until(ts) {
  if (!ts) return "";
  const s = Math.max(0, ts - nowS());
  return s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
}
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ===================================================================== sprites
function canvas(w, hgt) { const c = document.createElement("canvas"); c.width = w; c.height = hgt; return c; }
/** Paint string rows ("." = transparent) with a palette into a new canvas. */
function paint(rows, pal, w = 16) {
  const c = canvas(w, rows.length), g = c.getContext("2d");
  rows.forEach((row, y) => [...row.padEnd(w, ".").slice(0, w)].forEach((ch, x) => {
    if (ch !== "." && pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); }
  }));
  return c;
}

const CLAY = { o: "#5a2616", h: "#f2a07a", b: "#d97757", s: "#b45a3c", d: "#86381f", e: "#231815", w: "#ffffff", k: "#f6c9b3" };
const HAT_COLORS = ["#3b7dd8", "#7b4bb7", "#2f9e6b", "#d2a21d", "#c0392b", "#2c3e50", "#e06f9f", "#16a0a0"];
const HAT_H = 6; // rows above the body for hats
// the skin picker's swatches: hat and band colours, and body tints (clay first)
const SWATCHES = ["#3b7dd8", "#7b4bb7", "#2f9e6b", "#d2a21d", "#c0392b", "#2c3e50", "#e06f9f", "#16a0a0", "#e85b5b", "#f0cf7a", "#f7f3ea", "#1c2233"];
const BODY_TINTS = ["#d97757", "#c0603f", "#e89a74", "#d9b27a", "#8fb573", "#7fa8d9", "#a98bd1", "#e68aa8", "#8a8f9c", "#9a6a4a"];
const ACCESSORIES = ["", "scarf", "glasses", "bowtie", "backpack", "cape"];

/** Clawd, the Claude Code critter: a clay block with two eyes, stubby arms and four legs. 16 x 12. */
function clawdGrid({ look = 0, legs = 0, blink = false, sleep = false, arms = 0 }) {
  const W = 16, H = 12, g = Array.from({ length: H }, () => Array(W).fill("."));
  const set = (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) g[y][x] = c; };
  for (let y = 0; y <= 9; y++) for (let x = 2; x <= 13; x++) {
    const edge = x === 2 || x === 13 || y === 0 || y === 9;
    if ((x === 2 || x === 13) && (y === 0 || y === 9)) continue; // rounded corners
    set(x, y, edge ? "o" : (y === 1 || x === 3) ? "h" : (x === 12 || y === 8) ? "s" : "b");
  }
  // arms (arms=1 raises them: typing / cheering)
  const ay = 5 - arms;
  for (const [x0, dir] of [[0, 1], [15, -1]]) {
    for (let y = ay - 1; y <= ay + 2; y++) for (let k = 0; k < 3; k++) {
      const x = x0 + k * dir, rim = y === ay - 1 || y === ay + 2;
      if (k === 2) set(x, y, rim ? "o" : "b");
      else set(x, y, rim || k === 0 ? "o" : (dir === 1 ? "h" : "s"));
    }
  }
  // eyes: tall and dark with a shine; closed = a line
  for (const ex of [5, 9]) {
    const x = ex + look;
    if (blink || sleep) { set(x, 5, "e"); set(x + 1, 5, "e"); }
    else { for (let y = 3; y <= 5; y++) { set(x, y, "e"); set(x + 1, y, "e"); } set(x, 3, "w"); }
  }
  if (!sleep) { set(4 + look, 6, "k"); set(11 + look, 6, "k"); } // blush
  // legs: 4 pairs of 2px; the lifted pair is shorter
  const pairs = [[3, 4], [5, 6], [9, 10], [11, 12]];
  pairs.forEach(([a, b], i) => {
    const lifted = !sleep && legs !== 0 && ((i % 2 === 0) === (legs === 1));
    for (const x of [a, b]) {
      if (sleep) return;
      if (lifted) set(x, 10, "o");
      else { set(x, 10, "d"); set(x, 11, "o"); }
    }
  });
  return g.map(r => r.join(""));
}

/** A sub-agent: a small Claude, 10 x 8, with a band in its agent's colour. Cached per colour and pose. */
const miniCache = new Map();
function miniSprite(color, { legs = 0, arms = 0, blink = false }) {
  let byPose = miniCache.get(color);
  if (!byPose) miniCache.set(color, (byPose = []));
  const code = legs + 3 * arms + 6 * (blink ? 1 : 0);
  if (byPose[code]) return byPose[code];
  const rows = Array.from({ length: 8 }, () => Array(10).fill("."));
  const set = (x, y, ch) => { if (x >= 0 && x < 10 && y >= 0 && y < 8) rows[y][x] = ch; };
  for (let y = 0; y <= 5; y++) for (let x = 1; x <= 8; x++) {
    if ((x === 1 || x === 8) && (y === 0 || y === 5)) continue;
    set(x, y, x === 1 || x === 8 || y === 0 || y === 5 ? "o" : y === 1 ? "c" : x === 7 || y === 4 ? "s" : "b");
  }
  const ay = 2 - arms;
  set(0, ay, "o"); set(0, ay + 1, "o"); set(9, ay, "o"); set(9, ay + 1, "o");
  for (const x of [3, 6]) { set(x, blink ? 3 : 2, "e"); set(x, 3, "e"); }
  [2, 4, 5, 7].forEach((x, i) => { const up = legs !== 0 && ((i % 2 === 0) === (legs === 1)); set(x, 6, up ? "o" : "d"); if (!up) set(x, 7, "o"); });
  return (byPose[code] = paint(rows.map(r => r.join("")), { ...CLAY, c: color }, 10));
}

/** Hats: "@" is the hat's colour (@d darker, @l lighter), "#" its band / trim colour. `base` and `band` are the colours
 * when the Claude picked none; `tint` hats take the Claude's own colour then (the old look). */
const HATS = {
  straw: { base: "#f0cf7a", band: "#c0392b", pal: { o: "#6b4f1d", a: "@", b: "@d", r: "#" }, rows: [
    "................", "......oooo......", ".....oaaaao.....", "....oaaaaaao....", "...orrrrrrrro...", "ooaaaaaaaaaaaaoo", ".oobbbbbbbbbboo."] },
  beanie: { tint: true, band: "#f7f3ea", pal: { o: "#1c2233", w: "#", c: "@", d: "@d", l: "@l" }, rows: [
    ".......ww.......", "......owwo......", ".....occcco.....", "...occccccco....", "..occclcccccco..", "..oddddddddddo..", "..oddddddddddo.."] },
  cap: { tint: true, band: "#f7f3ea", pal: { o: "#1c2233", w: "#", c: "@", d: "@d" }, rows: [
    "................", "................", ".....occcco.....", "...occcwccccoo..", "..occcccccccccoo", "..ooooooooodddddo", "................"] },
  flower: { base: "#ffd0dc", band: "#f5c542", pal: { o: "#6b2f1f", p: "@", y: "#", g: "#3f8f35" }, rows: [
    "................", "..........opo...", ".........opypo..", "..........opo...", "...........g....", "................", "................"] },
  headphones: { tint: true, band: "#5b6272", pal: { o: "#15171f", c: "@", l: "@l", g: "#" }, rows: [
    "................", "................", "....oooooooo....", "...oggggggggo...", "..og........go..", "oo.o........o.oo", "oco..........oco"] },
  bow: { base: "#e0508a", band: "#f59cc0", pal: { o: "#5b1330", c: "@", l: "#" }, rows: [
    "................", "................", "................", "....oo....oo....", "...olco..oclo...", "...occcoocccoo..", "....oo.oo..oo..."] },
  crown: { base: "#f5c542", band: "#d63a3a", pal: { o: "#6b4a07", y: "@", l: "@l", r: "#", b: "#3b7dd8" }, rows: [
    "................", "................", "...o...o...o....", "..oyo.oyo.oyo...", "..oyyoyyyoyyo...", "..oylyryybyylo..", "..oooooooooooo.."] },
  sprout: { base: "#6fcf5b", band: "#3f8f35", pal: { o: "#1f4d1d", g: "@", l: "@l", s: "#" }, rows: [
    "................", "...oo.....oo....", "..ollo...oglo...", "..oglgo.ogllo...", "...oogosoggo....", "......os.o......", "......os........"] },
  leaf: { base: "#63a93f", band: "#8a5a2b", pal: { o: "#1f3d14", g: "@", l: "@l", d: "@d", s: "#" }, rows: [
    ".........oo.....", ".......oolgo....", ".....ooglggo....", "....oglgggdo....", "....ogggddo.....", ".....oddoo......", "......os........"] },
  wizard: { base: "#5b4bb7", band: "#f5c542", pal: { o: "#1c1440", c: "@", l: "@l", d: "@d", y: "#" }, rows: [
    ".........oo.....", "........oco.....", ".......occo.....", "......ocycco....", ".....occcclco...", "...occcccccccoo.", "oodddyddddyddddo"] },
  chef: { base: "#f7f3ea", band: "#d8d2c4", pal: { o: "#5b5b66", w: "@", g: "#" }, rows: [
    "....oo.oo.oo....", "...owwowwowwo...", "...owwwwwwwwo...", "....owwwwwwo....", "....owwwwwwo....", "....oggggggo....", "....oooooooo...."] },
  none: { base: "#000000", band: "#000000", pal: {}, rows: [] },
};

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16), f = (v) => clamp(Math.round(v + amt * 255), 0, 255);
  return "#" + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, "0")).join("");
}
const HEX = /^#[0-9a-fA-F]{6}$/;
const bodyPal = (body) => body === CLAY.b ? CLAY
  : { ...CLAY, o: shade(body, -0.5), h: shade(body, 0.12), b: body, s: shade(body, -0.13), d: shade(body, -0.33), k: shade(body, 0.3) };

/** A Claude's look, resolved: its hat, the hat / band / body colours and its accessory. `colors` is what the person
 * picked (may be null or partial); `fallback` is its farm colour, which tints the beanie, cap and headphones. */
const skinCache = new Map();
function skinOf(hat, colors, accessory, fallback) {
  hat = HATS[hat] ? hat : "straw";
  const def = HATS[hat], c = colors || {};
  const hc = HEX.test(c.hat || "") ? c.hat : def.tint ? (fallback || HAT_COLORS[0]) : def.base;
  const band = HEX.test(c.band || "") ? c.band : def.band, body = HEX.test(c.body || "") ? c.body : CLAY.b;
  const acc = ACCESSORIES.includes(accessory || "") ? accessory || "" : "";
  const key = `${hat}|${hc}|${band}|${body}|${acc}`;
  let s = skinCache.get(key);
  if (!s) skinCache.set(key, (s = { key, hat, hatC: hc, band, body, acc, frames: [] }));
  return s;
}
const agentSkin = (a) => skinOf(a.hat || "straw", a.colors, a.accessory, colorFor(a.id));

/** Accessories, drawn on the 16 x 18 critter in the same pixel grid ("#" = the band colour). `back` ones go behind it. */
const ACC = {
  cape: { back: ["", "", "", "", "", "", "", "..o##########o..", ".o############o.", ".o############o.", "o##############o", "o##############o", "o##############o", "o##############o", "oo############oo", ".oooooooooooooo."] },
  backpack: { pal: { b: "#8a5a2b", d: "#5e3a1a" },
    back: ["", "", "", "", "", "", "", "", "", "", "", "", ".............oo.", "............obbo", "............obbo", "............oddo", "............obbo", ".............oo."],
    front: ["", "", "", "", "", "", "", "", "", "", "", "", "", "...d.......d....", "...d.......d...."] },
  scarf: { front: ["", "", "", "", "", "", "", "", "", "", "", "", "", "..o##########o..", "..o#d#d#d#d#do..", "..........o#o...", "..........o#o...", "...........o...."] },
  glasses: { front: ["", "", "", "", "", "", "", "", "....oooooooo....", "....o..oo..o....", "....o..oo..o....", "....o..oo..o....", "....oooooooo...."] },
  bowtie: { front: ["", "", "", "", "", "", "", "", "", "", "", "", "", ".....##..##.....", ".....##dd##.....", ".....##..##....."] },
};
function drawAcc(g, skin, back, look) {
  const a = ACC[skin.acc], rows = a && (back ? a.back : a.front);
  if (!rows) return;
  const pal = { o: "#1c2233", "#": skin.band, d: shade(skin.band, -0.2), ...(a.pal || {}) };
  g.drawImage(paint(rows, pal), skin.acc === "glasses" ? look : 0, 0);
}

/** One pose of a skin, 16 x 18 (HAT_H rows of hat, then the 12-row body). Poses are cached per skin by a small number,
 * so the frame loop never builds a string key. */
const poseCode = (o) => (o.look || 0) + 1 + 3 * (o.legs || 0) + 9 * (o.blink ? 1 : 0) + 18 * (o.sleep ? 1 : 0) + 36 * (o.arms || 0);
function skinFrame(skin, o) {
  const code = poseCode(o);
  let c = skin.frames[code];
  if (c) return c;
  c = canvas(16, HAT_H + 12);
  const g = c.getContext("2d");
  drawAcc(g, skin, true, o.look || 0);
  g.drawImage(paint(clawdGrid(o), bodyPal(skin.body)), 0, HAT_H);
  drawAcc(g, skin, false, o.look || 0);
  const def = HATS[skin.hat];
  if (def.rows.length) {
    const pal = {}, hc = skin.hatC, bc = skin.band;
    for (const [k, v] of Object.entries(def.pal)) pal[k] = v === "@" ? hc : v === "@d" ? shade(hc, -0.18) : v === "@l" ? shade(hc, 0.2) : v === "#" ? bc : v;
    // hats end on the body's first row; shift down 1 when the eyes are closed so it sits snug
    g.drawImage(paint(def.rows, pal), 0, o.sleep ? 1 : 0);
  }
  return (skin.frames[code] = c);
}
/** A whole critter (kept for the landing page and the demos): critterSprite(hat, colour or skin, pose). */
function critterSprite(hat, color, opts = {}) {
  const skin = color && typeof color === "object" ? color : skinOf(hat, null, "", color);
  return skinFrame(skin, opts);
}

const EGG = paint([
  "....oooo....", "...occcco...", "..occsccco..", "..occcccco..", ".occccccsco.", ".ocsccccccco", ".occcccsccco",
  ".occcccccdco", ".odcccccdcco", "..oddcccddo.", "...odddddo..", "....oooo....",
], { o: "#6b5a3a", c: "#f6eed8", s: "#e2875f", d: "#d8c9a3" }, 12);

const LAPTOP = (on) => paint([
  ".ooooooo.", on ? ".ogsggso." : ".osssssso", on ? ".osgssso." : ".osssssso", on ? ".oggsgso." : ".osssssso", ".ooooooo.", "ommmmmmmo", "ooooooooo",
].map(r => r.slice(0, 9)), { o: "#1b1f2a", s: "#22303c", g: "#7cfc9a", m: "#9aa3b2" }, 9);
const LAPTOP_ON = LAPTOP(true), LAPTOP_OFF = LAPTOP(false);

// a 3 x 5 pixel font for the field's little signs ("+12")
const DIGITS = { "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001011001111", "4": "101101111001001",
  "5": "111100111001111", "6": "111100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001111", "+": "000010111010000" };
function pxText(g, text, x, y, color) {
  g.fillStyle = color;
  [...text].forEach((ch, i) => { const b = DIGITS[ch]; if (b) for (let k = 0; k < 15; k++) if (b[k] === "1") g.fillRect(x + i * 4 + (k % 3), y + Math.floor(k / 3), 1, 1); });
}
/** A wooden sign stuck in the ground with a count on it: "+N" minis the plot has but doesn't draw. */
function drawSign(g, x, y, text) {
  const w = text.length * 4 + 3;
  g.fillStyle = "#3a2616"; g.fillRect(x + Math.floor(w / 2) - 1, y + 6, 2, 4); g.fillRect(x, y, w, 8);
  g.fillStyle = "#c9964a"; g.fillRect(x + 1, y + 1, w - 2, 6);
  pxText(g, text, x + 2, y + 2, "#3a2616");
}

/** The planner: a scarecrow at the field's edge. Awake it sways and looks round; asleep it sags, grey. 16 x 22. */
const SCARECROW = [0, 1, 2].map(f => paint([
  ".....oooooo.....", "....oyyyyyyo....", "...oyyyyyyyyo...", "..oooooooooooo..", ".....obbbbo.....",
  f === 2 ? ".....obbbbo....." : ".....oebbeo.....", ".....obbbbo.....", f === 2 ? ".....obeebo....." : ".....obmmbo.....",
  "......obbo......", f === 1 ? "yy.ooorrrrooo.yy" : ".yyooorrrrooyy..", f === 1 ? ".oooorrrrrroooo." : "yooorrrrrrrrooyy",
  "......orrrro....", "......orrrro....", "......oyyyyo....", "......y.ww.y....", ".......oww......", ".......oww......",
  ".......oww......", ".......oww......", ".......oww......", "......owwww.....", ".....oooooooo...",
], f === 2 ? { o: "#3a3a40", y: "#9a9384", b: "#a8a294", e: "#3a3a40", m: "#6b6860", r: "#7a7a82", w: "#6b6158" }
  : { o: "#3a2616", y: "#e0b64e", b: "#d8c29a", e: "#231815", m: "#86381f", r: "#c0392b", w: "#8a6038" }));

// 10 x 10 icons for bubbles and buttons
const ICONS = {
  terminal: [["oooooooooo", "osssssssso", "osgsssssso", "ossgssssso", "osgsssssso", "osssggggso", "osssssssso", "oooooooooo", "...oooo...", "..oooooo.."],
    { o: "#1b1f2a", s: "#22303c", g: "#7cfc9a" }],
  zzz: [["......oooo", ".......oo.", "......oo..", "..oooooooo", "....oo....", "...oo.....", "..oooo....", "oooo......", "..oo......", ".oooo....."],
    { o: "#3c4a6b" }],
  pause: [["..........", ".oo....oo.", ".oo....oo.", ".oo....oo.", ".oo....oo.", ".oo....oo.", ".oo....oo.", ".oo....oo.", ".oo....oo.", ".........."],
    { o: "#3c4a6b" }],
  alert: [["....oo....", "...orro...", "...orro...", "...orro...", "...orro...", "....rr....", "..........", "....rr....", "...orro...", "....oo...."],
    { o: "#6b1a10", r: "#e0513c" }],
  ask: [["..oooooo..", ".oo....oo.", ".......oo.", "......oo..", ".....oo...", "....oo....", "....oo....", "..........", "....oo....", "....oo...."],
    { o: "#3c4a6b" }],
  dots: [["..........", "..........", "..........", "..........", ".oo.oo.oo.", ".oo.oo.oo.", "..........", "..........", "..........", ".........."],
    { o: "#3c4a6b" }],
  scroll: [[".oooooooo.", "oyyyyyyyyo", ".oppppppo.", ".opooopo..", ".oppppppo.", ".opoooopo.", ".oppppppo.", ".opooppo..", "oyyyyyyyyo", ".oooooooo."],
    { o: "#5a3d1e", p: "#f6ecd0", y: "#c9964a" }],
  plan: [[".oooooooo.", "oyyyyyyyyo", ".oppppppo.", ".oprpppro.", ".oppprppo.", ".opprpppo.", ".oppppppo.", ".opppppo..", "oyyyyyyyyo", ".oooooooo."],
    { o: "#5a3d1e", p: "#f6ecd0", y: "#c9964a", r: "#d97757" }],
  swords: [["o........o", ".o......o.", "..o....o..", "...o..o...", "....oo....", "....oo....", "...o..o...", ".bo....ob.", "bb......bb", "b........b"],
    { o: "#9aa3b2", b: "#6b4a2b" }],
  chat: [["..........", ".oooooooo.", "owwwwwwwwo", "owwwwwwwwo", "owdwdwdwwo", "owwwwwwwwo", ".oooooooo.", "..oow.....", "..ow......", "..o......."],
    { o: "#3c4a6b", w: "#fff8e8", d: "#d97757" }],
  heart: [["..........", ".rr...rr..", "rllr.rrrr.", "rlrrrrrrr.", "rrrrrrrrr.", ".rrrrrrr..", "..rrrrr...", "...rrr....", "....r.....", ".........."],
    { r: "#e0513c", l: "#f7a296" }],
  egg: [["...oooo...", "..occcco..", ".occsccco.", ".occcccco.", "occccccsco", "ocscccccco", "occcccccco", "oddcccccdo", ".oddcccdo.", "..oooooo.."],
    { o: "#6b5a3a", c: "#f6eed8", s: "#e2875f", d: "#d8c9a3" }],
  chart: [["o.........", "o.......gg", "o.......gg", "o....bb.gg", "o....bb.gg", "o.rr.bb.gg", "o.rr.bb.gg", "o.rr.bb.gg", "o.rr.bb.gg", "oooooooooo"],
    { o: "#3c4a6b", b: "#1c9fd6", g: "#3cc36b", r: "#d97757" }],
  globe: [["...oooo...", "..obwbbo..", ".obwbbwbo.", "obbwbbwbbo", "owwwwwwwwo", "obbwbbwbbo", "owwwwwwwwo", ".obwbbwbo.", "..obwbbo..", "...oooo..."],
    { o: "#1b3a5a", b: "#1c9fd6", w: "#d8eef8" }],
  tasks: [["..oyyyyo..", ".oooooooo.", ".owwwwwwo.", ".ogwllllo.", ".owwwwwwo.", ".ogwllllo.", ".owwwwwwo.", ".ogwllllo.", ".owwwwwwo.", ".oooooooo."],
    { o: "#5a3d1e", y: "#c9964a", w: "#f6ecd0", g: "#3cc36b", l: "#9aa3b2" }],
  gear: [["....oo....", ".oo.gg.oo.", ".oggggggo.", "..gglogg..", "oggl..lggo", "ogg....ggo", "..gg..gg..", ".oggggggo.", ".oo.gg.oo.", "....oo...."],
    { o: "#2f251b", g: "#8d8d96", l: "#c9c9cf" }],
  roster: [["oooooooooo", "obbowwwwwo", "obbowlllwo", "oooooooooo", "obbowwwwwo", "obbowlllwo", "oooooooooo", "obbowwwwwo", "obbowlllwo", "oooooooooo"],
    { o: "#3c4a6b", b: "#d97757", w: "#fff8e8", l: "#9aa3b2" }],
  key: [["..oooo....", ".oyyyyo...", "oyyooyyo..", "oyyooyyo..", ".oyyyyo...", "..oyyo....", "..oyyoo...", "..oyyyyo..", "..oyyo....", "..oyyyo..."],
    { o: "#5a3d1e", y: "#f5c542" }],
  plus: [["..........", "....oo....", "....oo....", "....oo....", ".oooooooo.", ".oooooooo.", "....oo....", "....oo....", "....oo....", ".........."], { o: "#2f251b" }],
  minus: [["..........", "..........", "..........", "..........", ".oooooooo.", ".oooooooo.", "..........", "..........", "..........", ".........."], { o: "#2f251b" }],
  fit: [["ooo....ooo", "oo......oo", "o.o....o.o", "..........", "...gggg...", "...gggg...", "..........", "o.o....o.o", "oo......oo", "ooo....ooo"], { o: "#2f251b", g: "#3cc36b" }],
  quill: [["........oo", ".......owo", "......owwo", ".....owwo.", "....owwo..", "...owwo...", "..oowo....", "..ooo.....", ".ooo......", "oo........"],
    { o: "#3a2a1a", w: "#f6ecd0" }],
};
const iconURL = {};
function icon(name, scale = 1) {
  const k = name + scale;
  if (iconURL[k]) return iconURL[k];
  if (name === "party") {
    const s = critterSprite("straw", HAT_COLORS[0], { legs: 0 }), c = canvas(18, 18), g = c.getContext("2d");
    g.drawImage(s, 1, 0);
    return (iconURL[k] = c.toDataURL());
  }
  if (!ICONS[name]) return ""; // an unknown icon: no picture rather than a broken page
  const [rows, pal] = ICONS[name];
  return (iconURL[k] = paint(rows, pal, 10).toDataURL());
}

// ======================================================================= world
const G = { // Thronglet-ish meadow palette
  g0: "#4a6524", g1: "#577530", g2: "#648436", g3: "#71923c", g4: "#80a246", worn: "#8ea456",
  t0: "#1c3519", t1: "#28501f", t2: "#346a27", t3: "#468a31", t4: "#63a93f", t5: "#8cc65a", trunk: "#4b3421",
  r0: "#34343c", r1: "#55555e", r2: "#6f6f78", r3: "#8d8d96", r4: "#aeaeb5",
  soil: "#6b4a2e", soil2: "#57391f", soil3: "#7d5a3a", soilo: "#3f2915",
  w0: "#2a5a8a", w1: "#3f7fb8", w2: "#5b9ed0", w3: "#9fd0ee",
};
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

function valueNoise(seed) {
  const rnd = mulberry32(seed), N = 64, grid = Array.from({ length: N * N }, rnd);
  const at = (x, y) => grid[((y % N + N) % N) * N + ((x % N + N) % N)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), u), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u), v);
  };
}

function pxCircle(g, cx, cy, r, color) {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y + r * 0.8));
    g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}
function pxEllipse(g, cx, cy, rx, ry, color) {
  g.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + 0.6))));
    g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}

function layoutWorld(W, H, opts = {}) {
  const T = clamp(Math.round(Math.min(W, H) * 0.14), 20, 40);
  const play = { x0: T + 2, y0: T + 8, x1: W - T - 2, y1: H - T - 4 };
  const portrait = H > W * 1.15;
  const barn = { w: 46, h: 44 };
  barn.x = opts.barnRight && !portrait ? play.x1 - barn.w - 6 : play.x0 + 6; barn.y = play.y0 - 6;
  const board = { x: opts.barnRight && !portrait ? barn.x - 36 : barn.x + barn.w + 10, y: barn.y + 16, w: 26, h: 20 };
  // opts.clearCenter keeps the middle free for a title (the landing page): the field goes to the right
  const reserve = opts.reserve || null;
  const cols = portrait || reserve ? 2 : (play.x1 - play.x0 > 300 ? 4 : 3), rows = portrait && reserve ? 2 : portrait || reserve ? 3 : 2;
  const pw = 26, ph = 14, gx = 20, gy = 16;
  const fw = cols * pw + (cols - 1) * gx, fh = rows * ph + (rows - 1) * gy;
  const fx = portrait ? Math.round((W - fw) / 2 + 8)
    : reserve ? Math.round(Math.min((reserve.x + reserve.w + play.x1) / 2 - fw / 2 + 6, play.x1 - fw - 4)) : Math.round(play.x1 - fw - 12);
  const fy = portrait ? Math.round(reserve ? reserve.y + reserve.h + 14 : barn.y + barn.h + 34) : Math.round(Math.max((play.y0 + play.y1) / 2 - fh / 2 + 12, opts.barnRight ? barn.y + barn.h + 20 : 0));
  const plots = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    plots.push({ x: fx + c * (pw + gx), y: fy + r * (ph + gy), w: pw, h: ph, i: plots.length });
  const field = { x: fx - 12, y: fy - 8, w: fw + 16, h: fh + 14 };
  const pond = { cx: play.x0 + 30, cy: play.y1 - 14, rx: 24, ry: 11 };
  const rest = { x: barn.x + 10, y: barn.y + barn.h + 12 };
  const door = { x: barn.x + barn.w / 2, y: barn.y + barn.h + 2 };
  return { W, H, T, play, portrait, barn, board, plots, field, pond, rest, door, rocks: [], reserve, yard: null, crow: null, z: 0 };
}

const PLOT = { w: 26, h: 14, cx: 58, cy: 42 }, YARD = { cx: 19, cy: 17 };
/** The real farm's layout, grown to fit it: a plot for every busy Claude, a yard by the barn with a spot for every
 * resting one. It tries field and yard widths and keeps the one that shows the whole farm biggest in this window (`view`:
 * the window in CSS px, the HUD's insets, and S, the classic zoom). A small farm fills the window like it always did. */
function layoutFarm(need, view) {
  const nP = Math.max(6, need.plots), nY = Math.max(5, need.yard);
  const avW = Math.max(120, view.w - view.left - view.right), avH = Math.max(120, view.h - view.top - view.bottom);
  const portrait = view.h > view.w * 1.15;
  let best = null;
  for (let fc = 1; fc <= Math.min(nP, 30); fc++) {
    const fr = Math.ceil(nP / fc);
    if (fc > 1 && Math.ceil(nP / (fc - 1)) === fr) continue; // same rows as a narrower field
    for (const yc of [5, 7, 9, 12, 16, 22, 30]) {
      if (yc > 5 && yc > nY + 4) break;
      const fw = fc * PLOT.cx - (PLOT.cx - PLOT.w) + 34, fh = fr * PLOT.cy - (PLOT.cy - PLOT.h) + 30;
      const yw = yc * YARD.cx + 8, yh = Math.ceil(nY / yc) * YARD.cy + 10;
      const lw = Math.max(yw, 112), lh = 44 + 20 + yh + 34; // barn, yard, pond
      const cw = portrait ? Math.max(lw, fw) + 8 : lw + fw + 40, ch = portrait ? lh + fh + 10 : Math.max(lh, fh + 16);
      const z = Math.min(avW / cw, avH / ch);
      if (!best || z > best.z + 1e-6) best = { z, fc, fr, yc, cw, ch, fw, fh, lw, lh, yh };
    }
  }
  const b = best, z = Math.min(view.S, b.z);
  const T = clamp(Math.round(Math.min(view.w, view.h) / view.S * 0.14), 20, 40);
  const x0 = Math.max(T + 4, Math.round(view.left / z + (avW / z - b.cw) / 2)), y0 = Math.max(T + 10, Math.round(view.top / z + (avH / z - b.ch) / 2));
  const W = Math.max(Math.ceil(view.w / z), x0 + b.cw + T + 4), H = Math.max(Math.ceil(view.h / z), y0 + b.ch + T + 4);
  const play = { x0: T + 2, y0: T + 8, x1: W - T - 2, y1: H - T - 4 };
  const barn = { w: 46, h: 44, x: x0 + 12, y: y0 - 6 };
  const yard = { x: x0, y: barn.y + barn.h + 16, cols: b.yc, w: b.yc * YARD.cx + 8, h: b.yh, n: nY };
  const pond = { cx: x0 + 30, cy: yard.y + yard.h + 18, rx: 24, ry: 11 };
  const fx = portrait ? x0 + Math.round((b.cw - b.fw) / 2) + 36 : x0 + b.lw + 40 + 12;
  const fy = portrait ? y0 + b.lh + 12 : y0 + Math.round((b.ch - b.fh) / 2) + 12;
  const plots = [];
  for (let i = 0; i < b.fc * b.fr; i++) plots.push({ x: fx + (i % b.fc) * PLOT.cx, y: fy + Math.floor(i / b.fc) * PLOT.cy, w: PLOT.w, h: PLOT.h, i });
  const fwIn = b.fc * PLOT.cx - (PLOT.cx - PLOT.w), fhIn = b.fr * PLOT.cy - (PLOT.cy - PLOT.h);
  const field = { x: fx - 12, y: fy - 8, w: fwIn + 16, h: fhIn + 14 };
  const crow = { x: fx - (portrait ? 26 : 32), y: fy + 20 }; // the scarecrow stands at the field's edge
  const door = { x: barn.x + barn.w / 2, y: barn.y + barn.h + 2 };
  const board = { x: barn.x + barn.w + 10, y: barn.y + 16, w: 26, h: 20 };
  const content = { x: x0, y: y0 - 8, w: b.cw, h: b.ch + 8 };
  return { W, H, T, play, portrait, barn, board, plots, field, pond, rest: yard, yard, door, rocks: [], reserve: null, crow, content, z,
    cap: { plots: plots.length, yard: b.yc * Math.ceil(nY / b.yc) } };
}
/** Where the n-th resting Claude sits in the yard. */
function yardSpot(L, i) {
  const Y = L.yard;
  if (!Y) return { x: L.barn.x - 2 + (i % 5) * 19, y: L.barn.y + L.barn.h + 16 + Math.floor(i / 5) * 16 };
  return { x: Y.x + 13 + (i % Y.cols) * YARD.cx, y: Y.y + 19 + Math.floor(i / Y.cols) * YARD.cy };
}

function blocked(L, x, y) {
  const inR = (r, pad = 0) => x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad + 4;
  if (inR(L.barn, 8) || (Scene.passive && inR(L.board, 6)) || inR(L.field, 2) || (L.reserve && inR(L.reserve, 12))) return true;
  if (L.yard && inR(L.yard, 6)) return true;
  if (L.crow && Math.abs(x - L.crow.x) < 12 && y > L.crow.y - 24 && y < L.crow.y + 6) return true;
  if (((x - L.pond.cx) / (L.pond.rx + 8)) ** 2 + ((y - L.pond.cy) / (L.pond.ry + 6)) ** 2 < 1) return true;
  return L.rocks.some(r => Math.abs(x - r.x) < r.w / 2 + 6 && y > r.y - 4 && y < r.y + r.h + 4);
}

function drawTree(g, x, y, r, rnd) {
  pxEllipse(g, x + 2, y + r - 1, r + 1, Math.max(3, r / 3), "rgba(20,32,10,.35)");
  g.fillStyle = G.trunk; g.fillRect(x - 2, y + r - 7, 4, 7);
  g.fillStyle = G.t0; g.fillRect(x - 3, y + r - 7, 1, 7); g.fillRect(x + 2, y + r - 7, 1, 7);
  pxCircle(g, x, y, r + 1, G.t0);
  pxCircle(g, x, y, r, G.t1);
  pxCircle(g, x - 1, y - 1, r - 2, G.t2);
  pxCircle(g, x - r * 0.3, y - r * 0.35, r * 0.55, G.t3);
  pxCircle(g, x - r * 0.4, y - r * 0.45, r * 0.25, G.t4);
  for (let i = 0; i < r * 1.6; i++) { // leafy speckle
    const a = rnd() * Math.PI * 2, d = rnd() * r * 0.9;
    g.fillStyle = rnd() < 0.5 ? G.t4 : G.t1;
    g.fillRect(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d), 1, 1);
  }
  g.fillStyle = G.t5; g.fillRect(Math.round(x - r * 0.45), Math.round(y - r * 0.5), 1, 1);
}

function drawRock(g, r) {
  const { x, y, w, h: hh } = r, x0 = Math.round(x - w / 2);
  pxEllipse(g, x + 1, y + hh, w / 2 + 1, 3, "rgba(20,32,10,.4)");
  g.fillStyle = G.r0; g.fillRect(x0 + 1, y, w - 2, hh + 1); g.fillRect(x0, y + 1, w, hh - 1);
  g.fillStyle = G.r1; g.fillRect(x0 + 1, y + 1, w - 2, hh - 1);
  g.fillStyle = G.r2; g.fillRect(x0 + 1, y + 1, w - 3, Math.round(hh * 0.55));
  g.fillStyle = G.r3; g.fillRect(x0 + 2, y + 1, w - 5, 2);
  g.fillStyle = G.r4; g.fillRect(x0 + 2, y + 1, 2, 1);
  // Claude's spark, carved (the Thronglets' rocks have their sigil too)
  const cx = Math.round(x), cy = Math.round(y + hh * 0.5);
  g.fillStyle = G.r0;
  for (const [dx, dy] of [[0, -2], [0, -1], [0, 1], [0, 2], [-2, 0], [-1, 0], [1, 0], [2, 0], [-1, -1], [1, 1], [1, -1], [-1, 1], [0, 0]]) g.fillRect(cx + dx, cy + dy, 1, 1);
}

function drawBarn(g, b) {
  const { x, y, w, h: hh } = b;
  pxEllipse(g, x + w / 2 + 3, y + hh, w / 2 + 4, 5, "rgba(20,32,10,.4)");
  const roofH = 16;
  // roof (stepped gable)
  for (let i = 0; i < roofH; i++) {
    const inset = Math.max(0, Math.round((roofH - i) * 0.9) - 2);
    g.fillStyle = i === 0 ? "#2d1511" : "#3b1c16"; g.fillRect(x - 2 + inset, y + i, w + 4 - inset * 2, 1);
    g.fillStyle = "#5e2a20"; g.fillRect(x - 1 + inset, y + i, Math.max(0, w + 2 - inset * 2), 1);
    if (i % 3 === 1) { g.fillStyle = "#70342a"; g.fillRect(x + inset, y + i, Math.max(0, w - inset * 2), 1); }
  }
  // walls
  const wy = y + roofH;
  g.fillStyle = "#3a1410"; g.fillRect(x, wy, w, hh - roofH);
  g.fillStyle = "#a8432f"; g.fillRect(x + 1, wy, w - 2, hh - roofH - 1);
  g.fillStyle = "#933826"; for (let px = x + 4; px < x + w - 2; px += 4) g.fillRect(px, wy, 1, hh - roofH - 1);
  g.fillStyle = "#c2563d"; g.fillRect(x + 1, wy, w - 2, 1);
  // loft window
  g.fillStyle = "#f3ead8"; g.fillRect(x + w / 2 - 5, y + 6, 10, 8);
  g.fillStyle = "#2d1a10"; g.fillRect(x + w / 2 - 4, y + 7, 8, 6);
  g.fillStyle = "#e7b24a"; g.fillRect(x + w / 2 - 3, y + 9, 6, 4);
  // door with the white X
  const dw = 18, dh = hh - roofH - 4, dx = x + w / 2 - dw / 2, dy = wy + 3;
  g.fillStyle = "#f3ead8"; g.fillRect(dx - 1, dy - 1, dw + 2, dh + 1);
  g.fillStyle = "#7a2c1f"; g.fillRect(dx, dy, dw, dh);
  g.fillStyle = "#f3ead8";
  for (let i = 0; i < dh; i++) { const t = Math.round((i / dh) * (dw - 1)); g.fillRect(dx + t, dy + i, 1, 1); g.fillRect(dx + dw - 1 - t, dy + i, 1, 1); }
  g.fillRect(dx + dw / 2, dy, 1, dh);
  // hay bales by the wall
  for (const [hx, hy] of [[x + w + 2, y + hh - 7], [x - 10, y + hh - 7]]) {
    g.fillStyle = "#7a5a1a"; g.fillRect(hx, hy, 9, 7);
    g.fillStyle = "#e0b64e"; g.fillRect(hx + 1, hy + 1, 7, 5);
    g.fillStyle = "#c7973a"; g.fillRect(hx + 1, hy + 3, 7, 1);
  }
}

function drawPlotBase(g, p) {
  g.fillStyle = G.soilo; g.fillRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2);
  g.fillStyle = G.soil; g.fillRect(p.x, p.y, p.w, p.h);
  for (let yy = p.y + 2; yy < p.y + p.h; yy += 4) { g.fillStyle = G.soil2; g.fillRect(p.x + 1, yy, p.w - 2, 1); g.fillStyle = G.soil3; g.fillRect(p.x + 1, yy - 1, p.w - 2, 1); }
}

/** The yard: trampled straw where resting Claudes nap, fenced, with a gate by the barn. */
function drawYard(g, Y, rnd) {
  g.fillStyle = "rgba(90,70,30,.28)"; g.fillRect(Y.x - 1, Y.y - 1, Y.w + 2, Y.h + 2);
  g.fillStyle = "#b99a55"; g.fillRect(Y.x, Y.y, Y.w, Y.h);
  for (let i = 0; i < (Y.w * Y.h) / 14; i++) { g.fillStyle = ["#d8bb6c", "#a4843f", "#c9a95c"][i % 3]; g.fillRect(Math.round(Y.x + rnd() * (Y.w - 2)), Math.round(Y.y + rnd() * (Y.h - 1)), 2, 1); }
  g.fillStyle = "#5e3f22"; // the fence: rails and posts, open at the top (the barn's door)
  for (const yy of [Y.y + Y.h, Y.y + Y.h - 3]) g.fillRect(Y.x - 2, yy, Y.w + 4, 1);
  for (let x = Y.x - 2; x <= Y.x + Y.w + 2; x += 8) { g.fillRect(x, Y.y + Y.h - 5, 2, 7); }
  for (const xx of [Y.x - 2, Y.x + Y.w + 1]) { g.fillRect(xx, Y.y, 1, Y.h); for (let y = Y.y; y < Y.y + Y.h; y += 8) g.fillRect(xx - 1, y, 3, 2); }
}

function buildWorld(L, seed = 7) {
  const W = L.W, H = L.H, rnd = mulberry32(seed);
  const bg = canvas(W, H), g = bg.getContext("2d");
  const fg = canvas(W, H), f = fg.getContext("2d");
  // grass: two octaves of value noise, ordered dithering between five tones, a worn clearing in the middle
  const n1 = valueNoise(seed + 1), n2 = valueNoise(seed + 2), img = g.createImageData(W, H), d = img.data;
  const tones = [G.g0, G.g1, G.g2, G.g3, G.g4, G.worn].map(c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  const cx = (L.play.x0 + L.play.x1) / 2, cy = (L.play.y0 + L.play.y1) / 2 + 6, rx = (L.play.x1 - L.play.x0) * 0.5, ry = (L.play.y1 - L.play.y0) * 0.52;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
    let t = n1(x / 22, y / 22) * 0.62 + n2(x / 7, y / 7) * 0.38 + (1 - Math.min(1.4, e)) * 0.34;
    t += (BAYER[y & 3][x & 3] / 16 - 0.5) * 0.14;
    const k = clamp(Math.floor((t - 0.18) * 5.2), 0, 5), i = (y * W + x) * 4;
    [d[i], d[i + 1], d[i + 2]] = tones[k]; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // hexagon-ish worn tiles in the clearing, like the reference's path stones
  g.strokeStyle = "rgba(60,80,25,.25)";
  for (let i = 0; i < 16; i++) {
    const x = cx + (rnd() - 0.5) * rx * 1.2, y = cy + (rnd() - 0.5) * ry * 1.1, s = 8 + rnd() * 6;
    g.fillStyle = "rgba(160,176,96,.18)";
    for (let yy = -s / 2; yy < s / 2; yy++) { const w = s - Math.abs(yy) * 0.8; g.fillRect(Math.round(x - w), Math.round(y + yy), Math.round(w * 2), 1); }
  }
  // tufts and flowers
  for (let i = 0; i < (W * H) / 260; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H), r = rnd();
    if (r < 0.62) { g.fillStyle = rnd() < 0.5 ? G.g0 : G.g1; g.fillRect(x, y, 1, 2); g.fillRect(x + 2, y + 1, 1, 1); }
    else if (r < 0.8) { g.fillStyle = G.g4; g.fillRect(x, y, 1, 1); }
    else if (!blocked(L, x, y)) { g.fillStyle = ["#f4f1e8", "#f5c542", "#f59cc0", "#b9d9ff"][Math.floor(rnd() * 4)]; g.fillRect(x, y, 1, 1); g.fillStyle = "rgba(255,255,255,.5)"; g.fillRect(x + 1, y, 1, 1); }
  }
  // pond
  const P = L.pond;
  pxEllipse(g, P.cx, P.cy + 1, P.rx + 2, P.ry + 2, "#3d5a22");
  pxEllipse(g, P.cx, P.cy, P.rx + 1, P.ry + 1, G.w0);
  pxEllipse(g, P.cx, P.cy + 1, P.rx, P.ry, G.w1);
  pxEllipse(g, P.cx - 3, P.cy - 2, P.rx - 6, P.ry - 4, G.w2);
  for (let i = 0; i < 8; i++) { g.fillStyle = G.w3; g.fillRect(Math.round(P.cx - P.rx / 2 + rnd() * P.rx), Math.round(P.cy - P.ry / 2 + rnd() * P.ry), 3, 1); }
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { g.fillStyle = "#2f5a1f"; g.fillRect(Math.round(P.cx + s * (P.rx - 2 + i * 2)), P.cy - 4 - i, 1, 5); g.fillStyle = "#6b4a2b"; g.fillRect(Math.round(P.cx + s * (P.rx - 2 + i * 2)), P.cy - 5 - i, 1, 2); }
  // rocks (placed where nothing else is)
  for (let tries = 0, want = clamp(Math.round((W * H) / 36000), L.portrait ? 2 : 4, 12); L.rocks.length < want && tries < 400; tries++) {
    const w = 12 + Math.floor(rnd() * 8), r = { x: L.play.x0 + 10 + rnd() * (L.play.x1 - L.play.x0 - 20), y: L.play.y0 + rnd() * (L.play.y1 - L.play.y0 - 12), w, h: Math.round(w * 0.75) };
    if (!blocked(L, r.x, r.y) && !blocked(L, r.x, r.y + r.h) && L.rocks.every(o => Math.hypot(o.x - r.x, o.y - r.y) > 40)
        && Math.hypot(r.x - L.door.x, r.y - L.door.y) > 40) L.rocks.push(r);
  }
  L.rocks.forEach(r => drawRock(g, r));
  // field plots, barn
  if (L.yard) drawYard(g, L.yard, rnd);
  L.plots.forEach(p => drawPlotBase(g, p));
  drawBarn(g, L.barn);
  // trees round the edge: back rows on the background, the bottom row in front of everything
  const trees = [], T = L.T;
  for (let x = -6; x < W + 12; x += 12 + rnd() * 9) { trees.push([x, 2 + rnd() * (T - 16), 10 + rnd() * 5]); if (rnd() < 0.6) trees.push([x + 6, -6 + rnd() * 8, 11 + rnd() * 4]); }
  for (let y = T - 4; y < H - T + 6; y += 12 + rnd() * 8) {
    trees.push([2 + rnd() * (T - 14), y, 9 + rnd() * 5]); trees.push([W - 2 - rnd() * (T - 14), y, 9 + rnd() * 5]);
    if (rnd() < 0.5) trees.push([-4, y + 6, 11]); if (rnd() < 0.5) trees.push([W + 4, y + 6, 11]);
  }
  const front = [];
  for (let x = -6; x < W + 12; x += 12 + rnd() * 9) front.push([x, H - T + 12 + rnd() * 10, 11 + rnd() * 5]);
  trees.sort((a, b) => a[1] - b[1]).forEach(([x, y, r]) => drawTree(g, Math.round(x), Math.round(y), Math.round(r), rnd));
  front.sort((a, b) => a[1] - b[1]).forEach(([x, y, r]) => drawTree(f, Math.round(x), Math.round(y), Math.round(r), rnd));
  return { L, bg, fg };
}

// crops: the field shows the work. Running tasks grow; finished ones bloom into Claude's spark; failed ones wilt.
function drawCrop(g, x, y, stage, t, glow) {
  const sway = Math.round(Math.sin(t * 1.6 + x) * 0.6);
  if (stage === "seed") { g.fillStyle = "#8fd06a"; g.fillRect(x, y - 1, 1, 1); g.fillRect(x + 1, y - 2, 1, 1); return; }
  if (stage === "wilt") { g.fillStyle = "#7a6a3a"; g.fillRect(x, y - 4, 1, 4); g.fillRect(x + 1, y - 4, 2, 1); g.fillStyle = "#5c4b27"; g.fillRect(x + 3, y - 3, 1, 1); return; }
  const tall = stage === "sprout" ? 4 : 7;
  g.fillStyle = "#3f8f35"; g.fillRect(x + sway, y - tall, 1, tall);
  g.fillStyle = "#6fcf5b"; g.fillRect(x - 2 + sway, y - tall + 2, 2, 1); g.fillRect(x + 1 + sway, y - tall + 3, 2, 1);
  if (stage === "grow") { g.fillStyle = "#d97757"; g.fillRect(x + sway, y - tall - 1, 1, 1); }
  if (stage === "ripe") { // the spark
    const cx = x + sway, cy = y - tall - 2;
    if (glow) { g.fillStyle = "rgba(255,200,140,.35)"; g.fillRect(cx - 3, cy - 3, 7, 7); }
    g.fillStyle = "#d97757";
    for (const [dx, dy] of [[0, -2], [0, -1], [0, 1], [0, 2], [-2, 0], [-1, 0], [1, 0], [2, 0], [-1, -1], [1, 1], [1, -1], [-1, 1]]) g.fillRect(cx + dx, cy + dy, 1, 1);
    g.fillStyle = "#ffd59e"; g.fillRect(cx, cy, 1, 1);
  }
}

// ==================================================================== critters
class Critter {
  constructor(key, x, y) {
    Object.assign(this, { key, x, y, tx: x, ty: y, wait: Math.random() * 2, dir: 0, moving: false, phase: 0,
      phaseT: 0, blinkT: 2 + Math.random() * 3, blink: 0, born: performance.now(), hop: 0, speed: 20 + Math.random() * 6 });
    this.mode = "wander"; this.kind = "claude"; this.hat = "straw"; this.color = HAT_COLORS[0]; this.skin = null;
    this.label = ""; this.bubble = null; this.gone = 0; this.home = null;
  }
  setTarget(x, y) { this.tx = x; this.ty = y; }
  update(dt, world) {
    const L = world.L;
    if (this.kind === "egg") { this.hop = (this.hop + dt) % 3; return; }
    this.blinkT -= dt;
    if (this.blinkT < 0) { this.blink = 0.14; this.blinkT = 2 + Math.random() * 4; }
    this.blink = Math.max(0, this.blink - dt);
    let goal = null;
    if ((this.mode === "work" || this.mode === "subwait") && this.spot) goal = this.spot;
    else if (this.mode === "sleep" || (this.mode === "offline" && this.home)) goal = this.home || world.restSpot(this);
    else if (this.mode === "starting") goal = { x: L.door.x + ((hashStr(this.key) % 5) - 2) * 7, y: L.door.y + 8 };
    if (goal) { this.tx = goal.x; this.ty = goal.y; }
    else if (this.mode === "wander") {
      if (Math.abs(this.tx - this.x) + Math.abs(this.ty - this.y) < 1.5) {
        this.wait -= dt;
        if (this.wait <= 0) { const p = world.randomSpot(); this.tx = p.x; this.ty = p.y; this.wait = 1 + Math.random() * 4; }
      }
    } else { this.tx = this.x; this.ty = this.y; }
    const dx = this.tx - this.x, dy = this.ty - this.y;
    if (Math.abs(dx) + Math.abs(dy) < 1.2) { this.moving = false; this.phase = 0; if (this.mode === "work") this.dir = 1; }
    else {
      const dist = Math.hypot(dx, dy);
      this.moving = true;
      const sp = (this.mode === "work" ? 34 : this.speed) * dt * (REDUCED ? 0.7 : 1);
      const nx = this.x + (dx / dist) * Math.min(sp, dist), ny = this.y + (dy / dist) * Math.min(sp, dist);
      const R = L.reserve, inside = (x, y) => R && x > R.x - 6 && x < R.x + R.w + 6 && y > R.y - 2 && y < R.y + R.h + 16;
      if (!inside(nx, ny) || inside(this.x, this.y)) { this.x = nx; this.y = ny; }
      else if (!inside(nx, this.y)) this.x = nx; // slide round the title instead of walking through it
      else if (!inside(this.x, ny)) this.y = ny;
      else if (this.mode === "wander") { const p = world.randomSpot(); this.tx = p.x; this.ty = p.y; }
      this.dir = Math.abs(dx) > 0.5 ? Math.sign(dx) : this.dir;
      this.phaseT += dt; if (this.phaseT > 0.16) { this.phaseT = 0; this.phase = this.phase === 1 ? 2 : 1; }
    }
    if (this.mode === "error") this.hop = (this.hop + dt * 6) % (Math.PI * 2);
  }
  sprite(t) {
    if (this.kind === "egg") return EGG;
    if (this.mini) return miniSprite(this.color, { legs: this.phase, blink: this.blink > 0 || this.mode === "subwait",
      arms: this.mode === "work" && !this.moving && Math.floor(t * 6) % 2 ? 1 : 0 });
    const sleep = this.mode === "sleep" && !this.moving;
    const typing = this.mode === "work" && !this.moving;
    const cheer = performance.now() - this.born < 1800;
    return skinFrame(this.skin || (this.skin = skinOf(this.hat, null, "", this.color)), {
      look: this.dir, legs: this.phase, blink: this.blink > 0 || this.mode === "offline", sleep,
      arms: (typing && Math.floor(t * 6) % 2) || (cheer && Math.floor(t * 4) % 2) ? 1 : 0,
    });
  }
  bob(t) {
    if (this.kind === "egg") return 0;
    if (this.mode === "error") return -Math.abs(Math.sin(this.hop)) * 3;
    if (this.moving) return this.phase === 1 ? -1 : 0;
    if (this.mini && this.mode === "subwait") return 0;
    if (this.mode === "sleep") return 1;
    return Math.sin(t * 2 + this.x) > 0.7 ? -1 : 0; // idle breathing
  }
}

// ======================================================================= scene
/** The farm's canvas. The world can be bigger than the window: a camera (x, y in world pixels, z = CSS px per world
 * pixel) fits it by default; drag or swipe to pan, wheel or pinch to zoom. The landing page and the title screen keep
 * the old fixed view (the world is the window, z = S). */
const Scene = {
  cv: $("#world"), ctx: null, S: 3, world: null, critters: new Map(), sparkles: [],
  labels: $("#labels"), selected: null, hover: null, plotTasks: [], plotMore: [], boardCount: 0, demo: false, t: 0,
  cam: { x: 0, y: 0, z: 3, auto: true }, goal: null, dpr: 1, need: null, farm: false, planner: null, pendingFor: {},
  TAGS_AT: 2.6, BUBBLES_AT: 1.9, MINI_BUBBLES_AT: 3.6, // zoom (CSS px per world px) from which every name tag / bubble shows
  init() {
    this.ctx = this.cv.getContext("2d");
    addEventListener("resize", () => { clearTimeout(this.resizeT); this.resizeT = setTimeout(() => this.resize(), 80); });
    this.bindPointer();
    this.resize();
    const hudTop = $("#hud-top");
    if (hudTop && window.ResizeObserver) new ResizeObserver(() => { // the HUD grew (your Claude's card, approvals): refit
      if (!this.farm || !this.insets || !hudTop.getBoundingClientRect().width) return;
      const v = this.viewBox(), o = this.insets;
      if (Math.abs(v.left - o.left) > 30 || Math.abs(v.top - o.top) > 30) { clearTimeout(this.resizeT); this.resizeT = setTimeout(() => this.resize(), 150); }
    }).observe(hudTop);
    let last = performance.now();
    const loop = (now) => { const dt = Math.min(0.05, (now - last) / 1000); last = now; this.t += dt; this.frame(dt); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  },
  /** The window in CSS px, and how much of it the HUD covers (the fit keeps the farm clear of it). */
  viewBox() {
    const w = innerWidth, hh = innerHeight, phone = w < 760, S = clamp(Math.round(Math.min(w / 330, hh / 205)), 2, 6);
    if (!this.farm) return { w, h: hh, S, top: 0, bottom: 0, left: 0, right: 0 };
    // the counter and chips sit top-left: beside the farm on a wide window, above it on a tall one
    const r = $("#hud-top")?.getBoundingClientRect(), hud = r && r.width ? r : { right: 300, bottom: 200 };
    this.hudBox = { right: Math.round(hud.right), bottom: Math.round(hud.bottom) };
    const wide = w > hh * 1.15 && hud.right < w * 0.4;
    return { w, h: hh, S, top: wide ? 8 : hud.bottom + 6, bottom: phone ? 150 : 88, left: wide ? hud.right + 10 : 0, right: phone ? 46 : 64 };
  },
  resize() {
    const v = this.viewBox(), S = v.S;
    this.S = S; this.insets = { left: v.left, top: v.top }; this.dpr = Math.min(2, devicePixelRatio || 1);
    this.cv.width = Math.round(v.w * this.dpr); this.cv.height = Math.round(v.h * this.dpr);
    this.cv.style.width = v.w + "px"; this.cv.style.height = v.h + "px";
    let L;
    if (this.farm) L = layoutFarm(this.need || { plots: 6, yard: 5 }, v);
    else {
      const W = Math.ceil(v.w / S), H = Math.ceil(v.h / S), opts = { ...(this.layout || {}) };
      const keep = opts.clearOf && document.querySelector(opts.clearOf);
      if (keep) { // keep this element's area free of the field and the critters (in world pixels)
        const r = keep.getBoundingClientRect();
        opts.reserve = { x: Math.floor(r.left / S) - 10, y: Math.floor(r.top / S) - 4, w: Math.ceil(r.width / S) + 20, h: Math.ceil(r.height / S) + 8 };
      }
      L = layoutWorld(W, H, opts); L.z = S;
    }
    this.world = buildWorld(L, 7);
    this.world.randomSpot = () => this.randomSpot();
    this.world.restSpot = (c) => yardSpot(L, hashStr(c.key) % 10);
    if (this.cam.auto || !this.farm) this.fit(); else { this.cam.z = Math.max(this.cam.z, L.z); this.clampCam(); }
    this.goal = null;
    for (const c of this.critters.values()) {
      if (c.x > L.W || c.y > L.H || (c.mode === "wander" && blocked(L, c.x, c.y))) { const p = this.randomSpot(); c.x = p.x; c.y = p.y; }
      c.tx = c.x; c.ty = c.y;
    }
    this.relayout = true; // reconcile moves everyone to their new spots
    if (this.farm && App.state && !this.reconciling) reconcile(App.state);
  },
  /** Grow (or shrink) the world when the farm outgrows its plots or yard. True when it rebuilt. */
  setNeed(n) {
    const cap = this.world?.L.cap;
    if (cap && n.plots <= cap.plots && n.yard <= cap.yard && !(cap.plots > 8 && n.plots < cap.plots * 0.45)
      && !(cap.yard > 12 && n.yard < cap.yard * 0.45)) return false;
    this.need = { plots: Math.ceil(n.plots * 1.15) + 1, yard: Math.ceil(n.yard * 1.1) + 2 };
    this.resize();
    return true;
  },
  // ------------------------------------------------------------------ camera
  fit() {
    const L = this.world.L, v = this.viewBox(), c = this.cam, box = L.content;
    c.z = L.z; c.auto = true;
    if (box) {
      c.x = box.x + box.w / 2 - (v.left + (v.w - v.left - v.right) / 2) / c.z;
      c.y = box.y + box.h / 2 - (v.top + (v.h - v.top - v.bottom) / 2) / c.z;
    } else { c.x = 0; c.y = 0; }
    this.clampCam();
  },
  clampCam(c = this.cam) {
    const L = this.world.L, vw = innerWidth / c.z, vh = innerHeight / c.z;
    c.x = L.W <= vw ? (L.W - vw) / 2 : clamp(c.x, 0, L.W - vw);
    c.y = L.H <= vh ? (L.H - vh) / 2 : clamp(c.y, 0, L.H - vh);
  },
  zoomLimits() { const z0 = this.world.L.z; return [z0, Math.max(8, z0 * 3)]; },
  zoomAt(sx, sy, factor) {
    const c = this.cam, [lo, hi] = this.zoomLimits(), wx = c.x + sx / c.z, wy = c.y + sy / c.z;
    this.goal = null;
    c.z = clamp(c.z * factor, lo, hi); c.x = wx - sx / c.z; c.y = wy - sy / c.z; c.auto = false;
    this.clampCam();
  },
  zoomBy(factor) { this.zoomAt(innerWidth / 2, innerHeight / 2, factor); },
  /** Glide the camera to a world point, zoomed in enough to see names. */
  focus(x, y, z) {
    const [lo, hi] = this.zoomLimits();
    z = clamp(z || Math.max(this.cam.z, this.TAGS_AT + 0.6, this.S), lo, hi);
    const g = { x: x - innerWidth / 2 / z, y: y - innerHeight / 2 / z, z };
    this.clampCam(g); this.goal = g; this.cam.auto = false;
  },
  focusCritter(c) { if (c) { this.focus(c.x, c.y - 8); this.follow = { key: c.key, until: performance.now() + 6000 }; } },
  // ------------------------------------------------------------------- input
  toWorld(e) { return { x: this.cam.x + e.clientX / this.cam.z, y: this.cam.y + e.clientY / this.cam.z }; },
  bindPointer() {
    const cv = this.cv, pts = new Map();
    let drag = null, pinch = null;
    const off = () => this.demo || this.passive || !this.farm;
    cv.addEventListener("pointerdown", (e) => {
      if (off()) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try { cv.setPointerCapture(e.pointerId); } catch { /* fine */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        if (drag) drag.moved = true;
      }
    });
    cv.addEventListener("pointermove", (e) => {
      if (off()) return;
      if (!pts.has(e.pointerId)) { if (e.pointerType === "mouse") this.onMove(e); return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.zoomAt(mx, my, (pinch.z * d / pinch.d) / this.cam.z);
        this.cam.x -= (mx - pinch.mx) / this.cam.z; this.cam.y -= (my - pinch.my) / this.cam.z; this.clampCam();
        pinch.mx = mx; pinch.my = my;
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; cv.classList.add("grabbing"); }
        if (drag.moved) { this.goal = null; this.cam.auto = false; this.cam.x = drag.cx - dx / this.cam.z; this.cam.y = drag.cy - dy / this.cam.z; this.clampCam(); }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        if (drag && !drag.moved && e.type === "pointerup") this.onClick(e);
        drag = null; cv.classList.remove("grabbing");
      } else if (drag) { const [p] = [...pts.values()]; drag = { x: p.x, y: p.y, cx: this.cam.x, cy: this.cam.y, moved: true }; }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => {
      if (off()) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : 1; // lines -> pixels
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * (e.ctrlKey ? 0.012 : 0.0018)));
    }, { passive: false });
    cv.addEventListener("pointerleave", () => { if (this.hover) { this.hover = null; } });
  },
  randomSpot() {
    const L = this.world.L;
    for (let i = 0; i < 60; i++) {
      const x = L.play.x0 + 8 + Math.random() * (L.play.x1 - L.play.x0 - 16), y = L.play.y0 + 16 + Math.random() * (L.play.y1 - L.play.y0 - 16);
      if (!blocked(L, x, y)) return { x, y };
    }
    return { x: L.door.x, y: L.door.y + 12 };
  },
  restSpot(c) { return this.world.restSpot(c); },
  hit(p) {
    let best = null;
    for (const c of this.critters.values()) {
      if (c.gone) continue;
      const w = c.kind === "egg" ? 7 : c.mini ? 6 : 9, top = c.mini ? 10 : 19;
      if (p.x > c.x - w && p.x < c.x + w && p.y > c.y - top && p.y < c.y + 2 && (!best || c.y > best.y)) best = c;
    }
    if (best) return { critter: best };
    const cr = this.world.L.crow;
    if (cr && this.planner && Math.abs(p.x - cr.x) < 9 && p.y > cr.y - 23 && p.y < cr.y + 2) return { crow: true };
    return null;
  },
  onMove(e) {
    if (this.demo || this.passive) return;
    const r = this.hit(this.toWorld(e));
    this.hover = r?.critter || null; this.hoverCrow = !!r?.crow;
    this.cv.classList.toggle("pointing", !!r);
  },
  onClick(e) {
    if (this.demo || this.passive) return;
    const r = this.hit(this.toWorld(e));
    if (!r) { this.selected = null; return; }
    if (r.crow) return UI.openPlanner();
    if (r.critter) { this.selected = r.critter; UI.openCritter(r.critter); }
  },
  sparkle(x, y, n = 14, color) {
    if (this.sparkles.length > 400) return;
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = 10 + Math.random() * 26;
      this.sparkles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 12, life: 0.7 + Math.random() * 0.5, c: color || ["#fff4c2", "#ffd59e", "#f2a07a", "#ffffff"][i % 4] }); }
  },
  frame(dt) {
    const g = this.ctx, w = this.world, L = w.L, t = this.t, cam = this.cam, now = performance.now();
    if (this.goal) { // glide
      const k = 1 - Math.exp(-dt * 7), G2 = this.goal;
      cam.x = lerp(cam.x, G2.x, k); cam.y = lerp(cam.y, G2.y, k); cam.z = lerp(cam.z, G2.z, k);
      if (Math.abs(cam.x - G2.x) + Math.abs(cam.y - G2.y) < 0.3 && Math.abs(cam.z - G2.z) < 0.01) { Object.assign(cam, { x: G2.x, y: G2.y, z: G2.z }); this.goal = null; }
    }
    const Z = cam.z * this.dpr, vx0 = cam.x, vy0 = cam.y, vx1 = cam.x + innerWidth / cam.z, vy1 = cam.y + innerHeight / cam.z;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (vx0 < 0 || vy0 < 0 || vx1 > L.W || vy1 > L.H) { g.fillStyle = G.t0; g.fillRect(0, 0, this.cv.width, this.cv.height); }
    g.setTransform(Z, 0, 0, Z, Math.round(-cam.x * Z), Math.round(-cam.y * Z));
    g.imageSmoothingEnabled = false;
    const sx = Math.max(0, Math.floor(vx0)), sy = Math.max(0, Math.floor(vy0));
    const sw = Math.min(L.W, Math.ceil(vx1) + 1) - sx, sh = Math.min(L.H, Math.ceil(vy1) + 1) - sy;
    if (sw > 0 && sh > 0) g.drawImage(w.bg, sx, sy, sw, sh, sx, sy, sw, sh);
    const seen = (x, y, m = 24) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m + 20;
    // crops, and a sign on plots with more minis than they draw
    this.plotTasks.forEach((task, i) => {
      const p = L.plots[i]; if (!p || !task || !seen(p.x, p.y, 40)) return;
      const stage = task.status === "done" ? "ripe" : task.status === "waiting" ? "grow" : task.status === "failed" ? "wilt"
        : (nowS() - (task.started || task.updated || nowS())) < 120 ? "seed" : (nowS() - (task.started || 0)) < 900 ? "sprout" : "grow";
      for (let k = 0; k < 3; k++) drawCrop(g, p.x + 5 + k * 8, p.y + p.h - 3, stage, t + k, task.status === "done");
    });
    this.plotMore.forEach((n, i) => { const p = L.plots[i]; if (n > 0 && p && seen(p.x, p.y, 40)) drawSign(g, p.x + 30, p.y - 14, "+" + n); });
    // the planner's scarecrow
    const cr = L.crow;
    if (cr && this.planner && seen(cr.x, cr.y)) {
      const on = this.planner.on, f = on ? (REDUCED ? 0 : Math.floor(t * 1.4) % 2) : 2;
      pxEllipse(g, cr.x, cr.y, 6, 2, "rgba(20,28,10,.35)");
      g.drawImage(SCARECROW[f], Math.round(cr.x - 8), Math.round(cr.y - 21 + (on && !REDUCED && Math.floor(t * 2.8) % 2 ? -1 : 0)));
      if (this.hoverCrow) { g.fillStyle = "#fff"; g.fillRect(cr.x - 2, cr.y - 27, 5, 1); g.fillRect(cr.x - 1, cr.y - 26, 3, 1); g.fillRect(cr.x, cr.y - 25, 1, 1); }
    }
    // the quest board: the landing page's scripted farm only (the real farm has no queue to pin up)
    if (this.passive) {
      const b = L.board;
      g.fillStyle = "rgba(20,32,10,.35)"; g.fillRect(b.x + 1, b.y + b.h + 5, b.w, 3);
      g.fillStyle = "#4a3120"; g.fillRect(b.x + 2, b.y + 4, 2, b.h + 4); g.fillRect(b.x + b.w - 4, b.y + 4, 2, b.h + 4);
      g.fillStyle = "#3a2616"; g.fillRect(b.x, b.y, b.w, b.h - 2);
      g.fillStyle = "#8a6038"; g.fillRect(b.x + 1, b.y + 1, b.w - 2, b.h - 4);
      g.fillStyle = "#a37446"; g.fillRect(b.x + 1, b.y + 1, b.w - 2, 1);
      for (let i = 0; i < Math.min(6, this.boardCount); i++) {
        const nx = b.x + 3 + (i % 3) * 7, ny = b.y + 3 + Math.floor(i / 3) * 7;
        g.fillStyle = i % 2 ? "#fff4c2" : "#f6f1e4"; g.fillRect(nx, ny, 5, 5);
        g.fillStyle = "#b9ad90"; g.fillRect(nx + 1, ny + 2, 3, 1);
        g.fillStyle = "#c0392b"; g.fillRect(nx + 2, ny, 1, 1);
      }
    }
    // critters, depth-sorted; only the ones in view are drawn
    const list = [...this.critters.values()];
    for (const c of list) c.update(dt, w);
    list.sort((a, c) => a.y - c.y);
    const vis = [];
    for (const c of list) {
      if (!seen(c.x, c.y)) continue;
      vis.push(c);
      const s = c.sprite(t), bob = Math.round(c.bob(t));
      const fade = c.gone ? clamp(1 - (now - c.gone) / 500, 0, 1) : clamp((now - c.born) / 350, 0, 1);
      g.globalAlpha = fade;
      pxEllipse(g, Math.round(c.x), Math.round(c.y), c.kind === "egg" ? 5 : c.mini ? 4 : 7, c.mini ? 1 : 2, "rgba(20,28,10,.35)");
      if (c.mini) {
        g.drawImage(s, Math.round(c.x - 5), Math.round(c.y - 8 + bob));
        if (c.mode === "work" && !c.moving) { g.fillStyle = "#1b1f2a"; g.fillRect(Math.round(c.x + 3), Math.round(c.y - 4), 4, 3); g.fillStyle = Math.floor(t * 3) % 2 ? "#7cfc9a" : "#22303c"; g.fillRect(Math.round(c.x + 4), Math.round(c.y - 3), 2, 1); }
      } else if (c.kind === "egg") {
        const wob = Math.floor(c.hop * 4) % 6 === 0 ? (Math.floor(c.hop * 8) % 2 ? 1 : -1) : 0;
        g.drawImage(s, Math.round(c.x - 6 + wob), Math.round(c.y - 12));
      } else {
        g.drawImage(s, Math.round(c.x - 8), Math.round(c.y - (HAT_H + 12) + 1 + bob));
        if (c.mode === "work" && !c.moving && !c.mini) g.drawImage(Math.floor(t * 3) % 2 ? LAPTOP_ON : LAPTOP_OFF, Math.round(c.x + 4), Math.round(c.y - 6));
      }
      g.globalAlpha = 1;
      if (c.gone || c.mini) continue;
      const top = Math.round(c.y - (c.kind === "egg" ? 20 : 27));
      if (c === this.selected) { const ay = Math.round(top + Math.sin(t * 5) * 1.5); g.fillStyle = "#fff"; g.fillRect(c.x - 2, ay, 5, 1); g.fillRect(c.x - 1, ay + 1, 3, 1); g.fillRect(c.x, ay + 2, 1, 1); }
      else if (c.agent?.mine) { const ay = top + (Math.floor(t * 2) % 2); g.fillStyle = "#ffd59e"; g.fillRect(c.x - 2, ay, 5, 1); g.fillRect(c.x - 1, ay + 1, 3, 1); g.fillRect(c.x, ay + 2, 1, 1); }
      if (this.pendingFor[c.agent?.id]) { // missions waiting for its person: a red flag that pulses
        const fx = Math.round(c.x + 5), fy = Math.round(c.y - 26);
        g.fillStyle = "#3a1410"; g.fillRect(fx, fy, 1, 9);
        g.fillStyle = Math.floor(t * 3) % 2 ? "#e0513c" : "#ff8a70"; g.fillRect(fx + 1, fy, 6, 6);
        g.fillStyle = "#fff"; g.fillRect(fx + 3, fy + 1, 2, 2); g.fillRect(fx + 3, fy + 4, 2, 1);
      }
    }
    for (const c of list) if (c.gone && now - c.gone > 520) { this.critters.delete(c.key); c.el?.remove(); c.tagEl?.remove(); }
    if (sw > 0 && sh > 0) g.drawImage(w.fg, sx, sy, sw, sh, sx, sy, sw, sh);
    // sparkles
    this.sparkles = this.sparkles.filter(p => (p.life -= dt) > 0);
    for (const p of this.sparkles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 40 * dt; g.fillStyle = p.c; g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); }
    this.placeLabels(list, vis);
  },
  /** Speech bubbles and name tags (DOM, so they stay crisp): only for critters in view, and only when zoomed in far
   * enough to read them (or on hover / selection). */
  placeLabels(list, vis) {
    if (this.demo) return;
    const cam = this.cam, z = cam.z, px = (x) => Math.round((x - cam.x) * z), py = (y) => Math.round((y - cam.y) * z);
    const inView = new Set(vis);
    for (const c of list) {
      const focus = c === this.selected || c === this.hover;
      let want = c.gone || !inView.has(c) ? null : c.bubble;
      if (want && !focus && z < (c.mini ? this.MINI_BUBBLES_AT : this.BUBBLES_AT) && !want.alert) want = null;
      if (want && !focus && c.mode === "offline" && z < this.TAGS_AT + 1.4) want = null; // a yard of "not running" icons is noise
      if (want?.title) want = { ...want, text: focus ? want.title.slice(0, 30) : "" };
      if (want) {
        if (!c.el) { c.el = h("div", { class: "bubble" }); this.labels.append(c.el); }
        const sig = want.icon + "|" + (want.text || "") + "|" + (want.alert ? 1 : 0);
        if (c.el.dataset.sig !== sig) {
          c.el.dataset.sig = sig; c.el.className = "bubble" + (want.alert ? " alert" : ""); fill(c.el, h("img", { src: icon(want.icon), alt: "" }), want.text ? h("span", { text: want.text }) : null);
        }
        const lift = c.kind === "egg" ? 16 : c.mini ? 13 : 25, tr = `translate(${px(c.x)}px, ${py(c.y - lift)}px) translate(-50%, -100%)`;
        if (c.el._tr !== tr) { c.el._tr = tr; c.el.style.transform = tr; }
      } else if (c.el) { c.el.remove(); c.el = null; }
      const showTag = inView.has(c) && !c.gone && c.label && (focus || c.agent?.mine || (z >= this.TAGS_AT && c.mode !== "sleep" && c.mode !== "offline"));
      if (showTag) {
        if (!c.tagEl) { c.tagEl = h("div", { class: "tag" }); this.labels.append(c.tagEl); }
        if (c.tagEl.textContent !== c.label) c.tagEl.textContent = c.label;
        c.tagEl.classList.toggle("sel", focus);
        c.tagEl.classList.toggle("mine", !!c.agent?.mine);
        const tr = `translate(${px(c.x)}px, ${py(c.y + 3)}px) translate(-50%, 0)`;
        if (c.tagEl._tr !== tr) { c.tagEl._tr = tr; c.tagEl.style.transform = tr; }
      } else if (c.tagEl) { c.tagEl.remove(); c.tagEl = null; }
    }
    // the scarecrow says what the planner is doing
    const cr = this.world.L.crow, P = this.planner;
    if (cr && P && this.farm) {
      if (!this.crowEl) { this.crowEl = h("div", { class: "bubble crow" }); this.labels.append(this.crowEl); }
      const text = !P.on ? "ZZZ" : z < this.BUBBLES_AT && !this.hoverCrow ? "…" : String(P.state || "planning").slice(0, 28).toUpperCase();
      const sig = (P.on ? 1 : 0) + text;
      if (this.crowEl.dataset.sig !== sig) { this.crowEl.dataset.sig = sig; fill(this.crowEl, h("img", { src: icon(P.on ? "plan" : "zzz"), alt: "" }), h("span", { text })); this.crowEl.classList.toggle("off", !P.on); }
      const tr = `translate(${px(cr.x)}px, ${py(cr.y - 24)}px) translate(-50%, -100%)`;
      if (this.crowEl._tr !== tr) { this.crowEl._tr = tr; this.crowEl.style.transform = tr; }
    } else if (this.crowEl) { this.crowEl.remove(); this.crowEl = null; }
  },
};

// ============================================================== farm state sync
const App = { state: null, me: null, seenAgents: null, seenEvents: 0, lastTitles: {}, polling: null, user: null, plotOf: new Map(), approvals: null };

/** How a Claude's Remote Control session is named in the Claude app (runner.session_name). */
const sessionName = (st, name) => `[clodfarm] ${name === st.farm ? name : st.farm + " · " + name}`;

function colorFor(id) { return HAT_COLORS[hashStr(id) % HAT_COLORS.length]; }

const SUB_SPOTS = [[4, -2], [22, -2], [4, 23], [22, 23], [13, -2], [13, 23], [33, 4], [33, 16]];
const MINIS_PER_PLOT = SUB_SPOTS.length;

/** The farm from the state: one critter per Claude, and a mini Claude for each of its sub-agents (tinted with the
 * colour of the Claude whose account runs it). A Claude with sub-agents at work gets a plot and watches them there (a
 * plot draws at most 8 minis and a "+N" sign); resting Claudes nap in the yard by the barn. The world grows to fit. */
function reconcile(st) {
  Scene.reconciling = true;
  try { reconcileNow(st); } finally { Scene.reconciling = false; }
}
function reconcileNow(st) {
  const first = App.seenAgents === null;
  App.seenAgents = App.seenAgents || new Set();
  const subs = st.subagents || [], byId = new Map(st.agents.map(a => [a.id, a]));
  const home = (st.agents.find(a => a.primary) || st.agents[0] || {}).id;
  const ownerOf = (t) => byId.has(t.owner) ? t.owner : home;
  const subsOf = new Map();
  for (const t of subs) { const o = ownerOf(t); if (!subsOf.has(o)) subsOf.set(o, []); subsOf.get(o).push(t); }
  const active = st.agents.filter(a => a.talking || subsOf.has(a.id)); // at work: a turn or sub-agents
  const isActive = new Set(active.map(a => a.id));
  const modeOf = (a) => !a.loggedIn && !a.remote ? "egg" : !a.alive ? "offline" : !a.up ? "starting" : a.error ? "error"
    : isActive.has(a.id) ? "work" : st.paused ? "rest" : a.resting ? "sleep" : "wander";
  const modes = new Map(st.agents.map(a => [a.id, modeOf(a)]));
  const yardIds = st.agents.filter(a => { const m = modes.get(a.id); return m === "sleep" || (m === "offline" && Scene.farm); }).map(a => a.id).sort();
  if (Scene.farm) Scene.setNeed({ plots: active.length + Math.min(2, (st.recent || []).length), yard: yardIds.length });
  const L = Scene.world.L, relayout = Scene.relayout || first;
  Scene.relayout = false;
  // plots stay put: a Claude keeps its plot while it's busy, a newly busy one takes the first free plot
  const plotOf = App.plotOf;
  for (const [id, i] of plotOf) if (!isActive.has(id) || i >= L.plots.length) plotOf.delete(id);
  const taken = new Set(plotOf.values());
  let free = 0;
  for (const a of active) {
    if (plotOf.has(a.id)) continue;
    while (taken.has(free)) free++;
    if (free >= L.plots.length) break;
    plotOf.set(a.id, free); taken.add(free);
  }
  const yardIdx = new Map(yardIds.map((id, i) => [id, i]));
  const want = new Map();
  const more = [];
  for (const a of st.agents) {
    const pi = plotOf.get(a.id), plot = pi != null ? L.plots[pi] : null, mode = modes.get(a.id);
    const skin = agentSkin(a);
    want.set((mode === "egg" ? "egg:" : "claude:") + a.id, { agent: a, hat: skin.hat, color: skin.hatC, skin,
      kind: mode === "egg" ? "egg" : "claude", mode, spot: plot ? { x: plot.x - 7, y: plot.y + plot.h } : null,
      home: yardIdx.has(a.id) ? yardSpot(L, yardIdx.get(a.id)) : null });
    if (!plot) continue;
    const mine = (subsOf.get(a.id) || []).slice().sort((x, y) => (y.status === "running") - (x.status === "running"));
    more[pi] = Math.max(0, mine.length - MINIS_PER_PLOT);
    mine.slice(0, MINIS_PER_PLOT).forEach((t, n) => {
      const [dx, dy] = SUB_SPOTS[n];
      const on = t.on && byId.get(t.on);
      want.set("sub:" + t.id, { agent: a, sub: t, kind: "claude", mini: true, hat: "", color: on ? agentSkin(on).hatC : t.on ? colorFor(t.on) : "#9aa3b2",
        mode: t.status === "running" ? "work" : "subwait", spot: { x: plot.x + dx, y: plot.y + (dy > plot.h ? plot.h + 9 : dy) } });
    });
  }
  Scene.plotMore = more;
  const eggs = new Map();
  for (const c of Scene.critters.values()) if (c.kind === "egg" && !c.gone) eggs.set(c.agent.id, c);
  const nSubs = (id) => (subsOf.get(id) || []).length;
  for (const [key, d] of want) {
    let c = Scene.critters.get(key);
    const at = d.mode === "work" || d.mini ? d.spot : d.home;
    if (!c) {
      const egg = !d.mini && eggs.get(d.agent.id), owner = d.mini && Scene.critters.get("claude:" + d.agent.id);
      let p = first ? Scene.randomSpot() : { x: L.door.x + (Math.random() - 0.5) * 6, y: L.door.y + 4 };
      if (egg && d.kind === "claude") { p = { x: egg.x, y: egg.y }; Scene.sparkle(egg.x, egg.y - 6, 24); }
      if (owner) p = { x: owner.x, y: owner.y }; // a new sub-agent pops out of its Claude
      if (d.kind === "egg" && !first) p = Scene.randomSpot();
      if (first && at) p = { ...at }; // on the first look, everyone is already where they belong
      c = new Critter(key, p.x, p.y);
      if (!first && d.kind === "claude") { c.born = performance.now(); if (!egg) Scene.sparkle(p.x, p.y - 8, d.mini ? 8 : 16); }
      else c.born = performance.now() - 5000;
      Scene.critters.set(key, c);
      if (!d.mini && !first && !App.seenAgents.has(d.agent.id)) UI.say(d.kind === "egg" ? `An egg appeared! ${d.agent.name.toUpperCase()} waits for its login.` : `A wild ${d.agent.name.toUpperCase()} appeared!`);
      else if (!first && egg && d.kind === "claude") UI.say(`${d.agent.name.toUpperCase()} hatched! Welcome to the farm.`);
    } else if (relayout && at) { c.x = at.x; c.y = at.y; } // the world was rebuilt: everyone is at their new spot
    c.gone = 0;
    Object.assign(c, { kind: d.kind, agent: d.agent, sub: d.sub || null, hat: d.hat, color: d.color, skin: d.skin || null, mode: d.mode, mini: !!d.mini, spot: d.spot, home: d.home || null });
    const n = nSubs(d.agent.id);
    c.label = d.mini ? "" : d.agent.name;
    c.bubble = c.kind === "egg" ? { icon: d.agent.login?.state === "waiting_code" ? "dots" : "ask" }
      : d.mini ? (d.mode === "work" ? { icon: "terminal", title: d.sub.title } : { icon: "dots", title: d.sub.title })
      : c.mode === "work" ? { icon: "terminal", title: n ? `${n} SUB-AGENT${n === 1 ? "" : "S"}` : "TALKING: " + (d.agent.talking?.title || "a conversation").toUpperCase() }
      : c.mode === "sleep" ? { icon: "zzz" } : c.mode === "rest" ? { icon: "pause" } : c.mode === "error" ? { icon: "alert", alert: true }
      : c.mode === "starting" ? { icon: "dots" } : c.mode === "offline" ? { icon: "alert", alert: true } : null;
  }
  for (const [key, c] of Scene.critters) if (!want.has(key) && !c.gone) { c.gone = performance.now(); if (c.kind !== "egg" && Scene.sparkles.length < 200) Scene.sparkle(c.x, c.y - 8, 8, "#d8e6c4"); }
  for (const a of st.agents) App.seenAgents.add(a.id);
  // the field: a plot growing per Claude with sub-agents at work, then the latest harvests on the free plots
  const since = (a) => Math.min(a.talking?.since || nowS(), ...(subsOf.get(a.id) || []).map(t => t.started || t.created || nowS()));
  const crops = [], recent = [...(st.recent || [])];
  for (const a of active) { const i = plotOf.get(a.id); if (i != null) crops[i] = { id: "claude:" + a.id, status: "running", started: since(a) }; }
  for (let i = 0; i < L.plots.length && recent.length; i++) if (!crops[i]) crops[i] = recent.shift();
  Scene.plotTasks = crops;
  const f = Scene.follow; // the world was rebuilt while the camera was on its way to a Claude: go where it is now
  if (relayout && f && performance.now() < f.until) { const c = Scene.critters.get(f.key); if (c) Scene.focus(c.x, c.y - 8, Scene.goal?.z || Scene.cam.z); }
  Scene.planner = Scene.farm ? st.planner || null : null;
}

// =========================================================================== UI
const api = async (path, body) => {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Clodfarm": "1" }, body: JSON.stringify(body) };
  const r = await fetch(path, { credentials: "same-origin", ...opt }); // relative: works under a path prefix too
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && !["api/login", "api/me", "api/pair"].includes(path)) { UI.showTitle(); throw Object.assign(new Error("log in first"), { status: 401 }); }
  if (r.status === 403) throw Object.assign(new Error(data.error ? `🔒 ${data.error}` : "🔒 Only the farm's manager, or this Claude's person, can do that."), { status: 403 });
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
};
const fmtN = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fmtShort = (n) => { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(Math.round(n)); };
const pct = (u) => u == null ? "–" : `${Math.round(clamp(u, 0, 9.99) * 100)}%`;
const EVERY = [["5m", 300], ["15m", 900], ["30m", 1800], ["1h", 3600], ["3h", 10800], ["6h", 21600], ["24h", 86400]];
const everyLabel = (s) => (EVERY.find(e => e[1] === s) || [])[0] || (s ? (s >= 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 60)}m`) : "–");

const EVENT_TEXT = {
  "task.added": (e, T) => { const on = (e.msg.match(/\(for ([^)]+)\)$/) || [])[1]; return `${(e.by && !/^\d/.test(e.by) ? e.by : "A Claude").toUpperCase()} started a sub-agent${on ? " on " + on.toUpperCase() : ""}: “${T(e).replace(/ \(for [^)]+\)$/, "")}”.`; },
  "task.done": (e, T) => `★ Sub-agent done: “${T(e)}”!`,
  "task.failed": (e, T) => `A sub-agent failed: “${T(e)}”. Ask its Claude what went wrong.`,
  "task.waiting": (e, T) => `“${T(e)}” started its own sub-agents and waits for them.`,
  "verify.passed": (e, T) => `Tests passed for “${T(e)}”. Harvesting it into main!`,
  "verify.failed": (e, T) => `Tests failed for “${T(e)}”. Sent back to fix them.`,
  "msg.sent": (e) => { const m = e.msg.match(/^(\S+) -> (\S+): ([\s\S]*)$/); return m ? `${m[1].toUpperCase()} → ${m[2].toUpperCase()}: “${m[3].slice(0, 90)}”` : null; },
  "schedule.added": (e) => `Scheduled: “${e.msg.replace(/^\S+\s*/, "")}”.`,
  "farm.paused": (e) => `The farm is paused: ${e.msg || "by hand"}.`,
  "farm.resumed": () => "The farm is back at work!",
  "budget.rejected": () => "A Claude hit its usage limit. It rests until the window resets; the others carry on.",
  "rc.connected": (e) => `${((e.msg.match(/'([^']+)'/) || [])[1] || "A Claude").toUpperCase()} is live in the Claude app: talk to it from your phone.`,
  "agent.added": (e) => / a bot on /.test(e.msg) ? `${e.msg.split(" ")[0].toUpperCase()} joined the farm: a bot on ${e.msg.split(" a bot on ")[1].replace(/\)?;.*$|\)$/, "")}.`
    : `A new egg for ${e.msg.split(" ")[0].toUpperCase()}. It hatches once its person logs it in.`,
  "slack.received": (e) => `FROM SLACK · ${e.msg.slice(0, 120)}`,
  "slack.connected": () => "The farm is on Slack! DM it or @mention it in a channel, and a sub-agent answers in the thread.",
  "agent.removed": (e) => `${e.msg.split(" ")[0].toUpperCase()} left the farm.`,
};

/** Who this browser is, from /api/state's `me` (fresh every poll) and /api/me (hatching, every 30s). */
const role = () => { const m = App.state?.me || App.me || {}; return { manager: !!m.manager, owner: m.owner || m.claude || null, viewer: !!m.viewer }; };
const canManage = (a) => role().manager || !!a?.mine;

const UI = {
  queue: [], typing: null, hatchFor: null, hatchPoll: null,

  // ------------------------------------------------------------ title / login
  async boot() {
    for (const img of $$("img[data-icon]")) img.src = icon(img.dataset.icon);
    Scene.init();
    this.bind();
    const q = new URLSearchParams(location.search);
    this.approveId = q.get("approve") || null;
    this.paired = q.get("paired");
    if (q.has("paired") || q.has("approve")) { q.delete("paired"); q.delete("approve"); history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "")); }
    const me = await this.loadMe();
    if (this.paired === "0") this.notice("That link was used or expired: ask your Claude for a new one.");
    if (me?.can_view) { if (!this.goNext()) this.showFarm(); }
    else this.showTitle();
  },
  async loadMe() {
    try {
      const r = await fetch("api/me", { credentials: "same-origin" }), me = await r.json();
      App.me = me; App.user = me.user;
      if (App.state) this.renderHud(App.state);
      return me;
    } catch { return null; }
  },
  /** A line for the person: the farm's textbox, or under the title screen's form. */
  notice(text) {
    if (!$("#hud").hidden) return this.say(text);
    this.titleNote = text;
    const p = $("#title-note"); if (p) p.textContent = text;
  },
  /** Back to the page that sent you to log in (?next=dashboards/<name>, ?next=browser, ?next=tasks); only farm-local paths. */
  goNext() {
    const next = new URLSearchParams(location.search).get("next") || "";
    if (!/^(dashboards(\/[a-z0-9-]{1,48})?|browser|tasks)$/.test(next)) return false;
    location.replace(next);
    return true;
  },
  showTitle() {
    clearInterval(App.polling); App.polling = null; clearInterval(App.mePoll);
    for (const d of $$("dialog[open]")) d.close();
    $("#hud").hidden = true; $("#title").hidden = false;
    const priv = App.me ? App.me.private && !App.me.can_view : true;
    this.accountForms($("#title-forms"), { tabs: priv ? ["viewer", "mine"] : ["mine"], note: this.titleNote,
      onDone: async () => { const me = await this.loadMe(); if (me?.can_view) { if (!this.goNext()) this.showFarm(); } else this.showTitle(); } });
    Scene.farm = false; Scene.layout = { clearOf: ".title-card" }; Scene.cam.auto = true; Scene.resize(); // the demo Claudes keep off the title and the form
    Scene.demo = true; fill(Scene.labels, null); Scene.crowEl = null; Scene.critters.clear(); Scene.plotTasks = []; Scene.plotMore = []; Scene.boardCount = 3;
    App.seenAgents = null;
    const hats = ["straw", "beanie", "cap", "sprout", "bow", "headphones"];
    hats.forEach((hat, i) => { const p = Scene.randomSpot(), c = new Critter("demo" + i, p.x, p.y); c.hat = hat; c.color = HAT_COLORS[i + 1]; c.born -= 5000; Scene.critters.set(c.key, c); });
  },
  /** Sign-in forms, as tabs: a private farm's viewer password (FARM), and the code your Claude gives you in the Claude
   * app (MY CLAUDE). The farm's manager is the person of a manager Claude: they sign in to it like anyone. */
  accountForms(box, { tabs, tab, note, onDone }) {
    const NAMES = { viewer: "FARM", mine: "MY CLAUDE" };
    const draw = (cur) => {
      const err = h("p", { class: "form-error", role: "alert", id: box.id === "title-forms" ? "title-note" : null, text: note || "" });
      note = "";
      const bar = tabs.length > 1 ? h("div", { class: "tabs", role: "tablist" }, tabs.map(k => h("button", { type: "button", role: "tab",
        class: "tab" + (k === cur ? " on" : ""), "aria-selected": String(k === cur), onclick: () => draw(k) }, NAMES[k]))) : null;
      let form;
      if (cur === "mine") {
        const code = h("input", { name: "code", class: "code-input", maxlength: 6, minlength: 6, autocomplete: "one-time-code", autocapitalize: "characters",
          spellcheck: "false", required: true, placeholder: "ABC123", "aria-label": "6-character code" });
        code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
        form = h("form", { class: "acct-form" },
          h("label", {}, "CODE FROM YOUR CLAUDE", code),
          h("p", { class: "muted small hint-line" }, "Ask your Claude in the Claude app: ", h("b", { text: "farm login" }), " (or ", h("b", { text: "/farm-login" }), "). It gives you a code, or a link that signs you in."),
          err, h("button", { class: "btn primary", type: "submit" }, "▶ SIGN IN TO MY CLAUDE"));
        form.addEventListener("submit", async (e) => {
          e.preventDefault(); const btn = form.querySelector("button[type=submit]"); btn.disabled = true; err.textContent = "";
          try { const r = await api("api/pair", { code: code.value.trim() }); this.pairedTo = r.claude; await onDone("owner", r); }
          catch (x) { err.textContent = x.message.toUpperCase(); btn.disabled = false; }
        });
      } else {
        const pw = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true });
        form = h("form", { class: "acct-form", autocomplete: "on" },
          h("input", { name: "user", autocomplete: "username", value: "clodfarm", hidden: true }),
          h("label", {}, "FARM PASSWORD", pw),
          h("p", { class: "muted small", text: "This farm is private. Its manager gives you the password; or sign in to your own Claude (MY CLAUDE)." }),
          err, h("button", { class: "btn primary", type: "submit" }, "▶ ENTER THE FARM"));
        form.addEventListener("submit", async (e) => {
          e.preventDefault(); const btn = form.querySelector("button[type=submit]"); btn.disabled = true; err.textContent = "";
          try { const r = await api("api/login", { password: pw.value }); App.user = r.user; await onDone(r.role, r); }
          catch (x) { err.textContent = x.message.toUpperCase(); btn.disabled = false; }
        });
      }
      fill(box, bar, form);
      setTimeout(() => form.querySelector("input:not([hidden])")?.focus({ preventScroll: true }), 50);
    };
    draw(tab || tabs[0]);
  },
  showFarm() {
    $("#title").hidden = true; $("#hud").hidden = false;
    App.state = null;
    Scene.farm = true; Scene.layout = {}; Scene.cam.auto = true; Scene.need = null; Scene.resize();
    Scene.demo = false; Scene.critters.clear(); fill(Scene.labels, null); Scene.crowEl = null;
    App.seenAgents = null; App.seenEvents = nowS() - 1; App.plotOf = new Map(); App.approvals = null; App.apprCount = -1;
    this.refresh(true);
    clearInterval(App.polling); clearInterval(App.mePoll);
    App.polling = setInterval(() => this.refresh(), 2500);
    App.mePoll = setInterval(() => this.loadMe(), 30000);
  },
  async refresh(first = false) {
    let st;
    try { st = await api("api/state"); } catch { return; }
    App.state = st;
    for (const t of [...st.subagents, ...st.recent]) App.lastTitles[t.id] = t.title;
    reconcile(st);
    this.renderHud(st);
    this.syncApprovals(st);
    if (first) this.welcome(st);
    else this.pushEvents(st);
    if ($("#dlg-summary").open && this.summaryKey) { const c = Scene.critters.get(this.summaryKey); if (c) this.renderSummary(c); }
    if ($("#dlg-roster").open) this.renderRoster();
    if ($("#dlg-planner").open) this.renderPlanner();
    if (first && this.approveId) this.openApprovals(this.approveId);
  },
  welcome(st) {
    const R = role(), mine = st.agents.find(a => a.mine);
    if (this.paired === "1" || this.pairedTo) { this.say(`You're signed in to ${(mine?.name || this.pairedTo || "your Claude").toUpperCase()}. It's the one with the gold arrow.`); this.paired = null; this.pairedTo = null; }
    const live = st.agents.filter(a => a.loggedIn);
    if (!live.length) { this.say(`Welcome to ${st.farm.toUpperCase()}! No Claude lives here yet. Tap + NEW CLAUDE to hatch the first one.`); return; }
    const n = live.length, busy = st.subagents.filter(t => t.status === "running").length;
    this.say(`Welcome to ${st.farm.toUpperCase()}! ${n} Claude${n === 1 ? "" : "s"} on the farm, ${busy} sub-agent${busy === 1 ? "" : "s"} at work.`);
    if (R.manager || R.owner) this.say("Talk to your Claude from the Claude app on your phone (Remote Control). Tap a Claude for its link.");
    else this.say(n > 12 ? "Drag to look round, pinch or scroll to zoom. Press R (or the list button) to find any Claude." : "Tap a Claude to see what it's doing.");
  },
  pushEvents(st) {
    const T = (e) => App.lastTitles[e.task] || (e.msg || "").replace(/^\S+\s*/, "").slice(0, 60) || e.task;
    for (const e of st.events) {
      if (e.at <= App.seenEvents) continue;
      App.seenEvents = Math.max(App.seenEvents, e.at);
      const f = EVENT_TEXT[e.type];
      const text = f && f(e, T);
      if (text) this.say(text);
      if (e.type === "task.done") { const p = Scene.plotTasks.findIndex(t => t && t.id === e.task), pl = Scene.world.L.plots[p]; if (pl) Scene.sparkle(pl.x + pl.w / 2, pl.y, 20); }
    }
  },
  renderHud(st) {
    const R = role(), me = st.me || {}, hatch = App.me?.hatch;
    const claudes = st.agents.filter(a => a.loggedIn || a.remote).length, eggs = st.agents.length - claudes;
    const busy = st.subagents.filter(t => t.status === "running").length, waiting = st.subagents.length - busy;
    this.renderTokens(st);
    // yours: what your Claude burned, and its usage windows
    const mb = $("#mine-block"), mine = me.claude && st.agents.find(a => a.id === me.claude);
    mb.hidden = !mine;
    if (mine) {
      const b = me.budget || mine.budget || {}, sig = JSON.stringify([mine.name, me.tokens?.total, me.tokens_today?.total, b.five_hour, b.seven_day, me.pending]);
      if (mb.dataset.sig !== sig) {
        mb.dataset.sig = sig;
        fill(mb, h("span", { class: "mine-h" }, h("img", { src: this.spriteURL(agentSkin(mine)), alt: "" }), h("span", {}, "YOUR CLAUDE ", h("b", { text: mine.name.toUpperCase() }))),
          h("span", { class: "mine-t" }, h("b", { text: fmtN(me.tokens_today?.total) }), " tokens today · ", h("b", { text: fmtShort(me.tokens?.total) }), " total"),
          this.hp("5H", b.five_hour, b.five_hour_resets, true), this.hp("7D", b.seven_day, b.seven_day_resets, true));
        mb.setAttribute("aria-label", `Your Claude ${mine.name}: ${fmtN(me.tokens_today?.total)} tokens today. Show it on the farm.`);
      }
    }
    // missions waiting for you
    const n = R.manager ? me.pending_all || 0 : me.pending || 0, chip = $("#approve-chip");
    chip.hidden = !n;
    if (n) { const t = `⚑ ${n} TO APPROVE`; if (chip.textContent !== t) chip.textContent = t; }
    const chips = [
      h("span", { class: "chip" }, h("i", { class: "dot" + (claudes ? "" : " off") }), `${st.farm.toUpperCase()}`, st.private ? " 🔒" : "",
        h("span", { class: "role", text: R.manager ? " · MANAGER" : R.owner ? " · OWNER" : st.private ? " · VIEWER" : "" })),
      h("span", { class: "chip" }, "CLAUDES ", h("b", { text: String(claudes) }), eggs ? ` · EGGS ${eggs}` : ""),
      h("span", { class: "chip" }, "SUB-AGENTS ", h("b", { text: String(busy) }), waiting ? [" · WAITING ", h("b", { text: String(waiting) })] : null),
    ];
    if (st.paused) chips.push(h("span", { class: "chip warn" }, "⏸ PAUSED: " + (st.pause_reason || "").slice(0, 40).toUpperCase()));
    const sig = JSON.stringify([st.farm, st.private, R, claudes, eggs, busy, waiting, st.paused, st.pause_reason]);
    if ($("#chips").dataset.sig !== sig) { $("#chips").dataset.sig = sig; fill($("#chips"), ...chips); }
    // the toolbar, by role: watchers see the farm and the tasks; people see their Claude; the manager sees everything
    const person = R.manager || !!R.owner;
    $("#talk-tool").hidden = !person;
    $("#slack-tool").hidden = !R.manager;
    $("#dash-tool").hidden = !person;
    $("#browser-tool").hidden = !R.owner; // the browser is a Claude's tool: signed in to yours, or no browser
    $("#manager-tool").hidden = !R.manager;
    const ht = $("#hatch-tool"), can = R.manager || (hatch ? hatch.can : !R.owner);
    ht.hidden = !!R.owner && !R.manager;
    ht.classList.toggle("off", !can);
    ht.setAttribute("aria-disabled", String(!can));
    ht.dataset.tip = can ? "Add a Claude or a bot" : `Can't hatch: ${hatch?.why || "not now"}`;
    ht.setAttribute("aria-label", `${ht.dataset.tip} (C)`);
    if ($("#dlg-claude").open) this.renderClaude(st);
    const sl = $("#slack-tool"), ss = st.slack?.state;
    if (ss && ss !== "off") sl.dataset.state = ss === "live" ? "live" : ss === "error" ? "error" : "wait"; else delete sl.dataset.state;
    sl.dataset.tip = ss === "live" ? `On Slack: ${st.slack.team || "connected"}` : ss === "error" ? "Slack: needs a look" : "Connect Slack";
    sl.setAttribute("aria-label", `${sl.dataset.tip} (S)`);
  },

  // ------------------------------------------------------------------ tokens
  /** The farm's burn counter: it glides to each new total over the time between polls, so it never stops ticking. */
  renderTokens(st) {
    const T = st.tokens || {}, tot = T.total || {}, day = T.today || {};
    const target = Number(tot.total) || 0, k = this.tok || (this.tok = { shown: 0, from: 0, target: 0, t0: 0, dur: 1200 });
    if (target !== k.target) {
      Object.assign(k, { from: k.shown, target, t0: performance.now(), dur: k.target ? 2400 : 1400 });
      if (!this.tokRAF) { const step = () => { this.tokRAF = null; this.tickTokens(); if (this.tok.shown !== this.tok.target) this.tokRAF = requestAnimationFrame(step); }; this.tokRAF = requestAnimationFrame(step); }
    }
    $("#tok-today").textContent = `today: ${fmtN(day.total)}`;
    const sig = JSON.stringify([tot, day]), sign = $("#tokens-sign");
    if (sign.dataset.sig === sig) return;
    sign.dataset.sig = sig;
    const row = (label, key) => [h("span", { text: label }), h("span", { text: fmtN(tot[key]) }), h("span", { text: fmtN(day[key]) })];
    fill(sign, h("span", { class: "tok-grid" }, h("span", {}), h("b", { text: "TOTAL" }), h("b", { text: "TODAY" }),
      row("INPUT", "input"), row("OUTPUT", "output"), row("CACHE WRITE", "cache_write"), row("CACHE READ", "cache_read"),
      h("b", { text: "ALL" }), h("b", { text: fmtN(tot.total) }), h("b", { text: fmtN(day.total) })),
      h("span", { class: "tok-note", text: "Every Claude on the farm, every sub-agent and conversation." }));
  },
  tickTokens() {
    const k = this.tok, p = REDUCED ? 1 : clamp((performance.now() - k.t0) / k.dur, 0, 1), e = 1 - (1 - p) * (1 - p);
    k.shown = p >= 1 ? k.target : Math.round(k.from + (k.target - k.from) * e);
    const t = fmtN(k.shown), el = $("#tok-total");
    if (el.textContent !== t) el.textContent = t;
  },
  focusMine() {
    const id = App.state?.me?.claude; if (!id) return;
    this.focusAgent(id, false);
  },
  /** Point the camera at a Claude (zoomed in enough to read names) and select it. */
  focusAgent(id, open = true) {
    const c = Scene.critters.get("claude:" + id) || Scene.critters.get("egg:" + id);
    if (!c) return;
    Scene.focusCritter(c); Scene.selected = c;
    if (open) this.openCritter(c);
  },

  // ---------------------------------------------------------------- textbox
  say(text) { if (!$("#textbox")) return; this.queue.push(text); if (this.queue.length > 6) this.queue.splice(0, this.queue.length - 6); if (!this.typing) this.next(); },
  next() {
    const box = $("#textbox"), p = $("#textbox-text");
    clearTimeout(this.hideT);
    const text = this.queue.shift();
    if (text == null) { this.typing = null; this.hideT = setTimeout(() => box.classList.add("idle"), 7000); return; }
    box.classList.remove("idle");
    let i = 0;
    this.typing = { text, done: false };
    clearInterval(this.typeT);
    this.typeT = setInterval(() => {
      i = Math.min(text.length, i + (REDUCED ? text.length : 2));
      p.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(this.typeT); this.typing.done = true; this.hideT = setTimeout(() => this.next(), this.queue.length ? 1800 : 5000); }
    }, 28);
  },
  skip() {
    if (!this.typing) return $("#textbox").classList.add("idle");
    if (!this.typing.done) { clearInterval(this.typeT); $("#textbox-text").textContent = this.typing.text; this.typing.done = true; clearTimeout(this.hideT); this.hideT = setTimeout(() => this.next(), 4000); }
    else { clearTimeout(this.hideT); this.next(); }
  },

  // ------------------------------------------------------------------- binds
  bind() {
    document.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) { this.act(act, e); return; }
      if (e.target.closest("[data-close]")) e.target.closest("dialog").close();
      if (!e.target.closest("#tokens")) $("#tokens").classList.remove("open");
    });
    $("#textbox").addEventListener("click", () => this.skip());
    $("#tokens").addEventListener("click", () => $("#tokens").classList.toggle("open"));
    $("#mine-block").addEventListener("click", () => this.focusMine());
    $("#roster-q").addEventListener("input", () => this.renderRoster());
    $("#roster-sort").addEventListener("change", () => this.renderRoster());
    for (const d of $$("dialog")) {
      d.addEventListener("click", (e) => { // a click on the backdrop (outside the box) closes it
        const r = d.getBoundingClientRect();
        if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
      });
      d.addEventListener("close", () => {
        if (d.id === "dlg-slack") clearTimeout(this.slackPoll);
        if (d.id === "dlg-hatch") this.stopHatchPoll();
        if (d.id === "dlg-summary") { this.summaryKey = null; Scene.selected = null; }
        if (d.id === "dlg-settings") clearInterval(this.previewT);
        if (d.id === "dlg-hatch") clearInterval(this.previewT);
      });
    }
    addEventListener("keydown", (e) => {
      if ($("#hud").hidden || $$("dialog[open]").length || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = { c: "hatch", h: "hatch", n: "hatch", s: "slack", t: "talk", d: "dashboards", b: "browser", j: "tasks", r: "roster", g: "manager",
        a: "approvals", m: "menu", p: "planner", "0": "fit", f: "fit", "+": "zoomin", "=": "zoomin", "-": "zoomout" }[e.key.toLowerCase()];
      if (k) { e.preventDefault(); this.act(k); }
    });
  },
  act(a) {
    const R = role(), person = R.manager || !!R.owner;
    if (a === "hatch") return this.openHatch(null, true);
    if (a === "roster") return this.openRoster();
    if (a === "approvals") return this.openApprovals();
    if (a === "menu") return this.openMenu();
    if (a === "planner") return this.openPlanner();
    if (a === "fit") { Scene.goal = null; return Scene.fit(); }
    if (a === "zoomin") return Scene.zoomBy(1.4);
    if (a === "zoomout") return Scene.zoomBy(1 / 1.4);
    if (a === "manager") return R.manager ? this.openManager() : null;
    if (a === "slack") return R.manager ? this.openSlack() : null;
    if (a === "talk") return person ? this.openClaude() : null;
    if (a === "dashboards" && person) location.href = "dashboards";
    if (a === "browser" && R.owner) location.href = "browser";
    if (a === "tasks") location.href = "tasks";
  },

  // ------------------------------------------------------ talk to your Claude
  openClaude() {
    for (const d of $$("dialog[open]")) d.close();
    $("#claude-body").dataset.key = "";
    this.renderClaude(App.state);
    const d = $("#dlg-claude");
    d.showModal();
    requestAnimationFrame(() => { d.scrollTop = 0; d.querySelector(".x").focus({ preventScroll: true }); }); // open at the top
  },
  renderClaude(st) {
    if (!st) return;
    const R = role();
    const me = st.agents.find(a => a.mine) || (R.manager ? st.agents.find(a => a.primary) || st.agents.find(a => a.loggedIn) : null), name = me?.name || st.farm;
    const none = !me || !me.loggedIn;
    const link = me?.remote_control, body = $("#claude-body"), key = JSON.stringify([name, link, none, R.manager]);
    if (body.dataset.key === key) return;
    body.dataset.key = key;
    const mcp = `claude mcp add --transport http --scope user ${st.farm} ${location.origin}${location.pathname.replace(/\/$/, "")}/mcp`;
    const copy = h("button", { type: "button", class: "btn", text: "COPY", onclick: async (e) => {
      try { await navigator.clipboard.writeText(mcp); e.target.textContent = "COPIED ✓"; } catch { e.target.textContent = "SELECT IT"; }
      setTimeout(() => (e.target.textContent = "COPY"), 1500);
    } });
    fill(body,
      none ? h("p", { class: "banner-note" }, h("strong", { text: "FIRST, LOG IN A CLAUDE. " }), me ? `${name.toUpperCase()} waits for its login: tap its egg.` : "No Claude of yours lives on this farm yet: tap ",
        me ? null : h("strong", { text: "+ NEW CLAUDE" }), me ? null : " and log in with your Claude account. Then:") : null,
      h("p", {}, me?.mine ? "Your Claude, " : "Your farm's own Claude, ", h("strong", { text: name.toUpperCase() }), ", is always on. Talk to it from the Claude app on your phone or computer."),
      h("ol", { class: "hatch-steps" },
        h("li", {}, "Open the ", h("strong", { text: "Claude app" }), " (or claude.ai)."),
        h("li", {}, "Go to ", h("strong", { text: "Code" }), "."),
        h("li", {}, "Pick the session ", h("strong", { class: "session-name", text: sessionName(st, name) }), link ? " (or use the button below)." : ".")),
      h("h3", { class: "kicker", text: "ASK IT ANYTHING" }),
      h("ul", { class: "examples" },
        h("li", { text: "“Fix the flaky login test and tell me when it's on main.”" }),
        h("li", { text: "“Split the migration into 3 sub-agents.”" }),
        h("li", { text: "“Every weekday at 9, check the errors and keep a dashboard of them.”" })),
      h("p", { class: "muted small", text: "It starts sub-agents (you see them here as mini Claudes), asks the other Claudes for help, schedules work and builds dashboards, and it watches its budget." }),
      R.manager ? [h("h3", { class: "kicker", text: "OR FROM CLAUDE CODE ON YOUR COMPUTER" }),
        h("div", { class: "copy-row" }, h("code", { class: "pre", text: mcp }), copy),
        h("p", { class: "muted small", text: "Then run /mcp in Claude Code: it opens this farm, where you're signed in to your Claude, to connect." })] : null);
    fill($("#claude-actions"), none && !me
      ? h("button", { class: "btn primary", type: "button", onclick: () => { $("#dlg-claude").close(); this.openHatch(null, true); } }, "+ NEW CLAUDE")
      : h("a", { class: "btn primary", href: link || "https://claude.ai/code", target: "_blank", rel: "noopener noreferrer", text: "OPEN IN CLAUDE ↗" }));
  },

  // ----------------------------------------------------------------- dialogs
  hp(label, util, resets, compact) {
    if (util == null) { const i = h("i"); i.style.width = "0"; return h("span", { class: "hp" + (compact ? " compact" : "") }, h("span", { text: label }), h("span", { class: "bar" }, i), h("span", { class: "lbl", text: compact ? "–" : "NOT MEASURED YET" })); }
    // like Claude's own usage page: how much of the limit is used, filling up to 100%, and when it resets
    const used = clamp(util, 0, 1), cls = used < 0.5 ? "" : used < 0.8 ? "mid" : "low";
    const bar = h("i", { class: cls }); bar.style.width = `${Math.round(used * 100)}%`;
    return h("span", { class: "hp" + (compact ? " compact" : ""), title: `${Math.round(util * 100)}% used` + (resets ? `, resets in ${until(resets)}` : "") }, h("span", { text: label }), h("span", { class: "bar" }, bar),
      h("span", { class: "lbl", text: compact ? `${Math.round(used * 100)}%` : `${Math.round(used * 100)}% USED${resets ? " · RESETS IN " + until(resets) : ""}` }));
  },
  /** A Claude's portrait as an image URL (cached per skin): for lists, the HUD and buttons. */
  spriteURL(skin, pose = { legs: 0 }) {
    this.urls = this.urls || new Map();
    const k = skin.key + poseCode(pose);
    if (!this.urls.has(k)) { const c = canvas(18, 18), g = c.getContext("2d"); g.drawImage(skinFrame(skin, pose), 1, 0); this.urls.set(k, c.toDataURL()); }
    return this.urls.get(k);
  },
  spriteCanvas(c, size) {
    const cv = h("canvas", { width: 20, height: 20 }), g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    if (c.kind === "egg") g.drawImage(EGG, 4, 6); else g.drawImage(skinFrame(c.skin || skinOf(c.hat, null, "", c.color), { legs: 0 }), 2, 1);
    if (size) cv.style.width = cv.style.height = size + "px";
    return cv;
  },
  agentState(a) {
    if (!a.loggedIn && !a.remote) return a.login?.state === "waiting_code" ? "WAITING FOR ITS LOGIN CODE" : "AN EGG: NEEDS A CLAUDE LOGIN";
    if (!a.alive) return "NOT RUNNING";
    if (!a.up) return "WAKING UP… (MEASURING ITS USAGE)";
    if (a.error) return a.error.toUpperCase();
    const n = App.state.subagents.filter(t => t.owner === a.id).length;
    if (n) return `${n} SUB-AGENT${n === 1 ? "" : "S"} AT WORK`;
    if (a.bot) return a.resting ? "RESTING: " + (a.budget?.reason || "paced").toUpperCase() : "READY: SEND IT WORK";
    if (a.talking) return a.talking.n > 1 ? `WORKING IN ${a.talking.n} CONVERSATIONS` : "WORKING IN A CONVERSATION";
    if (a.resting) return "RESTING: " + (a.budget?.reason || "paced by its budget").toUpperCase();
    return "READY: TALK TO IT";
  },
  openCritter(c) {
    if (c.kind === "egg" && canManage(c.agent)) return this.openHatch(c.agent.id);
    for (const d of $$("dialog[open]")) d.close();
    this.summaryKey = c.key; Scene.selected = c;
    this.renderSummary(c);
    $("#dlg-summary").showModal();
  },
  renderSummary(c) {
    const st = App.state, R = role(), badge = (t) => h("span", { class: `badge ${t.status}`, text: { running: "WORKING", queued: "WAITING", waiting: "WAITING", done: "DONE", failed: "FAILED", cancelled: "CANCELLED", pending: "TO APPROVE", denied: "DENIED" }[t.status] || t.status.toUpperCase() });
    const g = $("#sum-sprite").getContext("2d"); g.imageSmoothingEnabled = false; g.clearRect(0, 0, 32, 32);
    if (c.mini) g.drawImage(miniSprite(c.color, {}), 11, 12);
    else if (c.kind === "egg") g.drawImage(EGG, 10, 10);
    else g.drawImage(skinFrame(c.skin || skinOf(c.hat, null, "", c.color), { legs: 0 }), 8, 8);
    let parts;
    if (c.mini) { // a sub-agent
      const t = st.subagents.find(x => x.id === c.sub.id) || c.sub, all = new Map(st.subagents.map(x => [x.id, x]));
      const kids = (t.children || []).map(id => all.get(id)).filter(Boolean), parent = t.parent && all.get(t.parent);
      const see = canManage(c.agent);
      $("#sum-name").textContent = `SUB-AGENT · ${c.agent.name}`.toUpperCase();
      $("#sum-sub").textContent = `Started by ${c.agent.name}` + (t.on && t.on !== c.agent.id ? `, running on ${t.on}'s account` : "");
      parts = [h("dl", { class: "stat-row" },
        h("dt", { text: "STATUS" }), h("dd", { text: t.status === "running" ? `WORKING ON ${String(t.on || "").toUpperCase()}'S BUDGET`
          : t.status === "waiting" ? "WAITING FOR ITS OWN SUB-AGENTS" : t.to ? `WAITING FOR ${t.to.toUpperCase()}` : "WAITING FOR A CLAUDE WITH BUDGET" }),
        t.started ? [h("dt", { text: "STARTED" }), h("dd", { text: ago(t.started) })] : null,
        parent ? [h("dt", { text: "HELPING" }), h("dd", { text: parent.title })] : null),
        h("h3", { text: "ITS JOB" }), h("p", { class: "job-text", text: t.title }),
        kids.length ? [h("h3", { text: `ITS SUB-AGENTS (${kids.length})` }), h("ul", { class: "subs" }, kids.map(k => h("li", {}, badge(k), h("span", { text: k.title }))))] : null,
        see ? [h("h3", { text: "ITS SESSION" }), this.sessionList(c.agent.id, t.id)] : null,
        see ? h("p", { class: "muted small", text: `Its result: ask ${c.agent.name}, or run clodfarm result ${t.id}` }) : null,
        h("p", { class: "small" }, h("a", { href: "tasks", text: "See every sub-agent on the TASKS page →" }))];
      fill($("#sum-body"), parts); fill($("#sum-actions"));
      return;
    }
    const a = st.agents.find(x => x.id === c.agent.id) || c.agent, b = a.budget || {}, see = canManage(a);
    const mine = st.subagents.filter(t => t.owner === a.id), elsewhere = st.subagents.filter(t => t.on === a.id && t.owner !== a.id);
    const tokens = st.tokens?.by_claude?.[a.id], waitingN = Scene.pendingFor[a.id] || 0;
    $("#sum-name").textContent = a.name.toUpperCase();
    $("#sum-sub").textContent = a.bot ? `BOT · ${a.bot.model}` + (a.bot.via ? ` via ${a.bot.via}` : "")
      : [a.plan && `Claude ${a.plan}`, a.email].filter(Boolean).join(" · ");
    const tags = [a.mine ? h("span", { class: "badge mine", text: "★ YOURS" }) : null,
      a.approve_missions ? h("span", { class: "badge waiting", text: "✓ APPROVES MISSIONS", title: "Its person OKs every mission sent to it" }) : null,
      a.tools_off?.length ? h("span", { class: "badge cancelled", text: `TOOLS OFF: ${a.tools_off.join(", ").toUpperCase()}` }) : null,
      a.planner_host_ok ? h("span", { class: "badge done", text: "PLANNER CAN RUN HERE" }) : null].filter(Boolean);
    parts = [tags.length ? h("p", { class: "tags" }, tags) : null,
      h("dl", { class: "stat-row" },
        h("dt", { text: "STATUS" }), h("dd", { text: this.agentState(a) }),
        tokens != null ? [h("dt", { text: "TOKENS" }), h("dd", { text: fmtN(tokens) })] : null,
        a.stats ? [h("dt", { text: "RAN (7D)" }), h("dd", { text: `${a.stats.ran} sub-agents · ${a.stats.done} done · ${a.stats.failed} failed` })] : null)];
    if (c.kind === "egg") parts.push(h("p", { class: "muted small", text: see ? "Tap it on the farm to log it in." : "It hatches once its person logs it in to a Claude account." }));
    if (waitingN && (R.manager || a.mine)) parts.push(h("button", { class: "btn danger pulse wide-btn", type: "button", onclick: () => this.openApprovals(null, a.id) }, `⚑ ${waitingN} MISSION${waitingN === 1 ? "" : "S"} TO APPROVE`));
    if (a.bot) parts.push(h("h3", { text: "SEND IT WORK" }),
      h("p", { class: "muted small", text: `It's Claude Code on ${a.bot.model}, not Claude: it uses no Claude account's usage, but it's weaker. ` +
        (a.bot.takes === "any" ? "It takes any sub-agent, " : "It takes only the sub-agents sent to it, ") +
        `so ask a Claude to hand it a well-specified job with --on ${a.id}, or run: clodfarm spawn "<title>" --prompt "…" --on ${a.id}` }));
    else if (a.loggedIn && see) parts.push(h("h3", { text: "TALK TO IT" }), a.remote_control
      ? [h("a", { class: "btn primary login-link", href: a.remote_control, target: "_blank", rel: "noopener noreferrer" }, "OPEN IN THE CLAUDE APP ↗"),
        h("p", { class: "muted small", text: `Or open the Claude app, go to Code and pick “${sessionName(st, a.name)}”. It starts sub-agents, asks the other Claudes for help and schedules work, and it watches its budget.` })]
      : h("p", { class: "muted small", text: a.remote ? "It lives on another box: talk to it from its own Claude app." : `Its Remote Control session is starting. It shows up in the Claude app under Code as “${sessionName(st, a.name)}”.` }));
    if (a.bot) parts.push(h("h3", { text: "PACE" }), h("p", { class: "muted small", text: (b.can_start ? `It can start ${b.can_start} more sub-agent${b.can_start === 1 ? "" : "s"} now. ` : b.reason ? `No new sub-agents now: ${b.reason}. ` : "")
      + `It pauses when ${a.bot.via || "its provider"} rate-limits it.` }));
    else if (c.kind !== "egg") parts.push(h("h3", { text: "USAGE" }), this.hp("5H", b.five_hour, b.five_hour_resets), this.hp("7D", b.seven_day, b.seven_day_resets),
      h("p", { class: "muted small", text: b.measured ? `Measured ${ago(b.measured)}. ` + (b.can_start ? `It can start ${b.can_start} more sub-agent${b.can_start === 1 ? "" : "s"} now.` : `No new sub-agents on its account now: ${b.reason}.`)
        : "Measuring its usage…" }));
    if (mine.length) parts.push(h("h3", { text: `ITS SUB-AGENTS (${mine.length})` }), h("ul", { class: "subs" }, mine.slice(0, 30).map(t => h("li", {}, badge(t),
      h("span", { text: t.title + (t.on && t.on !== a.id ? ` · on ${t.on}` : "") })))), mine.length > 30 ? h("p", { class: "muted small", text: `…and ${mine.length - 30} more on the TASKS page.` }) : null);
    if ((a.loggedIn || a.remote) && see) parts.push(h("h3", { text: "TOOLS" }), this.toolList(a.id));
    if (see) parts.push(h("h3", { text: "SESSIONS" }), this.sessionList(a.id));
    if (elsewhere.length) parts.push(h("h3", { text: `HELPING OTHERS (${elsewhere.length})` }), h("ul", { class: "subs" }, elsewhere.slice(0, 20).map(t => h("li", {}, badge(t),
      h("span", { text: `${t.title} · for ${t.owner}` })))));
    fill($("#sum-body"), parts);
    const acts = [];
    if (see && !a.remote) acts.push(h("button", { class: "btn", type: "button", onclick: () => this.openSettings(a.id) }, "⚙ SETTINGS"));
    fill($("#sum-actions"), acts);
  },

  // ------------------------------------------------------------------- tools
  /** What a Claude can use: its model, MCP servers (and whether they're connected), tools, skills and plugins, as
   * Claude Code reported them when it last ran a sub-agent on the farm. */
  toolList(claude) {
    const box = h("div", { class: "tools" });
    this.toolsOpen = this.toolsOpen || new Set();
    const group = (id, title, items, render) => {
      if (!items.length) return null;
      const d = h("details", { class: "tool-group", open: this.toolsOpen.has(id) },
        h("summary", {}, title, h("span", { class: "muted", text: ` (${items.length})` })), h("div", { class: "tool-chips" }, items.map(render)));
      d.addEventListener("toggle", () => d.open ? this.toolsOpen.add(id) : this.toolsOpen.delete(id));
      return d;
    };
    const chip = (text, cls = "") => h("span", { class: `tool-chip ${cls}`, text });
    const draw = (t) => {
      if (!t || !t.tools) return fill(box, h("p", { class: "muted small", text: "Shown after its first sub-agent or usage check runs." }));
      const slug = n => "mcp__" + n.replace(/[^A-Za-z0-9_-]/g, "_") + "__";
      const mcpTools = t.tools.filter(x => x.startsWith("mcp__")), builtIn = t.tools.filter(x => !x.startsWith("mcp__"));
      const STATUS = { connected: ["ok", "CONNECTED"], "needs-auth": ["wait", "NEEDS SIGN-IN"], pending: ["wait", "STARTING"], failed: ["bad", "FAILED"], disabled: ["off", "OFF"] };
      fill(box,
        h("p", { class: "small tool-meta", text: [t.model && `Model ${t.model}`, t.version && `Claude Code ${t.version}`, t.permission_mode && `permissions: ${t.permission_mode}`].filter(Boolean).join(" · ") }),
        t.mcp_servers.length ? h("ul", { class: "mcp-list" }, t.mcp_servers.map(m => {
          const [cls, label] = STATUS[m.status] || ["off", String(m.status || "?").toUpperCase()], n = mcpTools.filter(x => x.startsWith(slug(m.name))).length;
          return h("li", {}, h("i", { class: `mcp-dot ${cls}`, "aria-hidden": "true" }), h("span", { class: "mcp-name", text: m.name }),
            h("span", { class: "muted", text: n ? ` · ${n} tool${n === 1 ? "" : "s"}` : "" }), h("span", { class: `mcp-status ${cls}`, text: label }));
        })) : h("p", { class: "muted small", text: "No MCP servers." }),
        group("builtin", "BUILT-IN TOOLS", builtIn, x => chip(x)),
        group("mcp", "MCP TOOLS", mcpTools, x => { // "mcp__claude_ai_Gmail__search" -> "claude.ai Gmail › search"
          const m = t.mcp_servers.find(m => x.startsWith(slug(m.name)));
          return chip(m ? `${m.name} › ${x.slice(slug(m.name).length)}` : x.replace(/^mcp__/, "").replace("__", " › "), "mcp");
        }),
        group("skills", "SKILLS", t.skills, x => chip(x)),
        group("plugins", "PLUGINS", t.plugins, p => chip(p.version ? `${p.name} ${p.version}` : p.name)),
        group("agents", "SUB-AGENT TYPES", t.agents, x => chip(x)),
        h("p", { class: "muted small", text: `As its ${t.where === "usage check" ? "hourly usage check" : "last sub-agent"} saw it, ${ago(t.at)}.` }));
    };
    const hit = this.toolCache?.[claude];
    if (hit) draw(hit.t);
    if (!hit || Date.now() - hit.at > 30000) api(`api/agents/${encodeURIComponent(claude)}/tools`).then(t => {
      this.toolCache = { ...(this.toolCache || {}), [claude]: { at: Date.now(), t } }; draw(t);
    }).catch(() => {});
    return box;
  },

  // ---------------------------------------------------------------- sessions
  /** A Claude's sessions (conversations, sub-agent runs), every one recorded in the farm's store by its hook. */
  sessionList(claude, task) {
    const box = h("div", { class: "sessions" }), key = claude + "|" + (task || "");
    const draw = (rows) => {
      rows = rows.filter(s => task ? s.task === task : s.kind !== "usage");
      if (!rows.length) return fill(box, h("p", { class: "muted small", text: task ? "Its session is recorded once it starts." : "No sessions recorded yet. Talk to it in the Claude app: every conversation shows up here." }));
      fill(box, h("ul", { class: "subs" }, rows.slice(0, 8).map(s => h("li", {},
        h("span", { class: `badge ${s.kind === "conversation" ? "done" : "running"}`, text: s.kind === "conversation" ? "TALK" : "SUB-AGENT" }),
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.openSession(s.id, this.summaryKey); } }, (s.title || "(untitled)").slice(0, 70)),
        h("span", { class: "muted", text: ` · ${s.turns || 0} turns · ${ago(s.last_at)}` })))));
    };
    const hit = this.sessCache?.[key];
    if (hit) draw(hit.rows);
    if (!hit || Date.now() - hit.at > 8000) api(`api/sessions?claude=${encodeURIComponent(claude)}`).then(rows => {
      this.sessCache = { ...(this.sessCache || {}), [key]: { at: Date.now(), rows } }; draw(rows);
    }).catch(() => {});
    return box;
  },
  async openSession(id, back) {
    for (const d of $$("dialog[open]")) d.close();
    $("#talk-kicker").textContent = "SESSION"; $("#talk-h").textContent = "…"; fill($("#talk-body"), h("p", { class: "muted", text: "Loading…" }));
    fill($("#talk-actions"), back ? h("button", { class: "btn", type: "button", onclick: () => { const c = Scene.critters.get(back); if (c) this.openCritter(c); } }, "◀ BACK") : null);
    $("#dlg-talk").showModal();
    let s;
    try { s = await api(`api/sessions/${id}`); } catch (x) { fill($("#talk-body"), h("p", { class: "form-error", text: x.message })); return; }
    $("#talk-kicker").textContent = `${s.kind === "conversation" ? "CONVERSATION" : "SUB-AGENT SESSION"} · ${String(s.claude || "").toUpperCase()} · ${ago(s.started)}`;
    $("#talk-h").textContent = (s.title || "(untitled)").slice(0, 90);
    const who = (t) => t.kind === "tool_result" ? "TOOL" : t.role === "assistant" ? String(s.claude || "CLAUDE").toUpperCase() : s.kind === "conversation" ? "YOU" : "THE FARM";
    fill($("#talk-body"), s.conversation.length ? s.conversation.map(t => h("div", { class: `turn ${t.role} k-${t.kind}` },
      h("b", { text: who(t) + (t.kind === "tool" ? " · TOOL CALL" : "") }), h("div", { text: t.text }))) : h("p", { class: "muted", text: "Nothing said yet." }));
  },

  // -------------------------------------------------------------------- slack
  /** Give the farm work from Slack: one Slack app made from a prefilled manifest, two tokens pasted back. */
  async openSlack() {
    for (const d of $$("dialog[open]")) d.close();
    fill($("#slack-body"), h("p", { class: "muted", text: "Loading…" }));
    $("#dlg-slack").showModal();
    await this.loadSlack();
  },
  async loadSlack() {
    clearTimeout(this.slackPoll);
    if (!$("#dlg-slack").open) return;
    let s;
    try { s = await api("api/slack"); } catch (x) { fill($("#slack-body"), h("p", { class: "form-error", text: x.message })); return; }
    this.renderSlack(s);
    if (s.configured && !["live", "error", "off"].includes(s.state)) this.slackPoll = setTimeout(() => this.loadSlack(), 1500);
  },
  renderSlack(s) {
    const body = $("#slack-body"), key = JSON.stringify([s.configured, s.state, s.error, s.team, s.allow, s.last?.at]);
    if (body.dataset.key === key && body.contains(document.activeElement)) return; // don't wipe what's being typed
    body.dataset.key = key;
    const splitAllow = (v) => String(v || "").split(/[\s,]+/).filter(Boolean);
    const allowInput = (value) => h("input", { name: "allow", autocomplete: "off", spellcheck: "false", value: (value || []).join(", "),
      placeholder: "everyone in the workspace (no guests)" });
    if (s.configured) {
      const cls = s.state === "live" ? "live" : s.state === "error" ? "error" : "wait";
      const status = { live: `● CONNECTED TO ${String(s.team || "SLACK").toUpperCase()}`, error: "● NOT CONNECTED", wait: "● CONNECTING…" }[cls];
      const bot = s.bot ? "@" + s.bot : "the farm's app";
      const allowForm = h("form", { class: "slack-form" },
        h("div", { class: "row" }, h("label", {}, "WHO CAN GIVE IT WORK", allowInput(s.allow)), h("button", { class: "btn", type: "submit" }, "SAVE")),
        h("p", { class: "muted small", text: "Emails or Slack member IDs, separated by commas. Empty: every full member of the workspace. Guests, bots and people from other companies in shared channels never can." }),
        h("p", { class: "form-error", role: "alert" }));
      allowForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = allowForm.querySelector("button"); btn.disabled = true;
        try { const r = await api("api/slack/allow", { allow: new FormData(allowForm).get("allow") }); btn.textContent = "SAVED ✓"; setTimeout(() => this.renderSlack(r), 900); }
        catch (x) { allowForm.querySelector(".form-error").textContent = x.message; btn.disabled = false; }
      });
      const acts = [];
      if (!s.from_env) {
        const off = h("button", { class: "btn danger", type: "button" }, "DISCONNECT");
        off.addEventListener("click", async () => {
          if (off.dataset.sure !== "1") { off.dataset.sure = "1"; off.textContent = "SURE? IT STOPS LISTENING"; return; }
          off.disabled = true;
          try { const r = await api("api/slack/disconnect", {}); this.say("The farm left Slack."); body.dataset.key = ""; this.renderSlack(r); this.refresh(); }
          catch (x) { off.textContent = x.message.slice(0, 40); }
        });
        acts.push(off);
      }
      if (cls === "error") acts.push(h("button", { class: "btn primary", type: "button", onclick: () => { body.dataset.key = ""; this.renderSlack({ ...s, configured: false }); } }, "ENTER NEW TOKENS"));
      fill(body,
        h("p", { class: `slack-status ${cls}`, text: status }),
        s.error && cls !== "live" ? h("p", { class: "form-error", text: s.error }) : null,
        h("p", { text: `DM ${bot} in Slack, or @mention it in a channel (invite it there first: /invite ${bot}). A sub-agent does the job and answers in the thread. Type “status” for the farm.` }),
        s.dm_url ? h("a", { class: "btn primary login-link", href: s.dm_url, target: "_blank", rel: "noopener noreferrer" }, "OPEN IN SLACK ↗") : null,
        s.last ? h("p", { class: "muted small", text: `Last message: ${s.last.from}, ${ago(s.last.at)}: “${s.last.text}”` }) : null,
        allowForm,
        s.from_env ? h("p", { class: "muted small", text: "The tokens come from the environment (FARM_SLACK_BOT_TOKEN, FARM_SLACK_APP_TOKEN): change them there." }) : null,
        h("div", { class: "dlg-actions" }, acts));
      return;
    }
    const tok = (name, prefix) => h("input", { name, type: "password", autocomplete: "off", spellcheck: "false", required: true, placeholder: prefix + "…",
      oninput: (e) => e.target.closest("li").classList.toggle("done", e.target.value.trim().startsWith(prefix)) });
    const form = h("form", { class: "slack-form" },
      h("ol", { class: "hatch-steps" },
        h("li", {}, "Create the farm's Slack app. On the Slack page: Create an App → From a manifest → Continue. Everything is filled in: Next → Create (pick your workspace if it asks).",
          h("a", { class: "btn primary login-link", href: s.manifest_url, target: "_blank", rel: "noopener noreferrer",
            onclick: (e) => e.target.closest("li").classList.add("done") }, "CREATE THE SLACK APP ↗")),
        h("li", {}, "On the app's page: Install to Workspace → Allow. Then open OAuth & Permissions and copy the Bot User OAuth Token.",
          h("label", {}, "BOT TOKEN", tok("bot_token", "xoxb-"))),
        h("li", {}, "Open Basic Information → App-Level Tokens → Generate Token and Scopes. Any name, add the scope connections:write, Generate, and copy it.",
          h("label", {}, "APP-LEVEL TOKEN", tok("app_token", "xapp-"))),
        h("li", {}, h("label", {}, "WHO CAN GIVE IT WORK ", h("span", { class: "muted", text: "(optional)" }), allowInput(s.allow)),
          h("p", { class: "muted small", text: "Emails or Slack member IDs. Empty: every full member of the workspace (never guests)." }))),
      h("p", { class: "muted small", text: "The farm connects out to Slack (Socket Mode): no public URL, no open port. The tokens stay on the farm and are never shown again." }),
      h("p", { class: "form-error", role: "alert" }),
      h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "submit" }, "▶ CONNECT")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(form), btn = form.querySelector("button[type=submit]"), err = form.querySelector(".form-error");
      btn.disabled = true; btn.textContent = "CHECKING WITH SLACK…"; err.textContent = "";
      try {
        const r = await api("api/slack", { bot_token: f.get("bot_token"), app_token: f.get("app_token"), allow: splitAllow(f.get("allow")).join(",") });
        body.dataset.key = ""; this.renderSlack(r); this.loadSlack(); this.refresh();
      } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "▶ CONNECT"; }
    });
    fill(body, h("p", { text: "Give the farm work from Slack: DM it or @mention it, and a sub-agent does the job and answers in the thread. About two minutes, once." }), form);
  },

  // ----------------------------------------------------------------- hatching
  /** + NEW CLAUDE: name (or a bot's provider), then its look, then its rules; then the Claude login (or the bot check). */
  openHatch(agentId, fromButton) {
    const R = role(), st = App.state, hatch = App.me?.hatch;
    if (!agentId && fromButton && !R.manager && hatch && !hatch.can) { this.say(`You can't hatch a Claude here: ${hatch.why}.`); return; }
    if (!agentId && fromButton && R.owner && !R.manager) { this.say("You have a Claude on this farm already: tap the gold arrow."); return; }
    for (const d of $$("dialog[open]")) d.close();
    const primary = st?.agents.find(a => a.primary);
    if (!agentId && R.manager && primary && !primary.loggedIn) agentId = primary.id; // the farm's own login comes first
    this.hatchFor = agentId || null;
    $("#hatch-body").dataset.key = "";
    $("#dlg-hatch").showModal();
    if (agentId) { this.renderHatch({ state: "starting" }); this.beginLogin(agentId); }
    else {
      this.draft = { kind: "claude", name: "", bot: null, approve: true, allTools: true, deny: new Set(),
        skin: { hat: "straw", colors: { hat: SWATCHES[hashStr(String(Date.now())) % 8], band: HATS.straw.band, body: CLAY.b }, accessory: "" } };
      this.renderHatchName();
    }
  },
  hatchStep(n, title) { return h("p", { class: "kicker step", text: `STEP ${n} OF 3 · ${title}` }); },
  renderHatchName(kind) {
    const D = this.draft;
    if (kind) D.kind = kind;
    kind = D.kind;
    const pick = h("div", { class: "hatch-kind", role: "group", "aria-label": "What to add" },
      h("button", { class: "btn" + (kind === "claude" ? " primary" : ""), type: "button", "aria-pressed": String(kind === "claude"), onclick: () => this.renderHatchName("claude") }, "CLAUDE ACCOUNT"),
      h("button", { class: "btn" + (kind === "bot" ? " primary" : ""), type: "button", "aria-pressed": String(kind === "bot"), onclick: () => this.renderHatchName("bot") }, "BOT: OTHER MODEL"));
    if (kind === "bot") return this.renderBotForm(pick);
    const form = h("form", {}, this.hatchStep(1, "NAME"), pick,
      h("canvas", { class: "egg-anim", width: 12, height: 12, id: "egg-cv" }),
      h("label", {}, "NAME ", h("span", { class: "muted", text: "(optional)" }), h("input", { name: "name", maxlength: 24, placeholder: "e.g. gil or night-shift", autocomplete: "off", value: D.name })),
      h("p", { class: "muted", text: "A new Claude Code login with its own agents. Log in with another Claude account to add capacity: each account is paced on its own budget. The same account again just shares its budget." }),
      h("p", { class: "form-error", role: "alert" }),
      h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "submit" }, "NEXT: ITS LOOK ▶")));
    form.addEventListener("submit", (e) => { e.preventDefault(); D.name = new FormData(form).get("name"); this.renderHatchLook(); });
    fill($("#hatch-body"), form);
    $("#egg-cv").getContext("2d").drawImage(EGG, 0, 0);
    form.querySelector("input[name=name]").focus();
  },
  renderHatchLook() {
    const D = this.draft;
    const picker = this.skinPicker(D.skin, (s) => { D.skin = s; });
    fill($("#hatch-body"), this.hatchStep(2, "ITS LOOK"), picker,
      h("div", { class: "dlg-actions" },
        h("button", { class: "btn", type: "button", onclick: () => this.renderHatchName() }, "◀ BACK"),
        h("button", { class: "btn primary", type: "button", onclick: () => this.renderHatchRules() }, "NEXT: ITS RULES ▶")));
  },
  /** Who may start work on it, and which tools it may use: the same checklist SETTINGS has. */
  rulesFields(state, groups) {
    const approve = h("input", { type: "checkbox", checked: state.approve, onchange: (e) => { state.approve = e.target.checked; } });
    const list = h("ul", { class: "checklist", hidden: state.allTools });
    const all = h("input", { type: "checkbox", checked: state.allTools, onchange: (e) => { state.allTools = e.target.checked; list.hidden = state.allTools; } });
    fill(list, (groups || []).map(gp => h("li", {}, h("label", { class: "check" },
      h("input", { type: "checkbox", checked: !state.deny.has(gp.id), onchange: (e) => { if (e.target.checked) state.deny.delete(gp.id); else state.deny.add(gp.id); } }),
      h("span", { text: gp.label })))));
    if (!groups) this.toolGroups().then(gs => fill(list, gs.map(gp => h("li", {}, h("label", { class: "check" },
      h("input", { type: "checkbox", checked: !state.deny.has(gp.id), onchange: (e) => { if (e.target.checked) state.deny.delete(gp.id); else state.deny.add(gp.id); } }),
      h("span", { text: gp.label })))))).catch(() => fill(list, h("li", { class: "muted small", text: "Couldn't load the tool groups." })));
    return [
      h("label", { class: "check toggle" }, approve, "APPROVE EVERY MISSION"),
      h("p", { class: "muted small why", text: "Other Claudes and the planner can't start work on it without your OK, on your phone. Its own work (what you ask it in the Claude app) always runs." }),
      h("label", { class: "check toggle" }, all, "ALL TOOLS"),
      h("p", { class: "muted small why", text: "Off: pick what it may use. Unticked tools are blocked at its next tool call." }),
      list];
  },
  async toolGroups() {
    if (!this.groups) this.groups = await api("api/tools");
    return this.groups;
  },
  renderHatchRules() {
    const D = this.draft, err = h("p", { class: "form-error", role: "alert" });
    const go = h("button", { class: "btn primary", type: "button" }, D.kind === "bot" ? "▶ CHECK & ADD BOT" : "▶ HATCH IT");
    go.addEventListener("click", () => this.submitHatch(go, err));
    fill($("#hatch-body"), this.hatchStep(3, "ITS RULES"), this.rulesFields(D), err,
      h("div", { class: "dlg-actions" },
        h("button", { class: "btn", type: "button", onclick: () => this.renderHatchLook() }, "◀ BACK"), go));
  },
  async submitHatch(btn, err) {
    const D = this.draft;
    const body = { name: D.name || "", approve_missions: D.approve, tools: D.allTools ? "all" : { deny: [...D.deny] }, skin: D.skin };
    if (D.kind === "bot") body.bot = D.bot;
    btn.disabled = true; btn.textContent = D.kind === "bot" ? "ASKING THE MODEL…" : "HATCHING…"; err.textContent = "";
    try {
      const a = await api("api/agents", body);
      this.hatchFor = a.id; this.loadMe();
      if (D.kind === "bot") {
        const cv = h("canvas", { class: "egg-anim", width: 18, height: 18 });
        cv.getContext("2d").drawImage(skinFrame(skinOf(D.skin.hat, D.skin.colors, D.skin.accessory), { legs: 0, arms: 1 }), 1, 0);
        fill($("#hatch-body"), cv, h("p", { class: "center", text: `${a.name.toUpperCase()} joined! ${D.bot.model} answered “${a.said}”. It's on the farm in a few seconds: send it work with --on ${a.id}.` }),
          h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => $("#dlg-hatch").close() }, "▶ YAY")));
        this.say(`${a.name.toUpperCase()} joined the farm!`);
      } else { $("#hatch-body").dataset.key = ""; this.renderHatch({ state: "starting" }); this.pollHatch(); }
      this.refresh();
    } catch (x) {
      err.textContent = x.status === 409 ? "You have a Claude on this farm already." : x.status === 429 ? x.message : x.message;
      btn.disabled = false; btn.textContent = D.kind === "bot" ? "▶ CHECK & ADD BOT" : "▶ HATCH IT";
    }
  },
  renderBotForm(pick) { // a bot: Claude Code on another model, through a provider that speaks Anthropic's API
    const P = BOT_PROVIDERS, D = this.draft, B = D.bot || {};
    const url = h("input", { name: "url", autocomplete: "off", spellcheck: "false", required: true }),
      model = h("input", { name: "model", autocomplete: "off", spellcheck: "false", required: true, maxlength: 128, value: B.model || "" }),
      key = h("input", { name: "key", type: "password", autocomplete: "off", spellcheck: "false", maxlength: 500, value: B.key || "" }),
      keyNote = h("span", { class: "muted" }), hint = h("p", { class: "muted small" });
    const provider = h("select", { name: "provider" }, Object.entries(P).map(([k, p]) => h("option", { value: k, text: p.label, selected: B.provider === k })));
    const sync = (keepUrl) => {
      const p = P[provider.value];
      url.value = keepUrl && B.url ? B.url : p.url; url.placeholder = p.url || "https://your-gateway.example.com";
      model.placeholder = p.example ? `e.g. ${p.example}` : "the model, as the provider names it";
      key.required = p.key; keyNote.textContent = p.key ? "" : " (optional)"; hint.textContent = p.hint;
    };
    provider.addEventListener("change", () => sync(false));
    const form = h("form", {}, this.hatchStep(1, "THE BOT"), pick,
      h("p", { class: "muted", text: "A bot is Claude Code on another model: a free one on OpenRouter, or your own through Ollama. It uses no Claude account's usage, but it's weaker than Claude, so it takes only the sub-agents sent to it." }),
      h("label", {}, "NAME ", h("span", { class: "muted", text: "(optional)" }), h("input", { name: "name", maxlength: 24, placeholder: "e.g. qwen or night-bot", autocomplete: "off", value: D.name })),
      h("label", {}, "PROVIDER", provider),
      h("label", {}, "ADDRESS", url),
      h("label", {}, "MODEL", model),
      h("label", {}, "API KEY", keyNote, key),
      hint,
      h("label", { class: "check" }, h("input", { name: "any", type: "checkbox", checked: B.takes === "any" }), "ALSO TAKE ANY SUB-AGENT ", h("span", { class: "muted", text: "(not only the ones sent to it)" })),
      h("p", { class: "form-error", role: "alert" }),
      h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "submit" }, "NEXT: ITS LOOK ▶")));
    sync(true);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(form);
      D.name = f.get("name");
      D.bot = { provider: f.get("provider"), url: f.get("url"), model: f.get("model"), key: f.get("key"), takes: f.get("any") ? "any" : "sent" };
      if (!B.provider) D.skin = { ...D.skin, hat: D.skin.hat === "straw" ? "headphones" : D.skin.hat };
      this.renderHatchLook();
    });
    fill($("#hatch-body"), form);
    model.focus();
  },
  async beginLogin(id) {
    try { const s = await api(`api/agents/${id}/login`, {}); this.renderHatch(s); this.pollHatch(); }
    catch (x) { this.renderHatch({ state: "failed", error: x.message }); }
  },
  pollHatch() {
    this.stopHatchPoll();
    this.hatchPoll = setInterval(async () => {
      if (!this.hatchFor) return;
      try { const s = await api(`api/agents/${this.hatchFor}/login`); this.renderHatch(s); if (s.state === "done" || s.state === "failed") this.stopHatchPoll(); }
      catch { /* keep polling */ }
    }, 1000);
  },
  stopHatchPoll() { clearInterval(this.hatchPoll); this.hatchPoll = null; },
  renderHatch(s) {
    const body = $("#hatch-body"), key = s.state + "|" + (s.url || "") + "|" + (s.error || "");
    if (body.dataset.key === key) return;
    body.dataset.key = key;
    const agent = App.state?.agents.find(a => a.id === this.hatchFor);
    const name = (agent?.name || this.hatchFor || "claude").toUpperCase();
    const egg = h("canvas", { class: "egg-anim", width: 12, height: 12 });
    egg.getContext("2d").drawImage(EGG, 0, 0);
    if (s.state === "done") {
      const cv = h("canvas", { class: "egg-anim", width: 18, height: 18 });
      const skin = agent ? agentSkin(agent) : this.draft ? skinOf(this.draft.skin.hat, this.draft.skin.colors, this.draft.skin.accessory) : skinOf("straw", null, "", colorFor(this.hatchFor || ""));
      cv.getContext("2d").drawImage(skinFrame(skin, { legs: 0, arms: 1 }), 1, 0);
      fill(body, cv, h("p", { class: "center", text: `${name} hatched! It's logged in and joins the farm in a few seconds.` }),
        h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => $("#dlg-hatch").close() }, "▶ YAY")));
      this.say(`${name} hatched!`); this.refresh();
      return;
    }
    if (s.state === "failed") {
      fill(body, egg, h("p", { class: "form-error", text: s.error || "The login didn't finish." }),
        h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => { body.dataset.key = ""; this.renderHatch({ state: "starting" }); this.beginLogin(this.hatchFor); } }, "↻ TRY AGAIN")));
      return;
    }
    const codeForm = h("form", {},
      h("label", {}, "LOGIN CODE", h("input", { name: "code", autocomplete: "off", spellcheck: "false", required: true, placeholder: "paste the code from the Claude page", disabled: s.state !== "waiting_code" })),
      h("p", { class: "form-error", role: "alert" }),
      h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "submit", disabled: s.state !== "waiting_code" }, s.state === "checking" ? "HATCHING…" : "▶ DONE")));
    codeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { const r = await api(`api/agents/${this.hatchFor}/code`, { code: new FormData(codeForm).get("code") }); this.renderHatch(r); this.pollHatch(); }
      catch (x) { codeForm.querySelector(".form-error").textContent = x.message; }
    });
    const link = s.url ? h("a", { class: "btn primary login-link", href: s.url, target: "_blank", rel: "noopener noreferrer" }, "OPEN THE CLAUDE LOGIN ↗")
      : h("p", { class: "muted", text: "Warming the egg… (starting Claude Code's login)" });
    fill(body, egg,
      h("p", { class: "center", text: `Log ${name} in to a Claude account.` }),
      h("ol", { class: "hatch-steps" },
        h("li", { class: s.url ? "done" : "" }, "Open the Claude login page and approve.", link),
        h("li", {}, "Copy the code it shows you and paste it here.", codeForm),
        h("li", {}, "The egg hatches: talk to the new Claude from its Claude app, or let yours hand it work.")));
    if (s.state === "waiting_code") setTimeout(() => codeForm.querySelector("input")?.focus(), 30);
  },

  // -------------------------------------------------------------- skin picker
  /** Pick a Claude's look with a live preview: hat, hat colour, band colour, body tint, accessory. `onChange` gets
   * {hat, colors: {hat, band, body}, accessory} (what POST /api/agents and SETTINGS take as `skin`). */
  skinPicker(start, onChange) {
    const s = { hat: start.hat || "straw", colors: { ...start.colors }, accessory: start.accessory || "" };
    const pv = h("canvas", { class: "skin-cv", width: 20, height: 20, "aria-label": "Preview" });
    const g = pv.getContext("2d"); g.imageSmoothingEnabled = false;
    let frame = 0;
    const draw = () => {
      const skin = skinOf(s.hat, s.colors, s.accessory);
      const f = frame % 8, pose = { legs: f < 4 ? (f % 2 ? 1 : 2) : 0, look: f < 4 ? 1 : f === 6 ? -1 : 0, blink: f === 5, arms: f === 7 ? 1 : 0 };
      g.clearRect(0, 0, 20, 20); g.drawImage(skinFrame(skin, pose), 2, 1);
    };
    clearInterval(this.previewT);
    this.previewT = setInterval(() => { if (!pv.isConnected) return clearInterval(this.previewT); frame++; draw(); }, REDUCED ? 1200 : 260);
    const opts = h("div", { class: "skin-opts" });
    const row = (label, items) => [h("p", { class: "kicker", text: label }), h("div", { class: "swatches", role: "group", "aria-label": label }, items)];
    const render = () => {
      draw();
      onChange({ hat: s.hat, colors: { ...s.colors }, accessory: s.accessory });
      const hatBtn = (hat) => h("button", { type: "button", class: "hat-btn" + (s.hat === hat ? " on" : ""), "aria-pressed": String(s.hat === hat), title: hat, "aria-label": `hat: ${hat}`,
        onclick: () => { if (s.hat !== hat && !start.keepBand) s.colors.band = HATS[hat].band; s.hat = hat; render(); } },
        h("img", { src: this.spriteURL(skinOf(hat, s.colors, ""), { legs: 0 }), alt: "" }));
      const sw = (key, list) => list.map(col => { const b = h("button", { type: "button", class: "swatch" + (s.colors[key] === col ? " on" : ""), "aria-pressed": String(s.colors[key] === col), "aria-label": `${key} colour ${col}`,
        onclick: () => { s.colors[key] = col; render(); } }); b.style.background = col; return b; });
      fill(opts,
        row("HAT", Object.keys(HATS).map(hatBtn)),
        s.hat === "none" ? null : row("HAT COLOUR", sw("hat", SWATCHES)),
        row("BAND / TRIM", sw("band", SWATCHES)),
        row("BODY", sw("body", BODY_TINTS)),
        row("EXTRA", ACCESSORIES.map(acc => h("button", { type: "button", class: "btn tiny" + (s.accessory === acc ? " primary" : ""), "aria-pressed": String(s.accessory === acc),
          onclick: () => { s.accessory = acc; render(); } }, (acc || "none").toUpperCase()))));
    };
    render();
    return h("div", { class: "skin" }, h("div", { class: "skin-preview" }, pv), opts);
  },

  // --------------------------------------------------------------- approvals
  /** Missions waiting for a person's OK. The count comes with every poll; the list only when it changes (or every 20s). */
  async syncApprovals(st) {
    const R = role(), n = R.manager ? st.me?.pending_all || 0 : st.me?.pending || 0;
    if (!n) { if (App.apprCount !== 0) { App.approvals = []; Scene.pendingFor = {}; App.apprCount = 0; if ($("#dlg-approvals").open) this.renderApprovals(); } return; }
    if (n === App.apprCount && Date.now() - (App.apprAt || 0) < 20000) return;
    App.apprCount = n;
    await this.loadApprovals();
  },
  async loadApprovals() {
    App.apprAt = Date.now();
    try { this.setApprovals(await api("api/approvals")); }
    catch (x) { App.apprError = x.message; if ($("#dlg-approvals").open) this.renderApprovals(); }
  },
  setApprovals(list) {
    App.approvals = Array.isArray(list) ? list : []; App.apprError = null;
    const by = {};
    for (const p of App.approvals) if (p.to) by[p.to] = (by[p.to] || 0) + 1;
    Scene.pendingFor = by;
    if ($("#dlg-approvals").open) this.renderApprovals();
  },
  async openApprovals(focusId, forClaude) {
    for (const d of $$("dialog[open]")) d.close();
    this.apprFocus = focusId || null; this.apprFor = forClaude || null;
    fill($("#appr-body"), h("p", { class: "muted", text: "Loading…" }));
    $("#dlg-approvals").showModal();
    const R = role();
    if (R.manager || R.owner) await this.loadApprovals();
    this.renderApprovals();
  },
  renderApprovals() {
    const R = role(), body = $("#appr-body"), st = App.state;
    if (body.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return; // someone is typing a reason
    const nameOf = (id) => (st?.agents.find(a => a.id === id)?.name || id || "?").toUpperCase();
    if (!R.manager && !R.owner) {
      $("#appr-sub").textContent = "";
      const box = h("div", { class: "login inset" });
      fill(body, h("p", { text: "Missions for your Claude wait here for your OK. Sign in to your Claude first:" }), box);
      this.accountForms(box, { tabs: ["mine"], onDone: async () => { await this.loadMe(); await this.refresh(); this.openApprovals(this.apprFocus); } });
      return;
    }
    let list = App.approvals || [];
    if (this.apprFor) list = list.filter(p => p.to === this.apprFor);
    $("#appr-sub").textContent = R.manager ? "Every Claude's missions that wait for their person (you can decide for any of them)." : "Missions other Claudes (or the planner) want your Claude to do. Nothing starts until you say so.";
    if (App.apprError) { fill(body, h("p", { class: "form-error", text: App.apprError })); return; }
    if (!list.length) {
      fill(body, h("p", { class: "center big-ok", text: "✓ NOTHING WAITING" }), this.apprFor ? h("p", { class: "center" }, h("button", { class: "btn", type: "button", onclick: () => { this.apprFor = null; this.renderApprovals(); } }, "SEE EVERY CLAUDE'S")) : null);
      return;
    }
    const card = (p) => {
      const reason = h("input", { class: "reason", placeholder: "why not? (optional, it's told)", maxlength: 300, hidden: true, "aria-label": "Reason" });
      const err = h("p", { class: "form-error", role: "alert" });
      const yes = h("button", { class: "btn primary big", type: "button" }, "✓ APPROVE"), no = h("button", { class: "btn danger big", type: "button" }, "✕ DENY");
      const el = h("article", { class: "appr" + (p.id === this.apprFocus ? " focus" : ""), "data-id": p.id },
        h("p", { class: "appr-who" }, h("b", { text: String(p.from || "someone").toUpperCase() }), p.type === "message" ? " wants to send " : " asks ", h("b", { text: nameOf(p.to) }),
          p.type === "message" ? " a message" : " to do a mission"),
        h("h3", { text: p.title || "(untitled)" }),
        h("pre", { class: "appr-prompt", text: p.prompt || "(no prompt)" }),
        h("p", { class: "muted small", text: `Asked ${ago(p.at)}` + (p.expires_at ? ` · expires in ${until(p.expires_at)} (then it's denied)` : "") }),
        reason, err, h("div", { class: "appr-acts" }, no, yes));
      const decide = async (ok) => {
        yes.disabled = no.disabled = true; err.textContent = "";
        try {
          const list2 = await api(`api/approvals/${encodeURIComponent(p.id)}/${ok ? "approve" : "deny"}`, ok ? {} : { reason: reason.value.trim() || undefined });
          el.classList.add("decided"); this.say(ok ? `Approved: “${p.title}”. ${nameOf(p.to)} starts on it.` : `Denied: “${p.title}”.`);
          setTimeout(() => { this.setApprovals(list2); this.refresh(); }, 250);
        } catch (x) { err.textContent = x.message; yes.disabled = no.disabled = false; }
      };
      yes.addEventListener("click", () => decide(true));
      no.addEventListener("click", () => {
        if (reason.hidden) { reason.hidden = false; no.textContent = "✕ DENY IT"; reason.focus(); return; }
        decide(false);
      });
      return el;
    };
    fill(body, list.slice(0, 200).map(card), list.length > 200 ? h("p", { class: "muted small", text: `…and ${list.length - 200} more.` }) : null);
    if (this.apprFocus && !this.apprFocusT) { // the ?approve=<id> link: show that one (once the list has settled)
      this.apprFocusT = setTimeout(() => { body.querySelector(".appr.focus")?.scrollIntoView({ block: "center" }); this.apprFocus = null; this.apprFocusT = null; }, 150);
    }
  },

  // ------------------------------------------------------------------ roster
  openRoster() {
    for (const d of $$("dialog[open]")) d.close();
    $("#dlg-roster").showModal();
    this.renderRoster();
    if (matchMedia("(hover: hover)").matches) $("#roster-q").focus();
  },
  /** Every Claude in one searchable list: with 100 of them, this is how you find one. */
  renderRoster() {
    const st = App.state; if (!st) return;
    const q = $("#roster-q").value.trim().toLowerCase(), sort = $("#roster-sort").value, by = st.tokens?.by_claude || {};
    const subsOf = new Map();
    for (const t of st.subagents) { if (!subsOf.has(t.owner)) subsOf.set(t.owner, []); subsOf.get(t.owner).push(t); }
    const rank = (a) => !a.loggedIn && !a.remote ? 5 : a.error ? 1 : subsOf.has(a.id) || a.talking ? 0 : !a.alive ? 4 : a.resting ? 3 : 2;
    const task = (a) => a.talking ? `talking: ${a.talking.title || "a conversation"}` : subsOf.has(a.id) ? subsOf.get(a.id)[0].title + (subsOf.get(a.id).length > 1 ? ` (+${subsOf.get(a.id).length - 1})` : "") : "";
    let rows = st.agents.map(a => ({ a, task: task(a), tokens: by[a.id] || 0, h5: a.budget?.five_hour ?? -1, d7: a.budget?.seven_day ?? -1, rank: rank(a) }));
    if (q) rows = rows.filter(r => (r.a.name + " " + r.a.id + " " + r.task).toLowerCase().includes(q));
    const cmp = { name: (x, y) => x.a.name.localeCompare(y.a.name), tokens: (x, y) => y.tokens - x.tokens, h5: (x, y) => y.h5 - x.h5, d7: (x, y) => y.d7 - x.d7,
      status: (x, y) => (y.a.mine - x.a.mine) || (x.rank - y.rank) || x.a.name.localeCompare(y.a.name) }[sort];
    rows.sort(cmp);
    $("#roster-count").textContent = `${rows.length} of ${st.agents.length} · tap one to find it on the farm`;
    const list = $("#roster-list"), sig = JSON.stringify([q, sort, rows.map(r => [r.a.id, r.task, r.tokens, r.h5, r.d7, r.rank, Scene.pendingFor[r.a.id] || 0])]);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    const STATE = ["BUSY", "ERROR", "READY", "RESTING", "NOT RUNNING", "EGG"];
    const bar = (u) => { const i = h("i", { class: u < 0.5 ? "" : u < 0.8 ? "mid" : "low" }); i.style.width = `${Math.round(clamp(u, 0, 1) * 100)}%`; return h("span", { class: "mbar" }, i); };
    fill(list, rows.map(({ a, task: tk, tokens, rank: rk }) => {
      const b = a.budget || {}, waitingN = Scene.pendingFor[a.id] || 0;
      return h("li", {}, h("button", { type: "button", class: "roster-row" + (a.mine ? " mine" : ""), onclick: () => { $("#dlg-roster").close(); this.focusAgent(a.id); } },
        !a.loggedIn && !a.remote ? h("img", { class: "r-sprite", src: icon("egg"), alt: "" }) : h("img", { class: "r-sprite", src: this.spriteURL(agentSkin(a)), alt: "" }),
        h("span", { class: "r-main" },
          h("span", { class: "r-name" }, h("b", { text: a.name.toUpperCase() }),
            a.mine ? h("span", { class: "badge mine", text: "★ MINE" }) : null,
            a.approve_missions ? h("span", { class: "badge waiting", text: "✓ OK'S MISSIONS", title: "Its person approves every mission" }) : null,
            a.bot ? h("span", { class: "badge queued", text: "BOT" }) : null,
            waitingN ? h("span", { class: "badge failed", text: `⚑ ${waitingN}` }) : null),
          h("span", { class: "r-sub" }, h("span", { class: `r-state s${rk}`, text: STATE[rk] }), tk ? h("span", { class: "r-task", text: " · " + tk }) : null)),
        h("span", { class: "r-nums" },
          h("span", { class: "r-tok", text: fmtShort(tokens) + " TOK" }),
          a.bot ? null : h("span", { class: "r-bars" }, h("span", { text: "5H" }), bar(b.five_hour || 0), h("span", { text: pct(b.five_hour) }),
            h("span", { text: "7D" }), bar(b.seven_day || 0), h("span", { text: pct(b.seven_day) })))));
    }));
  },

  // ----------------------------------------------------------------- planner
  openPlanner() {
    if (!App.state?.planner) return;
    for (const d of $$("dialog[open]")) d.close();
    this.renderPlanner();
    $("#dlg-planner").showModal();
  },
  renderPlanner() {
    const P = App.state?.planner; if (!P) return;
    const R = role(), g = $("#plan-sprite").getContext("2d");
    g.imageSmoothingEnabled = false; g.clearRect(0, 0, 24, 26); g.drawImage(SCARECROW[P.on ? 0 : 2], 4, 2);
    $("#plan-sub").textContent = P.on ? "AWAKE: IT PLANS THE FARM'S WORK" : "ASLEEP";
    const next = P.idle_until ? `resting until ${until(P.idle_until)} from now` : P.next_at ? `in ${until(P.next_at)}` : P.on ? "when its sub-agents finish" : "–";
    const task = P.task && (typeof P.task === "object" ? P.task : { id: P.task, title: P.task });
    const host = P.host ? (App.state.agents.find(a => a.id === P.host)?.name || P.host) : "any Claude that lets it";
    const sig = JSON.stringify([P, R.manager]), body = $("#plan-body");
    if (body.dataset.sig === sig) return;
    body.dataset.sig = sig;
    fill(body,
      h("h3", { text: "ITS GOAL" }), h("p", { class: "job-text big", text: P.goal || "(no goal yet: the manager sets one)" }),
      h("dl", { class: "stat-row" },
        h("dt", { text: "STATE" }), h("dd", { text: (P.state || (P.on ? "planning" : "asleep")).toUpperCase() }),
        h("dt", { text: "CYCLES" }), h("dd", { text: String(P.cycles || 0) }),
        h("dt", { text: "LAST CYCLE" }), h("dd", { text: ago(P.last_at) }),
        h("dt", { text: "NEXT CYCLE" }), h("dd", { text: next }),
        h("dt", { text: "EVERY" }), h("dd", { text: everyLabel(P.every_s) }),
        h("dt", { text: "RUNS ON" }), h("dd", { text: host }),
        task ? [h("dt", { text: "ITS TASK" }), h("dd", {}, h("a", { href: "tasks", text: `${task.title || task.id}${task.status ? " · " + String(task.status).toUpperCase() : ""} →` }))] : null),
      h("p", { class: "muted small", text: "Each cycle it looks at the goal and the farm, then hands missions to Claudes that have room. Claudes whose person approves every mission wait for that OK." }));
    const acts = [];
    if (R.manager) {
      const tog = h("button", { class: "btn" + (P.on ? " danger" : " primary"), type: "button" }, P.on ? "PUT IT TO SLEEP" : "▶ WAKE IT UP");
      tog.addEventListener("click", async () => {
        tog.disabled = true;
        try { await api("api/manager/planner", { on: !P.on }); this.say(P.on ? "The planner went to sleep." : "The planner woke up!"); await this.refresh(); }
        catch (x) { tog.textContent = x.message.slice(0, 40); }
      });
      acts.push(h("button", { class: "btn", type: "button", onclick: () => this.openManager() }, "⚙ GOAL & CADENCE"), tog);
    }
    fill($("#plan-actions"), acts);
  },

  // ----------------------------------------------------------------- manager
  async openManager() {
    if (!role().manager) return;
    for (const d of $$("dialog[open]")) d.close();
    fill($("#mgr-body"), h("p", { class: "muted", text: "Loading…" }));
    $("#dlg-manager").showModal();
    try { this.renderManager(await api("api/manager")); }
    catch (x) { fill($("#mgr-body"), h("p", { class: "form-error", text: x.message })); }
  },
  /** One form per section; each posts only its own fields and shows the server's answer (or error) under it. */
  renderManager(m) {
    const S = m.settings || {}, P = m.planner || {};
    const section = (title, fields, save, extra) => {
      const err = h("p", { class: "form-error", role: "alert" }), btn = h("button", { class: "btn primary", type: "submit" }, "SAVE");
      const f = h("form", { class: "mgr-sec" }, h("h3", { text: title }), fields, err, save ? h("div", { class: "dlg-actions" }, extra || null, btn) : null);
      f.addEventListener("submit", async (e) => {
        e.preventDefault(); err.textContent = ""; btn.disabled = true;
        try { await save(f); btn.textContent = "SAVED ✓"; setTimeout(() => { btn.textContent = "SAVE"; btn.disabled = false; }, 1200); this.refresh(); }
        catch (x) { err.textContent = x.message; btn.disabled = false; }
      });
      return f;
    };
    const num = (name, value, min, max) => h("input", { name, type: "number", min, max, value: value ?? "", inputmode: "numeric" });
    // who runs the farm: the persons of these Claudes
    const nameOf = id => (App.state?.agents.find(a => a.id === id)?.name || id).toUpperCase();
    const mgrs = m.managers || [], mgrErr = h("p", { class: "form-error", role: "alert" });
    const change = async (action, claude, btn) => {
      mgrErr.textContent = "";
      if (btn && btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "SURE?"; return; }
      try { const r = await api("api/manager/managers", { action, claude }); await this.loadMe(); this.renderManager(r); if (!role().manager) { $("#dlg-manager").close(); this.say(`${nameOf(claude)}'s person runs the farm now.`); } }
      catch (x) { mgrErr.textContent = x.message; }
    };
    const others = (m.hosts || []).filter(id => !mgrs.includes(id));
    const pick = h("select", { "aria-label": "a Claude" }, others.map(id => h("option", { value: id, text: nameOf(id) })));
    const managers = h("div", { class: "mgr-sec" }, h("h3", { text: "WHO RUNS THE FARM" }),
      h("p", { class: "muted small", text: "The person of each of these Claudes is a manager (signed in to their Claude, like you). No password." }),
      h("ul", { class: "owners" }, mgrs.map(id => {
        const rm = h("button", { class: "btn tiny danger", type: "button", disabled: mgrs.length < 2 }, "REMOVE");
        rm.addEventListener("click", () => change("remove", id, rm));
        return h("li", {}, h("span", { class: "o-name", text: nameOf(id) }), id === role().owner ? h("span", { class: "badge", text: "YOU" }) : null, rm);
      })),
      others.length ? h("div", { class: "dlg-actions left" }, pick,
        h("button", { class: "btn", type: "button", onclick: () => change("add", pick.value) }, "+ MAKE A MANAGER TOO"),
        (() => { const b = h("button", { class: "btn danger", type: "button" }, "HAND IT OVER"); b.addEventListener("click", () => change("set", pick.value, b)); return b; })()) : null,
      mgrErr);
    // planner
    const everyS = P.every_s || 900, everySel = h("select", { name: "every" }, EVERY.map(([l, s]) => h("option", { value: l, text: `every ${l}`, selected: s === everyS })));
    if (!EVERY.some(e => e[1] === everyS)) everySel.prepend(h("option", { value: "", text: `every ${everyLabel(everyS)} (now)`, selected: true }));
    const hostSel = h("select", { name: "host" }, h("option", { value: "", text: "any Claude that lets it" }),
      (m.hosts || []).map(id => h("option", { value: id, text: App.state?.agents.find(a => a.id === id)?.name || id, selected: P.host === id })));
    const onBox = h("input", { type: "checkbox", name: "on", checked: !!P.on });
    const planner = section("THE PLANNER", [
      h("label", { class: "check toggle" }, onBox, "PLANNER ON"),
      h("p", { class: "muted small", text: `${(P.state || "").toUpperCase() || "IDLE"} · ${P.cycles || 0} cycles · last ${ago(P.last_at)}` }),
      h("label", {}, "GOAL", h("textarea", { name: "goal", maxlength: 4000, rows: 3, placeholder: "What should the farm work towards?", text: P.goal || "" })),
      h("div", { class: "two" }, h("label", {}, "RUNS ON", hostSel), h("label", {}, "CADENCE", everySel))],
      async (f) => { const d = new FormData(f), body = { on: onBox.checked, goal: d.get("goal"), host: d.get("host") }; if (d.get("every")) body.every = d.get("every"); await api("api/manager/planner", body); });
    // privacy
    const privBox = h("input", { type: "checkbox", name: "private", checked: !!S.private });
    const privacy = section("PRIVACY", [
      h("label", { class: "check toggle" }, privBox, "PRIVATE FARM"),
      h("p", { class: "muted small", text: S.private ? "Only people with the viewer password (or their own Claude) see it." : "Public: anyone with the link watches (no messages, no logins). Private needs a viewer password." }),
      h("label", {}, "VIEWER PASSWORD ", h("span", { class: "muted", text: S.viewer_password ? "(set: type a new one to change it)" : "(not set)" }),
        h("input", { name: "viewer_password", type: "password", autocomplete: "new-password", minlength: 6, placeholder: "at least 6 characters" }))],
      async (f) => { const d = new FormData(f), body = { private: privBox.checked }; if (d.get("viewer_password")) body.viewer_password = d.get("viewer_password"); await api("api/manager/settings", body); f.reset(); privBox.checked = body.private; });
    // hatching
    const openBox = h("input", { type: "checkbox", name: "hatch_open", checked: !!S.hatch_open });
    const hatching = section("HATCHING", [
      h("label", { class: "check toggle" }, openBox, "ANYONE WHO SEES THE FARM CAN HATCH ONE CLAUDE"),
      h("div", { class: "two" }, h("label", {}, "MAX CLAUDES", num("max_claudes", S.max_claudes, 1, 1000)), h("label", {}, "PER ADDRESS / HOUR", num("hatch_per_ip_hour", S.hatch_per_ip_hour, 1, 100)))],
      async (f) => { const d = new FormData(f); await api("api/manager/settings", { hatch_open: openBox.checked, max_claudes: Number(d.get("max_claudes")), hatch_per_ip_hour: Number(d.get("hatch_per_ip_hour")) }); });
    // owners
    const owned = (m.claudes || []).filter(c => c.owned), q = h("input", { type: "search", placeholder: `search ${owned.length} Claudes with a person…`, "aria-label": "Search owners" });
    const ul = h("ul", { class: "owners" });
    const drawOwners = () => {
      const s = q.value.trim().toLowerCase(), rows = owned.filter(c => !s || c.id.toLowerCase().includes(s));
      fill(ul, rows.slice(0, 150).map(c => {
        const out = h("button", { class: "btn tiny danger", type: "button" }, "SIGN OUT");
        out.addEventListener("click", async () => {
          if (out.dataset.sure !== "1") { out.dataset.sure = "1"; out.textContent = "SURE?"; return; }
          out.disabled = true;
          try { await api(`api/manager/owners/${encodeURIComponent(c.id)}/signout`, {}); c.owned = false; out.textContent = "SIGNED OUT ✓"; }
          catch (x) { out.textContent = x.message.slice(0, 30); }
        });
        return h("li", {}, h("span", { class: "o-name", text: (App.state?.agents.find(a => a.id === c.id)?.name || c.id).toUpperCase() }),
          c.approve_missions ? h("span", { class: "badge waiting", text: "✓ OK'S MISSIONS" }) : null, out);
      }), rows.length > 150 ? h("li", { class: "muted small", text: `…${rows.length - 150} more: search` }) : null,
      !rows.length ? h("li", { class: "muted small", text: "No Claude has a person signed in." }) : null);
    };
    q.addEventListener("input", drawOwners); drawOwners();
    const owners = section("PEOPLE", [h("p", { class: "muted small", text: "Signing a person out forgets every device they signed in on; their Claude stays. They sign in again with a code from their Claude." }), q, ul], null);
    // release
    const roll = h("button", { class: "btn", type: "button" }, "↻ ROLL UI");
    const rollErr = h("p", { class: "form-error", role: "alert" });
    roll.addEventListener("click", async () => {
      if (roll.dataset.sure !== "1") { roll.dataset.sure = "1"; roll.textContent = "SURE? RESTARTS THE UI"; return; }
      roll.disabled = true; roll.textContent = "ROLLING…";
      try { await api("api/manager/roll-ui", {}); roll.textContent = "ROLLED ✓"; this.say("The UI restarted on the new code. The farm kept working."); }
      catch (x) { rollErr.textContent = x.message; roll.disabled = false; roll.textContent = "↻ ROLL UI"; }
    });
    const rel = typeof m.release === "object" && m.release ? Object.entries(m.release).map(([k, v]) => `${k}: ${v}`).join(" · ") : String(m.release || "–");
    const release = h("div", { class: "mgr-sec" }, h("h3", { text: "RELEASE" }),
      h("p", {}, "Version ", h("b", { text: m.version || "?" }), h("span", { class: "muted", text: ` · ${rel}` })),
      h("p", { class: "muted small", text: "ROLL UI restarts the web UI on the code that's installed now (the Claudes keep working, the page stays up)." }),
      rollErr, h("div", { class: "dlg-actions" }, roll));
    fill($("#mgr-body"), managers, planner, privacy, hatching, owners, release);
  },

  // ---------------------------------------------------------------- settings
  async openSettings(id) {
    for (const d of $$("dialog[open]")) d.close();
    fill($("#set-body"), h("p", { class: "muted", text: "Loading…" }));
    $("#set-h").textContent = "SETTINGS";
    $("#dlg-settings").showModal();
    try { this.renderSettings(await api(`api/agents/${encodeURIComponent(id)}/settings`)); }
    catch (x) { fill($("#set-body"), h("p", { class: "form-error", text: x.message })); }
  },
  /** A Claude's own page for its person (or the manager): its name and look, who may start work on it, its tools,
   * phone pushes, the planner, and RELEASE. */
  renderSettings(s) {
    const id = s.id, a = App.state?.agents.find(x => x.id === id);
    $("#set-h").textContent = `SETTINGS · ${String(s.name || id).toUpperCase()}`;
    const sk = skinOf(s.hat || a?.hat || "straw", s.colors, s.accessory, colorFor(id));
    const D = { skin: { hat: sk.hat, colors: { hat: sk.hatC, band: sk.band, body: sk.body }, accessory: sk.acc },
      approve: !!s.approve_missions, allTools: !(s.tools?.deny || []).length, deny: new Set(s.tools?.deny || []) };
    const name = h("input", { name: "name", maxlength: 24, required: true, value: s.name || id, autocomplete: "off" });
    const topic = h("input", { name: "notify_topic", maxlength: 200, value: s.notify_topic || "", placeholder: "e.g. clodfarm-" + id + "-" + (hashStr(id + Date.now()) % 9000 + 1000), autocomplete: "off", spellcheck: "false" });
    const hostOk = h("input", { type: "checkbox", checked: !!s.planner_host_ok });
    const err = h("p", { class: "form-error", role: "alert" }), save = h("button", { class: "btn primary", type: "submit" }, "SAVE");
    const form = h("form", {},
      h("label", {}, "NAME", name),
      h("h3", { text: "LOOK" }), this.skinPicker(D.skin, (v) => { D.skin = v; }),
      h("h3", { text: "RULES" }), this.rulesFields(D, s.groups),
      h("h3", { text: "PHONE NOTIFICATIONS" }),
      h("label", {}, "NTFY TOPIC ", h("span", { class: "muted", text: "(optional)" }), topic),
      h("p", { class: "muted small", text: "Install the ntfy app (iPhone or Android), tap + and subscribe to this topic: missions that need your OK ping your phone. Anyone who knows the topic sees the pings, so make it hard to guess." }),
      h("h3", { text: "THE PLANNER" }),
      h("label", { class: "check toggle" }, hostOk, "LET THE PLANNER RUN ON MY CLAUDE"),
      h("p", { class: "muted small", text: "Its planning cycles then use your Claude's account (a few minutes every cycle)." }),
      err, h("div", { class: "dlg-actions" }, save));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; save.disabled = true;
      try {
        const r = await api(`api/agents/${encodeURIComponent(id)}/settings`, { name: name.value.trim(), skin: D.skin, approve_missions: D.approve,
          tools: D.allTools ? "all" : { deny: [...D.deny] }, notify_topic: topic.value.trim(), planner_host_ok: hostOk.checked });
        save.textContent = "SAVED ✓"; setTimeout(() => { save.textContent = "SAVE"; save.disabled = false; }, 1200);
        if (r && r.name) $("#set-h").textContent = `SETTINGS · ${String(r.name).toUpperCase()}`;
        this.say(`${name.value.trim().toUpperCase()}'s settings are saved.`); this.refresh();
      } catch (x) { err.textContent = x.message; save.disabled = false; }
    });
    const parts = [form];
    if (!s.primary && !a?.remote) {
      const rel = h("button", { class: "btn danger", type: "button" }, "RELEASE");
      const relErr = h("p", { class: "form-error", role: "alert" });
      rel.addEventListener("click", async () => {
        if (rel.dataset.sure !== "1") { rel.dataset.sure = "1"; rel.textContent = a?.bot ? "SURE? FORGETS ITS KEY" : "SURE? LOGS IT OUT FOR GOOD"; return; }
        rel.disabled = true; rel.textContent = "RELEASING…";
        try { await api(`api/agents/${encodeURIComponent(id)}/remove`, {}); $("#dlg-settings").close(); this.say(`${String(s.name || id).toUpperCase()} left the farm. Bye bye!`); this.loadMe(); this.refresh(); }
        catch (x) { relErr.textContent = x.message; rel.disabled = false; rel.textContent = "RELEASE"; }
      });
      parts.push(h("div", { class: "mgr-sec danger-zone" }, h("h3", { text: "RELEASE" }),
        h("p", { class: "muted small", text: "It leaves the farm: its login is removed and its sub-agents stop. You can hatch a new one after." }), relErr,
        h("div", { class: "dlg-actions" }, rel)));
    }
    fill($("#set-body"), parts);
  },

  // -------------------------------------------------------------------- menu
  /** Who you are here, sign in / out, and every page (on a phone some toolbar buttons live only here). */
  openMenu() {
    for (const d of $$("dialog[open]")) d.close();
    this.renderMenu();
    $("#dlg-menu").showModal();
  },
  renderMenu() {
    const R = role(), st = App.state, me = App.me || {}, mine = st?.agents.find(a => a.mine);
    const person = R.manager || !!R.owner;
    const who = R.manager ? `the farm's MANAGER (the person of ${String(mine?.name || R.owner).toUpperCase()})` : R.owner ? `the person of ${String(mine?.name || R.owner).toUpperCase()}` : me.viewer ? "a VIEWER (farm password)" : "a VISITOR: you watch";
    const err = h("p", { class: "form-error", role: "alert" });
    const out = async (path, msg) => {
      err.textContent = "";
      try { await api(path, {}); this.say(msg); const m = await this.loadMe(); if (!m?.can_view) return this.showTitle(); await this.refresh(); this.renderMenu(); }
      catch (x) { err.textContent = x.message; }
    };
    const tabs = [!R.owner ? "mine" : null].filter(Boolean);
    const forms = h("div", { class: "login inset" });
    const link = (text, act, key, href) => href ? h("a", { class: "menu-item", href }, text, h("kbd", { text: key }))
      : h("button", { class: "menu-item", type: "button", "data-act": act, onclick: () => $("#dlg-menu").close() }, text, h("kbd", { text: key }));
    fill($("#menu-body"),
      h("p", {}, "You're ", h("b", { text: who }), "."),
      h("div", { class: "dlg-actions left" },
        R.owner && mine ? h("button", { class: "btn", type: "button", onclick: () => { $("#dlg-menu").close(); this.focusMine(); } }, "★ SHOW MY CLAUDE") : null,
        me.viewer ? h("button", { class: "btn", type: "button", onclick: () => out("api/logout", "Logged out.") }, "LOG OUT") : null,
        R.owner ? h("button", { class: "btn danger", type: "button", onclick: () => out("api/owner/forget", "This device forgot your Claude. Sign in again with a code from it.") }, "FORGET MY CLAUDE ON THIS DEVICE") : null),
      err,
      tabs.length ? [h("h3", { text: "SIGN IN" }), forms] : null,
      h("h3", { text: "GO TO" }),
      h("nav", { class: "menu-list" },
        link("EVERY CLAUDE", "roster", "R"),
        (st?.me?.pending || st?.me?.pending_all) ? link("MISSIONS TO APPROVE", "approvals", "A") : null,
        st?.planner ? link("THE PLANNER", "planner", "P") : null,
        person ? link("TALK TO YOUR CLAUDE", "talk", "T") : null,
        link("TASKS AND SCHEDULES", null, "J", "tasks"),
        person ? link("DASHBOARDS", null, "D", "dashboards") : null,
        R.owner ? link("YOUR CLAUDE'S BROWSER", null, "B", "browser") : null,
        R.manager ? link("SLACK", "slack", "S") : null,
        R.manager ? link("RUN THE FARM", "manager", "G") : null,
        link("SEE THE WHOLE FARM", "fit", "0")),
      h("p", { class: "muted small", text: "Drag to look round the farm, scroll or pinch to zoom." }));
    if (tabs.length) this.accountForms(forms, { tabs, onDone: async (as) => {
      await this.loadMe(); await this.refresh();
      $("#dlg-menu").close();
      this.say(as === "manager" ? "You're the manager now: the gear button runs the farm." : as === "owner" ? "You're signed in to your Claude: it has the gold arrow." : "Welcome in!");
      if (as === "owner") this.focusMine();
    } });
  },
};

// ================================================================ landing demo
/** clod.farm's landing page runs the same farm on a scripted day: sub-agents grow crops, Claudes help each other, one naps,
 * a new one arrives. No server, no data: just the renderer. */
const Demo = {
  start() {
    Scene.layout = { clearOf: ".hero" }; // the title sits in the middle
    Scene.init();
    Scene.passive = true;
    this.t0 = nowS();
    this.tick();
    setInterval(() => this.tick(), 1500);
  },
  tick() {
    const T = nowS(), el = (T - this.t0) % 60, phase = el < 15 ? 0 : el < 30 ? 1 : el < 45 ? 2 : 3;
    const sub = (id, title, owner, on, status, extra = {}) => ({ id, title, owner, on: status === "running" ? on : null, status, started: T - 600, created: T - 700, ...extra });
    const subagents = [
      sub("s1", "Add CSV export to the report page", "matan", "matan", phase < 2 ? "running" : "done"),
      sub("s2", "Refactor the importer", "matan", "matan", "waiting", { children: ["c1", "c2", "c3"] }),
      sub("c1", "Parse the header row", "matan", "gil", phase < 1 ? "running" : "done", { parent: "s2" }),
      sub("c2", "Stream rows in batches", "matan", "gil", "running", { parent: "s2" }),
      sub("c3", "Tests for quoted commas", "matan", "matan", phase < 1 ? "queued" : "running", { parent: "s2" }),
      sub("s3", "Write the API docs", "gil", "gil", "running"),
      ...(phase >= 2 ? [sub("s4", "Dark mode for the dashboard", "noa", "noa", "running")] : []),
    ].filter(t => t.status !== "done");
    const claude = (id, hat, extra = {}) => ({ id, name: id, hat, loggedIn: true, alive: true, up: true, ...extra });
    const agents = [claude("matan", "straw", { primary: true }), claude("gil", "beanie")];
    if (phase >= 2) agents.push(claude("noa", "cap"));
    if (phase === 1) agents.push(claude("dana", "bow", { resting: true }));
    if (phase === 3) agents.push({ id: "egg", name: "new", hat: "straw", loggedIn: false, alive: true });
    const recent = [{ id: "d1", title: "Set up CI", status: "done" }, { id: "d2", title: "Fix flaky login test", status: "done" }];
    reconcile({ agents, subagents, recent, paused: false });
    Scene.boardCount = 3;
  },
};

const PAGE = document.body.dataset.page; // "diagram": scripts/architecture.html only borrows the sprites
if (PAGE === "landing") Demo.start(); else if (PAGE !== "diagram") UI.boot();
