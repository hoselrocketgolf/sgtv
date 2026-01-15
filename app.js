/* app.js — FULL REPLACEMENT (self-contained layout + styles)
   Goal: stop the UI from getting "jacked up" by relying on unknown existing CSS.
   This file injects its own styles and renders into #app (or body fallback).
*/

const DATA_URL = "./schedule.json";

// ----------------- Time helpers (ET) -----------------
function etNow() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => means(parts, t) || "";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const hh = get("hour");
  const mm = get("minute");
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:00`);
}
function means(parts, t) {
  const p = parts.find((x) => x.type === t);
  return p ? p.value : "";
}
function parseEtString(etStr) {
  if (!etStr) return null;
  const s = String(etStr).trim().replace(" ", "T");
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}
function formatTimeEt(d) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}
function formatDayEt(d) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}
function clampToHalfHour(d) {
  const dd = new Date(d);
  dd.setSeconds(0, 0);
  dd.setMinutes(dd.getMinutes() < 30 ? 0 : 30);
  return dd;
}
function addMinutes(d, mins) {
  const dd = new Date(d);
  dd.setMinutes(dd.getMinutes() + mins);
  return dd;
}
function sameEtDate(a, b) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(a) === fmt.format(b);
}

// ----------------- Data normalization -----------------
function normalizeEvent(e) {
  const status = String(e.status || "").toLowerCase();
  const start = parseEtString(e.start_et) || etNow();
  const end = parseEtString(e.end_et) || addMinutes(start, 120);

  const subs = Number(e.subscribers || 0) || 0;

  let thumb = e.thumbnail_url || "";
  if (!thumb && e.source_id) thumb = `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg`;

  return {
    ...e,
    status,
    start_dt: start,
    end_dt: end,
    subscribers: subs,
    title: e.title || "",
    channel: e.channel || "",
    platform: e.platform || "",
    league: e.league || "",
    watch_url: e.watch_url || "",
    source_id: e.source_id || "",
    thumbnail_url: thumb,
  };
}
function sortEvents(events) {
  return [...events].sort((a, b) => {
    const ar = a.status === "live" ? 0 : 1;
    const br = b.status === "live" ? 0 : 1;
    if (ar !== br) return ar - br;
    const at = a.start_dt.getTime();
    const bt = b.start_dt.getTime();
    if (at !== bt) return at - bt;
    return (b.subscribers || 0) - (a.subscribers || 0);
  });
}

// ----------------- DOM helpers -----------------
function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of kids) {
    if (c == null) continue;
    if (typeof c === "string") n.appendChild(document.createTextNode(c));
    else n.appendChild(c);
  }
  return n;
}
function btn(text, onClick, extra = "") {
  return el("button", { class: `sgtv-btn ${extra}`, onClick }, [text]);
}
function pill(text, kind) {
  return el("span", { class: `sgtv-pill ${kind || ""}` }, [text]);
}
function linkBtn(text, href) {
  return el("a", { class: "sgtv-btn sgtv-btn-primary", href: href || "#", target: "_blank", rel: "noopener" }, [text]);
}

// ----------------- Styles (self-contained) -----------------
function injectStyles() {
  if (document.getElementById("sgtv-styles")) return;
  const css = `
:root{
  --sgtv-bg0:#05070c;
  --sgtv-bg1:#0b1020;
  --sgtv-card:rgba(255,255,255,.06);
  --sgtv-card2:rgba(255,255,255,.08);
  --sgtv-border:rgba(255,255,255,.10);
  --sgtv-text:rgba(255,255,255,.92);
  --sgtv-dim:rgba(255,255,255,.68);
  --sgtv-dimmer:rgba(255,255,255,.55);
  --sgtv-accent1:#59c2ff;
  --sgtv-accent2:#b36bff;
  --sgtv-live:#15f2b1;
  --sgtv-radius:18px;
  --sgtv-shadow: 0 10px 30px rgba(0,0,0,.35);
  --sgtv-gap:14px;
  --sgtv-font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
}
body{
  margin:0;
  background: radial-gradient(1100px 700px at 15% 10%, rgba(89,194,255,.18), transparent 55%),
              radial-gradient(900px 650px at 88% 22%, rgba(179,107,255,.18), transparent 55%),
              linear-gradient(180deg, var(--sgtv-bg1), var(--sgtv-bg0));
  color:var(--sgtv-text);
  font-family:var(--sgtv-font);
}
#app{ min-height:100vh; }
.sgtv-wrap{ max-width:1120px; margin:0 auto; padding:22px 16px 60px; }
.sgtv-header{ display:flex; align-items:center; gap:12px; margin-bottom:16px; }
.sgtv-badge{
  width:44px; height:44px; border-radius:14px;
  background: linear-gradient(135deg, var(--sgtv-accent1), var(--sgtv-accent2));
  display:flex; align-items:center; justify-content:center;
  font-weight:800;
  box-shadow: var(--sgtv-shadow);
}
.sgtv-title{ font-size:22px; font-weight:800; line-height:1.1; }
.sgtv-sub{ font-size:13px; color:var(--sgtv-dim); margin-top:2px; }

