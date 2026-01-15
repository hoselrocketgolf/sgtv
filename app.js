// SimGolf TV Guide - TV Guide style timeline + thumbnails
// Reads schedule.json produced by your GitHub Action / script.
//
// Expected fields per event:
//  - start_et "YYYY-MM-DD HH:MM" (Eastern)
//  - end_et "" or same format
//  - title, platform, channel, league, watch_url
//  - status: "live" | "upcoming"
//  - thumbnail_url (optional)
//  - subscribers (number, optional)

const SCHEDULE_URL = "schedule.json";

const $ = (id) => document.getElementById(id);

const leagueFilter = $("leagueFilter");
const platformFilter = $("platformFilter");
const searchInput = $("searchInput");
const refreshBtn = $("refreshBtn");

const nowOn = $("nowOn");
const upNext = $("upNext");
const lastUpdated = $("lastUpdated");

const timeRow = $("timeRow");
const rowsEl = $("rows");
const emptyState = $("emptyState");

const prevWindow = $("prevWindow");
const nextWindow = $("nextWindow");
const jumpNowBtn = $("jumpNow");
const windowLabel = $("windowLabel");

// --- Time helpers (treat input as Eastern local time) ---
function parseET(str) {
  // "YYYY-MM-DD HH:MM"
  // Treated as "ET-like local" for consistent ordering + display
  if (!str) return null;
  const [d, t] = str.split(" ");
  if (!d || !t) return null;
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  return new Date(Y, (M - 1), D, h, m, 0, 0);
}

function fmtTime(dt) {
  if (!dt) return "";
  const h = dt.getHours();
  const m = dt.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = ((h + 11) % 12) + 1;
  return `${hr}:${m} ${ampm} ET`;
}

