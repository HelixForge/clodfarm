/* The farm's browser: its screen over the farm's own WebSocket (/api/browser/screen, behind the farm password),
 * drawn by noVNC. START and STOP turn it on and off for everyone on the farm; it stays on until stopped.
 * Paste goes through the page's paste event (no clipboard permission needed) and what you copy there comes back
 * to your clipboard. On a Mac, ⌘ shortcuts (⌘A, ⌘C, ⌘L, ...) become Ctrl in the farm's Linux Chromium. */
import RFB from "./browser/novnc/core/rfb.js";

const BASE = document.body.dataset.base || "";
const $ = s => document.querySelector(s);
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const XK_CONTROL = 0xffe3;
const CMD_KEYS = new Set(["a", "c", "x", "z", "y", "f", "l", "r"]); // ⌘ + these → Ctrl + these in the farm's browser
let rfb = null, st = null, busy = false, retry = null;

async function api(path, body) {
  const opts = { credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) Object.assign(opts, { method: "POST", body: JSON.stringify(body),
    headers: { ...opts.headers, "Content-Type": "application/json", "X-Clodfarm": "1" } });
  const r = await fetch(`${BASE}/api/${path}`, opts);
  if (r.status === 401) {
    location.replace(`${BASE}/?next=browser`);
    throw new Error("log in first");
  }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || r.statusText);
  return out;
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 1800);
}

function message(text) {
  $("#screen-msg").textContent = text || "";
  $("#screen-msg").hidden = !text;
}

// ---------------------------------------------------------------- the screen
function connect() {
  if (rfb) return;
  message("CONNECTING…");
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BASE}/api/browser/screen`;
  rfb = new RFB($("#screen"), url, { shared: true, wsProtocols: ["binary"] });
  rfb.scaleViewport = true;   // the whole window fits the frame
  rfb.resizeSession = false;  // the screen keeps its size: the Claudes see the same page you do
  rfb.focusOnClick = true;
  rfb.background = "#1b1f2a";
  rfb.addEventListener("connect", () => { message(""); rfb.focus(); });
  rfb.addEventListener("disconnect", () => {
    rfb = null;
    if (st && st.on) { message("RECONNECTING…"); clearTimeout(retry); retry = setTimeout(refresh, 1500); }
  });
  rfb.addEventListener("clipboard", e => { // copied in the farm's browser: onto your clipboard
    const text = e.detail.text || "";
    if (text && navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast("COPIED"), () => {});
  });
}

function disconnect() {
  clearTimeout(retry);
  if (rfb) { const r = rfb; rfb = null; r.disconnect(); }
}

function ctrl(key) { // Ctrl + a letter in the farm's browser
  const ks = key.toLowerCase().charCodeAt(0);
  rfb.sendKey(XK_CONTROL, "ControlLeft", true);
  rfb.sendKey(ks, "Key" + key.toUpperCase(), true);
  rfb.sendKey(ks, "Key" + key.toUpperCase(), false);
  rfb.sendKey(XK_CONTROL, "ControlLeft", false);
}

// Before noVNC sees the key (capture phase): ⌘/Ctrl+V is left to the page, so a paste event brings your clipboard;
// on a Mac, ⌘ + a few letters becomes Ctrl, the way the farm's Linux Chromium expects.
$("#screen").addEventListener("keydown", e => {
  if (!rfb) return;
  const k = (e.key || "").toLowerCase(), mod = MAC ? e.metaKey : e.ctrlKey;
  if (mod && k === "v" && !e.altKey) { e.stopPropagation(); return; }
  if (MAC && e.metaKey && !e.ctrlKey && !e.altKey && CMD_KEYS.has(k)) {
    e.preventDefault(); e.stopPropagation();
    ctrl(k);
  }
}, true);
$("#screen").addEventListener("keyup", e => {
  if (rfb && (MAC ? e.metaKey : e.ctrlKey) && (e.key || "").toLowerCase() === "v") e.stopPropagation();
}, true);
document.addEventListener("paste", e => {
  if (!rfb || !$("#screen").contains(document.activeElement)) return;
  const text = e.clipboardData && e.clipboardData.getData("text/plain");
  if (!text) return;
  e.preventDefault();
  rfb.clipboardPasteFrom(text);
  setTimeout(() => rfb && ctrl("v"), 60); // the text is on the farm's clipboard first, then Ctrl+V pastes it
});

// ------------------------------------------------------------------ state
function render() {
  const avail = st && st.available, on = st && st.on, ready = st && st.ready;
  const chip = $("#state");
  chip.className = "chip " + (ready ? "" : on ? "wait" : "off");
  $("#state-text").textContent = !st ? "…" : !avail ? "NOT IN THIS IMAGE" : ready ? `ON · ${st.size}` : on ? "STARTING…" : "OFF";
  const power = $("#power");
  power.hidden = !avail || !on;
  power.textContent = "■ STOP";
  power.title = "Stop the browser for the whole farm (your logins are kept)";
  $("#off").hidden = on && avail;
  $("#on").hidden = !(on && avail);
  $("#start").hidden = !avail;
  if (st && !avail) {
    $("#off-h").textContent = "NO BROWSER IN THIS IMAGE";
    $("#off-text").textContent = `This farm's image doesn't have the browser (missing: ${st.missing.join(", ")}). ` +
      "The clodfarm image has it unless it was built with BROWSER=0.";
  }
  $("#off-error").textContent = st && st.error && !on ? st.error : "";
  if (on && avail) {
    if (ready) connect();
    else if (!rfb) message(st.error ? `NOT STARTED: ${st.error}` : "STARTING THE BROWSER…");
    renderTabs(st.tabs || []);
  } else disconnect();
}

function renderTabs(tabs) {
  const list = $("#tabs");
  const key = JSON.stringify(tabs.map(t => [t.title, t.url]));
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(...(tabs.length ? tabs : [{ title: "No tabs open", url: "" }]).map(t => {
    const li = document.createElement("li"), b = document.createElement("b"), s = document.createElement("span");
    b.textContent = t.title || "(untitled)"; s.textContent = t.url;
    li.append(b, s);
    return li;
  }));
}

async function refresh() {
  try { st = await api("browser"); render(); }
  catch (e) { $("#state-text").textContent = "FARM UNREACHABLE"; }
}

async function power(on) {
  if (busy) return;
  busy = true;
  $("#start").disabled = $("#power").disabled = true;
  try { st = await api(`browser/${on ? "start" : "stop"}`, {}); render(); }
  catch (e) { $("#off-error").textContent = e.message; }
  finally { busy = false; $("#start").disabled = $("#power").disabled = false; }
}

$("#start").addEventListener("click", () => power(true));
$("#power").addEventListener("click", () => power(false));
$("#go").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#url").value.trim();
  if (!url) return;
  try { await api("browser/open", { url }); $("#url").value = ""; toast("OPENED"); refresh(); if (rfb) rfb.focus(); }
  catch (err) { toast(err.message.toUpperCase().slice(0, 60)); }
});

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