.sgtv-controls{
  display:grid;
  grid-template-columns: 160px 160px 1fr 120px;
  gap:12px;
  align-items:end;
  margin: 14px 0 18px;
}
.sgtv-field{ display:flex; flex-direction:column; gap:6px; }
.sgtv-label{ font-size:12px; color:var(--sgtv-dim); }
.sgtv-input, .sgtv-select{
  height:40px;
  border-radius:12px;
  border:1px solid var(--sgtv-border);
  background: rgba(255,255,255,.04);
  color:var(--sgtv-text);
  padding: 0 12px;
  outline:none;
}
.sgtv-input::placeholder{ color: rgba(255,255,255,.40); }
.sgtv-btn{
  height:40px;
  border-radius:12px;
  border:1px solid var(--sgtv-border);
  background: rgba(255,255,255,.06);
  color:var(--sgtv-text);
  cursor:pointer;
  padding: 0 12px;
}
.sgtv-btn:hover{ background: rgba(255,255,255,.10); }
.sgtv-btn-primary{
  border:none;
  background: linear-gradient(135deg, var(--sgtv-accent1), var(--sgtv-accent2));
  font-weight:700;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  text-decoration:none;
}
.sgtv-btn-primary:hover{ filter: brightness(1.05); }

.sgtv-hero{
  display:grid;
  grid-template-columns: 1fr 1fr 1.2fr;
  gap: var(--sgtv-gap);
  margin-bottom: 16px;
}
.sgtv-tile{
  border-radius: var(--sgtv-radius);
  border:1px solid var(--sgtv-border);
  background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.04));
  box-shadow: var(--sgtv-shadow);
  padding: 14px;
  overflow:hidden;
}
.sgtv-tile-h{
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:10px;
}
.sgtv-tile-h .h{ font-weight:800; font-size:16px; }
.sgtv-pill{
  font-size:12px;
  padding: 6px 10px;
  border-radius: 999px;
  border:1px solid var(--sgtv-border);
  background: rgba(255,255,255,.06);
  color: var(--sgtv-dim);
}
.sgtv-pill.live{
  border-color: rgba(21,242,177,.35);
  background: rgba(21,242,177,.12);
  color: rgba(21,242,177,.95);
  font-weight:800;
}
.sgtv-pill.upcoming{
  border-color: rgba(89,194,255,.35);
  background: rgba(89,194,255,.12);
  color: rgba(89,194,255,.95);
  font-weight:800;
}
.sgtv-empty{
  border-radius: 14px;
  border:1px dashed rgba(255,255,255,.16);
  padding: 14px;
  color: var(--sgtv-dim);
  background: rgba(0,0,0,.12);
}

.sgtv-card{
  display:grid;
  grid-template-columns: 140px 1fr;
  gap: 12px;
  padding: 10px;
  border-radius: 16px;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(0,0,0,.16);
}
.sgtv-thumb{
  width:140px; height:78px;
  border-radius: 14px;
  object-fit: cover;
  background: rgba(255,255,255,.08);
}
.sgtv-ctitle{ font-weight:800; font-size:14px; line-height:1.25; margin-bottom:6px; }
.sgtv-ctime{ font-size:13px; color: var(--sgtv-dim); margin-bottom:4px; }
.sgtv-cmeta{ font-size:12px; color: var(--sgtv-dimmer); margin-bottom:10px; }
.sgtv-row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.sgtv-subs{ font-size:12px; color: var(--sgtv-dimmer); }