function fmtDay(dt) {
  if (!dt) return "";
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${days[dt.getDay()]}, ${months[dt.getMonth()]} ${dt.getDate()}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// --- State ---
let allEvents = [];
let filteredEvents = [];
let windowStart = null; // Date

// Window settings
let windowMins = 240;   // 4 hours window
let tickMins = 30;      // 30 min ticks

// IMPORTANT: keep in sync with CSS tick width
let pxPerTick = 140;    // matches --tickW in CSS
let pxPerMin = pxPerTick / tickMins;

// ---- helpers ----
function eventEnd(e) {
  const end = parseET(e.end_et);
  if (end) return end;

  const start = parseET(e.start_et);
  if (!start) return null;

  // defaults
  const mins = e.status === "live" ? 110 : 70;
  return new Date(start.getTime() + mins * 60000);
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const aLive = a.status === "live" ? 0 : 1;
    const bLive = b.status === "live" ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;

    const at = parseET(a.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = parseET(b.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;

    const as = Number(a.subscribers || 0);
    const bs = Number(b.subscribers || 0);
    return bs - as;
  });
}

function rebuildFilters(events) {
  const leagues = new Set();
  const platforms = new Set();

  events.forEach(e => {
    if (e.league) leagues.add(e.league);
    if (e.platform) platforms.add(e.platform);
  });

  const keepLeague = leagueFilter.value;
  const keepPlat = platformFilter.value;

  leagueFilter.innerHTML =
    `<option value="all">All</option>` +
    [...leagues].sort().map(x => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");

  platformFilter.innerHTML =
    `<option value="all">All</option>` +
    [...platforms].sort().map(x => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");

  if ([...leagues].includes(keepLeague)) leagueFilter.value = keepLeague;
  if ([...platforms].includes(keepPlat)) platformFilter.value = keepPlat;
}

function applyFilters() {
  const l = leagueFilter.value;
  const p = platformFilter.value;
  const q = searchInput.value.trim().toLowerCase();

  filteredEvents = allEvents.filter(e => {
    if (l !== "all" && (e.league || "") !== l) return false;
    if (p !== "all" && (e.platform || "") !== p) return false;
    if (q) {
      const blob = `${e.title || ""} ${e.league || ""} ${e.platform || ""} ${e.channel || ""}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  filteredEvents = sortEvents(filteredEvents);

  renderNowNext();
  renderGuide();
}

// --- UI: Now + Next cards ---
function renderCard(e, showLiveBadge = false) {
  const start = parseET(e.start_et);
  const media = e.thumbnail_url ? `style="background-image:url('${encodeURI(e.thumbnail_url)}')"` : "";
  const badge = showLiveBadge || e.status === "live" ? `<span class="pill live">LIVE</span>` : "";
  const subs = e.subscribers ? `${Number(e.subscribers).toLocaleString()} subs` : "";

  return `
    <div class="card">
      <div class="cardMedia" ${media}></div>
      <div class="cardBody">
        <div class="cardTitle">${escapeHtml(e.title || "")}</div>
        <div class="cardMeta">
          <span>${fmtTime(start)}</span>
          <span>•</span>
          <span>${escapeHtml(e.platform || "")}</span>
          <span>•</span>
          <span>${escapeHtml(e.channel || "")}</span>
          ${subs ? `<span>•</span><span>${subs}</span>` : ""}
          ${badge ? `<span>•</span>${badge}` : ""}
        </div>
      </div>
      <div class="cardActions">
        <a class="watchBtn" href="${escapeHtml(e.watch_url || "#")}" target="_blank" rel="noreferrer">Watch</a>
      </div>
    </div>
  `;
}

function renderNowNext() {
  const live = filteredEvents.find(e => e.status === "live");
  const upcoming = filteredEvents.find(e => e.status !== "live");

  nowOn.innerHTML = live
    ? renderCard(live, true)
    : `<div class="muted">No live event right now.</div>`;

  upNext.innerHTML = upcoming
    ? renderCard(upcoming, false)
    : `<div class="muted">No upcoming events found.</div>`;
}

// --- TV Guide rendering ---
function roundToTick(dt) {
  const mins = dt.getMinutes();
  const rounded = Math.floor(mins / tickMins) * tickMins;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), rounded, 0, 0);
}

function ensureWindowStart() {
  if (windowStart) return;

  // anchor on: live start OR next upcoming OR now
  const live = filteredEvents.find(e => e.status === "live");
  const next = filteredEvents.find(e => e.status !== "live");

  let base = parseET(live?.start_et) || parseET(next?.start_et) || new Date();
  windowStart = roundToTick(base);
}

function jumpToNow() {
  windowStart = roundToTick(new Date());
  renderGuide();

  // Optional: nudges the rows scroller to top so user "feels" reset
  if (rowsEl) rowsEl.scrollTop = 0;
}

function shiftWindow(dir) {
  ensureWindowStart();
  windowStart = new Date(windowStart.getTime() + dir * windowMins * 60000);
  renderGuide();
}

function renderTimeRow() {
  ensureWindowStart();

  const ticks = Math.ceil(windowMins / tickMins) + 1;
  const parts = [];

  for (let i = 0; i < ticks; i++) {
    const dt = new Date(windowStart.getTime() + i * tickMins * 60000);
    parts.push(`<div class="timeTick" style="min-width:${pxPerTick}px">${fmtTime(dt).replace(" ET","")}</div>`);
  }

  timeRow.innerHTML = parts.join("");

  const end = new Date(windowStart.getTime() + windowMins * 60000);
  windowLabel.textContent = `${fmtDay(windowStart)} • ${fmtTime(windowStart)} → ${fmtTime(end)}`;
}

function groupByChannel(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.channel || "Unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }

  const rows = [...map.entries()].map(([channel, list]) => {
    const hasLive = list.some(x => x.status === "live");
    const maxSubs = Math.max(...list.map(x => Number(x.subscribers || 0)));
    return { channel, list: sortEvents(list), hasLive, maxSubs };
  });

  rows.sort((a, b) => {
    if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;
    if (a.maxSubs !== b.maxSubs) return b.maxSubs - a.maxSubs;
    return a.channel.localeCompare(b.channel);
  });

  return rows;
}

function renderGuide() {
  ensureWindowStart();
  renderTimeRow();

  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;

  // Only show events that intersect the window
  const windowEvents = filteredEvents.filter(e => {
    const s = parseET(e.start_et)?.getTime();
    if (!s) return false;
    const ee = eventEnd(e)?.getTime() ?? s;
    return ee >= startMs && s <= endMs;
  });

  if (!windowEvents.length) {
    rowsEl.innerHTML = "";
    emptyState.style.display = "";
    return;
  }
  emptyState.style.display = "none";

  const rows = groupByChannel(windowEvents);

  rowsEl.innerHTML = rows.map(r => {
    const subs = r.maxSubs ? `${Number(r.maxSubs).toLocaleString()} subs` : "";

    const blocks = r.list.map(e => {
      const s = parseET(e.start_et);
      const ee = eventEnd(e);
      if (!s || !ee) return "";

      const sMs = s.getTime();
      const eMs = ee.getTime();

      const leftMin = (sMs - startMs) / 60000;
      const rightMin = (eMs - startMs) / 60000;

      const left = clamp(leftMin * pxPerMin, -9999, 9999);
      const width = clamp((rightMin - leftMin) * pxPerMin, 120, 9999);

      const thumb = e.thumbnail_url || (e.source_id ? `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg` : "");
      const liveBadge = e.status === "live" ? `<span class="badgeLive">LIVE</span>` : "";

      const startLabel = fmtTime(s).replace(" ET", "");
      const endLabel = fmtTime(ee).replace(" ET", "");

      return `
        <a class="block" href="${escapeHtml(e.watch_url || "#")}" target="_blank" rel="noreferrer"
           style="left:${left}px; width:${width}px;">
          <div class="blockMedia" style="background-image:url('${encodeURI(thumb)}')"></div>
          <div class="blockOverlay"></div>
          <div class="blockContent">
            <div class="blockTop">
              <div class="blockTitle">${escapeHtml(e.title || "")}</div>
              ${liveBadge}
            </div>
            <div class="blockBottom">
              <div class="blockTime">${startLabel}–${endLabel}</div>
              <div>${escapeHtml(e.platform || "")}</div>
            </div>
          </div>
        </a>
      `;
    }).join("");

    return `
      <div class="row">
        <div class="rowLabel">
          <div class="name">${escapeHtml(r.channel)}</div>
          <div class="subs">${subs}</div>
        </div>
        <div class="lane" style="background-size:${pxPerTick}px 1px;">
          ${blocks}
        </div>
      </div>
    `;
  }).join("");
}

// --- Fetch schedule.json ---
async function loadSchedule() {
  nowOn.textContent = "Loading…";
  upNext.textContent = "Loading…";
  rowsEl.innerHTML = "";
  emptyState.style.display = "none";

  const bust = `${SCHEDULE_URL}?v=${Date.now()}`;
  const res = await fetch(bust, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch schedule.json (${res.status})`);

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("schedule.json is not an array");

  allEvents = sortEvents(
    data
      .filter(e => e && e.start_et && e.watch_url)
      .map(e => ({
        ...e,
        status: e.status || "upcoming",
        league: e.league || "",
        platform: e.platform || "",
        channel: e.channel || "",
        thumbnail_url: e.thumbnail_url || "",
        subscribers: Number(e.subscribers || 0),
      }))
  );

  rebuildFilters(allEvents);

  // reset window so it follows live/next again
  windowStart = null;

  const now = new Date();
  lastUpdated.textContent = `Last updated: ${fmtDay(now)} ${fmtTime(now)}`;

  applyFilters();
}

// --- Wire up ---
leagueFilter.addEventListener("change", applyFilters);
platformFilter.addEventListener("change", applyFilters);
searchInput.addEventListener("input", applyFilters);

refreshBtn.addEventListener("click", () => loadSchedule().catch(err => {
  console.error(err);
  nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
}));

prevWindow.addEventListener("click", () => shiftWindow(-1));
nextWindow.addEventListener("click", () => shiftWindow(1));
jumpNowBtn.addEventListener("click", jumpToNow);

// initial
loadSchedule().catch(err => {
  console.error(err);
  nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
});