.sgtv-tvtitle{ display:flex; justify-content:space-between; gap:10px; align-items:flex-end; }
.sgtv-tvtitle .h{ font-weight:900; font-size:16px; }
.sgtv-tvtitle .sub{ font-size:12px; color: var(--sgtv-dim); margin-top:2px; }
.sgtv-tvnav{ display:flex; gap:10px; align-items:center; margin-top:10px; }
.sgtv-tvslots{
  display:flex;
  gap:8px;
  overflow:auto;
  padding-bottom:6px;
  flex:1;
}
.sgtv-tvslot{
  white-space:nowrap;
  padding: 10px 12px;
  border-radius: 999px;
  border:1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.05);
  color: var(--sgtv-text);
  cursor:pointer;
  font-size:13px;
}
.sgtv-tvslot:hover{ background: rgba(255,255,255,.10); }
.sgtv-tvslot.active{
  background: rgba(89,194,255,.16);
  border-color: rgba(89,194,255,.40);
}
.sgtv-tvslot.now{
  box-shadow: 0 0 0 2px rgba(21,242,177,.16) inset;
}
.sgtv-tvlist{ display:flex; flex-direction:column; gap:10px; margin-top:10px; max-height: 360px; overflow:auto; }

.sgtv-section{ margin-top: 18px; }
.sgtv-sechead{
  display:flex; justify-content:space-between; align-items:flex-end;
  margin: 6px 2px 10px;
}
.sgtv-sechead .h{ font-weight:900; font-size:16px; }
.sgtv-sechead .sub{ font-size:12px; color: var(--sgtv-dim); }

.sgtv-grid{
  display:grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sgtv-gap);
}

@media (max-width: 1000px){
  .sgtv-hero{ grid-template-columns: 1fr; }
  .sgtv-controls{ grid-template-columns: 1fr 1fr; }
  .sgtv-grid{ grid-template-columns: 1fr; }
  .sgtv-card{ grid-template-columns: 120px 1fr; }
  .sgtv-thumb{ width:120px; height:68px; }
}
`;
  const style = document.createElement("style");
  style.id = "sgtv-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

// ----------------- Fetch -----------------
async function fetchEvents() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load schedule.json (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(normalizeEvent);
}

// ----------------- Cards -----------------
function eventCard(e, compact = false) {
  const top = `${formatDayEt(e.start_dt)} • ${e.platform}${e.channel ? " • " + e.channel : ""}`;
  const time = `${formatTimeEt(e.start_dt)} ET`;

  const statusPill =
    e.status === "live" ? pill("LIVE", "live") :
    e.status === "upcoming" ? pill("UPCOMING", "upcoming") :
    null;

  return el("div", { class: "sgtv-card" }, [
    el("img", { class: "sgtv-thumb", src: e.thumbnail_url || "", alt: e.title || "", loading: "lazy" }),
    el("div", {}, [
      el("div", { class: "sgtv-row", style: "justify-content:space-between; align-items:flex-start;" }, [
        el("div", { class: "sgtv-ctitle" }, [e.title || "Untitled"]),
        statusPill,
      ]),
      el("div", { class: "sgtv-ctime" }, [time]),
      el("div", { class: "sgtv-cmeta" }, [top]),
      el("div", { class: "sgtv-row" }, [
        (e.subscribers && e.subscribers > 0) ? el("div", { class: "sgtv-subs" }, [`${e.subscribers.toLocaleString()} subs`]) : null,
        linkBtn("Watch", e.watch_url || "#"),
      ]),
    ])
  ]);
}

function empty(text) {
  return el("div", { class: "sgtv-empty" }, [text]);
}

// ----------------- TV Guide scroller -----------------
function buildTvScroller(events, state) {
  const slotMinutes = 30;
  const numSlots = 7;

  const now = etNow();
  const stripStart = addMinutes(state.slotStart, -60); // show 1h earlier
  const slotEnd = addMinutes(state.slotStart, slotMinutes);

  const title = el("div", { class: "sgtv-tvtitle" }, [
    el("div", {}, [
      el("div", { class: "h" }, ["Today's Schedule"]),
      el("div", { class: "sub" }, [`${formatDayEt(state.today)} • ${formatTimeEt(state.slotStart)}–${formatTimeEt(slotEnd)} ET`]),
    ]),
    el("div", { class: "sub" }, ["TV Guide mode"]),
  ]);

  const left = btn("←", () => { state.slotStart = addMinutes(state.slotStart, -slotMinutes); render(state); });
  const right = btn("→", () => { state.slotStart = addMinutes(state.slotStart, slotMinutes); render(state); });

  const slotsWrap = el("div", { class: "sgtv-tvslots" }, []);
  for (let i = 0; i < numSlots; i++) {
    const t = addMinutes(stripStart, i * slotMinutes);
    const isActive = t.getTime() === state.slotStart.getTime();
    const isNow = now.getTime() >= t.getTime() && now.getTime() < addMinutes(t, slotMinutes).getTime() && sameEtDate(now, t);

    const slotBtn = el("button", {
      class: `sgtv-tvslot ${isActive ? "active" : ""} ${isNow ? "now" : ""}`,
      onClick: () => { state.slotStart = t; render(state); }
    }, [formatTimeEt(t)]);
    slotsWrap.appendChild(slotBtn);
  }

  const nav = el("div", { class: "sgtv-tvnav" }, [left, slotsWrap, right]);

  const inSlot = (e) => {
    if (!sameEtDate(e.start_dt, state.today)) return false;
    if (e.status === "live") return true;
    // overlap slot window
    return e.start_dt.getTime() < slotEnd.getTime() && e.end_dt.getTime() > state.slotStart.getTime();
  };

  const list = sortEvents(events.filter(inSlot));

  const listWrap = el("div", { class: "sgtv-tvlist" }, []);
  if (!list.length) listWrap.appendChild(empty("No streams in this time slot."));
  else list.forEach((e) => listWrap.appendChild(eventCard(e, true)));

  return el("div", {}, [title, nav, listWrap]);
}

// ----------------- Filters + selection -----------------
function filterEvents(events, state) {
  let out = events;

  if (state.filters.platform !== "All") {
    out = out.filter((e) => (e.platform || "") === state.filters.platform);
  }
  if (state.filters.league !== "All") {
    out = out.filter((e) => (e.league || "") === state.filters.league);
  }
  const q = (state.filters.search || "").trim().toLowerCase();
  if (q) {
    out = out.filter((e) =>
      (e.title || "").toLowerCase().includes(q) ||
      (e.channel || "").toLowerCase().includes(q) ||
      (e.league || "").toLowerCase().includes(q) ||
      (e.platform || "").toLowerCase().includes(q)
    );
  }
  return out;
}

function pickNowOn(events) {
  const live = events.find((e) => e.status === "live");
  return live || null;
}
function pickUpNext(events) {
  const now = etNow();
  const upcoming = events
    .filter((e) => e.status === "upcoming")
    .sort((a, b) => a.start_dt - b.start_dt);
  return upcoming.find((e) => e.start_dt.getTime() >= now.getTime()) || upcoming[0] || null;
}

// ----------------- Render -----------------
async function doRefresh(state) {
  state.loading = true;
  state.error = "";
  render(state);

  try {
    state.rawEvents = await fetchEvents();
    state.lastUpdated = new Date();
  } catch (e) {
    state.error = e?.message || String(e);
  } finally {
    state.loading = false;
    render(state);
  }
}

function render(state) {
  injectStyles();

  const root = document.getElementById("app") || document.body;
  root.innerHTML = "";

  const wrap = el("div", { class: "sgtv-wrap" }, []);

  // Header
  wrap.appendChild(
    el("div", { class: "sgtv-header" }, [
      el("div", { class: "sgtv-badge" }, ["SG"]),
      el("div", {}, [
        el("div", { class: "sgtv-title" }, ["SimGolf TV Guide"]),
        el("div", { class: "sgtv-sub" }, ["LIVE 24/7 • matches, leagues, and streams • Times in Eastern"]),
      ]),
    ])
  );

  // Controls
  const platforms = ["All", ...Array.from(new Set((state.rawEvents || []).map((e) => e.platform).filter(Boolean))).sort()];
  const leagues = ["All", ...Array.from(new Set((state.rawEvents || []).map((e) => e.league).filter(Boolean))).sort()];

  const leagueSel = el("select", {
    class: "sgtv-select",
    onChange: (ev) => { state.filters.league = ev.target.value; render(state); }
  }, leagues.map((v) => el("option", { value: v, selected: v === state.filters.league ? "selected" : null }, [v])));

  const platSel = el("select", {
    class: "sgtv-select",
    onChange: (ev) => { state.filters.platform = ev.target.value; render(state); }
  }, platforms.map((v) => el("option", { value: v, selected: v === state.filters.platform ? "selected" : null }, [v])));

  const search = el("input", {
    class: "sgtv-input",
    type: "text",
    placeholder: "Search title, league, channel…",
    value: state.filters.search,
    onInput: (ev) => { state.filters.search = ev.target.value; render(state); }
  });

  const updateBtn = btn("Update", () => doRefresh(state), "sgtv-btn-primary");

  wrap.appendChild(
    el("div", { class: "sgtv-controls" }, [
      el("div", { class: "sgtv-field" }, [el("div", { class: "sgtv-label" }, ["League"]), leagueSel]),
      el("div", { class: "sgtv-field" }, [el("div", { class: "sgtv-label" }, ["Platform"]), platSel]),
      el("div", { class: "sgtv-field" }, [el("div", { class: "sgtv-label" }, ["Search"]), search]),
      el("div", { class: "sgtv-field" }, [el("div", { class: "sgtv-label" }, ["Refresh"]), updateBtn]),
    ])
  );

  if (state.error) {
    wrap.appendChild(el("div", { class: "sgtv-empty" }, [state.error]));
  }

  if (state.loading) {
    wrap.appendChild(empty("Loading…"));
    root.appendChild(wrap);
    return;
  }

  const filtered = filterEvents(state.rawEvents || [], state);

  // Hero tiles
  const nowOn = pickNowOn(filtered);
  const upNext = pickUpNext(filtered);

  const tileNow = el("div", { class: "sgtv-tile" }, [
    el("div", { class: "sgtv-tile-h" }, [el("div", { class: "h" }, ["Now On"]), pill("LIVE", "live")]),
    nowOn ? eventCard(nowOn) : empty("No live event right now."),
  ]);

  const tileNext = el("div", { class: "sgtv-tile" }, [
    el("div", { class: "sgtv-tile-h" }, [el("div", { class: "h" }, ["Up Next"])]),
    upNext ? eventCard(upNext) : empty("No upcoming events found."),
  ]);

  const tileTV = el("div", { class: "sgtv-tile" }, [
    buildTvScroller(filtered, state)
  ]);

  wrap.appendChild(el("div", { class: "sgtv-hero" }, [tileNow, tileNext, tileTV]));

  // Today's grid (below)
  const today = state.today;
  const todays = sortEvents(filtered.filter((e) => sameEtDate(e.start_dt, today)));

  const updatedText = state.lastUpdated
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(state.lastUpdated) + " ET"
    : "";

  wrap.appendChild(
    el("div", { class: "sgtv-section" }, [
      el("div", { class: "sgtv-sechead" }, [
        el("div", { class: "h" }, ["Today"]),
        el("div", { class: "sub" }, [updatedText ? `Last updated: ${updatedText}` : ""]),
      ]),
      el("div", { class: "sgtv-grid" }, [
        ...(todays.length ? todays.map((e) => el("div", { class: "sgtv-tile" }, [eventCard(e)])) : [el("div", { class: "sgtv-tile" }, [empty("No events today.")])])
      ])
    ])
  );

  root.appendChild(wrap);
}

// ----------------- Boot -----------------
(async function boot() {
  const state = {
    rawEvents: [],
    loading: true,
    error: "",
    lastUpdated: null,
    filters: { league: "All", platform: "All", search: "" },
    today: etNow(),
    slotStart: clampToHalfHour(etNow()),
  };

  render(state);
  await doRefresh(state);

  // Keep the "now" highlighting fresh without re-fetching
  setInterval(() => {
    // only update "today" and re-render; don't reset the chosen slot
    state.today = etNow();
    render(state);
  }, 60_000);
})();
