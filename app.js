// SimGolf.TV Guide - app.js (ET-correct + stable + no schedule scrollbars)
const SCHEDULE_URL = "schedule.json";

const $ = (id) => document.getElementById(id);
const on = (el, evt, fn) => { if (el) el.addEventListener(evt, fn); };

// Controls
const leagueFilter = $("leagueFilter");
const platformFilter = $("platformFilter");
const searchInput = $("searchInput");
const refreshBtn = $("refreshBtn");

// Hero tiles
const nowOn = $("nowOn");
const upNext = $("upNext");
const lastUpdated = $("lastUpdated");

// Right tile (Today’s Guide)
const infoTileBody = document.querySelector("#infoTile .tileBody");
const infoTileHeaderH2 = document.querySelector("#infoTile .tileHeader h2");

// Bottom schedule elements
const timeRow = $("timeRow");
const rowsEl = $("rows");
const emptyState = $("emptyState");

const prevWindow = $("prevWindow");
const nextWindow = $("nextWindow");
const jumpNowBtn = $("jumpNow");
const windowLabel = $("windowLabel");

// ==================== TIME (ET-CORRECT) ====================
const ET_TZ = "America/New_York";

function pad2(n) { return String(n).padStart(2, "0"); }

/**
 * Get timezone offset minutes for a given instant in a specific IANA timezone.
 * Positive means tz is ahead of UTC, negative means behind UTC.
 */
function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

/**
 * Convert an ET wall-clock time (Y,M,D,h,m) into a real Date instant.
 * Handles DST correctly.
 */
function etWallToInstant(Y, M, D, h, m) {
  const guessUTC = Date.UTC(Y, M - 1, D, h, m, 0);
  const offset = tzOffsetMinutes(new Date(guessUTC), ET_TZ);
  return new Date(guessUTC - offset * 60000);
}

/**
 * Parse "YYYY-MM-DD HH:MM" which is ET wall time, into a real instant.
 */
function parseET(str) {
  if (!str) return null;
  const [d, t] = str.split(" ");
  if (!d || !t) return null;
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  if (![Y, M, D, h, m].every(Number.isFinite)) return null;
  return etWallToInstant(Y, M, D, h, m);
}

/**
 * Get ET calendar parts from an instant.
 */
function etParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    Y: Number(map.year),
    M: Number(map.month),
    D: Number(map.day),
    h: Number(map.hour),
    m: Number(map.minute),
  };
}

/**
 * Start/end of ET day for a given instant.
 */
function startOfEtDay(date) {
  const p = etParts(date);
  return etWallToInstant(p.Y, p.M, p.D, 0, 0);
}
function endOfEtDay(date) {
  const p = etParts(date);
  // 23:59 ET as an instant (good enough for filtering)
  return etWallToInstant(p.Y, p.M, p.D, 23, 59);
}

function fmtTimeEt(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date) + " ET";
}

function fmtDayEt(date) {
  if (!date) return "";
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  return dtf.format(date);
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ==================== STATE ====================
let allEvents = [];
let filteredEvents = [];
let windowStart = null;

// Window config
let windowMins = 240;   // 4h
let tickMins = 30;      // label every 30m
let pxPerTick = 140;
let pxPerMin = pxPerTick / tickMins;

// ==================== CSS INJECT: kill scrollbars + better blocks ====================
(function injectNoScrollCss() {
  const css = `
    /* No native horizontal scrollbars inside schedule */
    #timeRow, #rows, .row { overflow: hidden !important; }

    .lane{
      position: relative !important;
      overflow: hidden !important;
      min-height: 76px;
      border-left: 1px solid rgba(255,255,255,0.06);
    }

    .timeTick{
      font-weight:800;
      font-size:12px;
      color: rgba(255,255,255,0.78);
      padding: 12px 14px;
      border-right: 1px solid rgba(255,255,255,0.06);
      white-space: nowrap;
    }

    /* Full thumbnail block (not squished) */
    .block{
      position:absolute;
      top: 10px;
      bottom: 10px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.10);
      background: rgba(0,0,0,0.20);
      overflow:hidden;
      text-decoration:none !important;
    }
    .block:hover{ filter: brightness(1.06); }

    .blockMedia{
      position:absolute;
      inset:0;
      background-size: cover;
      background-position: center;
      transform: scale(1.01);
    }
    .blockOverlay{
      position:absolute;
      inset:0;
      background: linear-gradient(180deg, rgba(0,0,0,0.10), rgba(0,0,0,0.55));
    }
    .blockContent{
      position:absolute;
      inset:0;
      display:flex;
      flex-direction:column;
      justify-content:space-between;
      padding: 10px 12px;
      gap: 10px;
      min-width:0;
    }
    .blockTop{ display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
    .blockTitle{
      font-weight: 900;
      font-size: 12px;
      line-height: 1.15;
      color: rgba(255,255,255,0.94);
      max-height: 2.4em;
      overflow:hidden;
      text-overflow: ellipsis;
    }
    .blockBottom{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      color: rgba(255,255,255,0.70);
      font-size: 11px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow: ellipsis;
    }
    .badgeLive{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid rgba(70,240,170,0.34);
      background: rgba(50,240,160,0.12);
      color: rgba(70,240,170,0.95);
      font-size: 11px;
      font-weight: 800;
      white-space:nowrap;
      flex: 0 0 auto;
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

// ==================== EVENT END ====================
// Default: 2h from start
// LIVE: extend to max(start+2h, now+20m) so it stays visible while live
function eventEnd(e) {
  const end = parseET(e.end_et);
  if (end) return end;

  const start = parseET(e.start_et);
  if (!start) return null;

  const defaultEnd = new Date(start.getTime() + 120 * 60000);

  if (e.status === "live") {
    const now = new Date();
    const liveHold = new Date(now.getTime() + 20 * 60000);
    return new Date(Math.max(defaultEnd.getTime(), liveHold.getTime()));
  }

  return defaultEnd;
}

// ==================== SORT / FILTER ====================
function sortEvents(events) {
  return [...events].sort((a, b) => {
    const aLive = a.status === "live" ? 0 : 1;
    const bLive = b.status === "live" ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;

    const at = parseET(a.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = parseET(b.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;

    return Number(b.subscribers || 0) - Number(a.subscribers || 0);
  });
}

function rebuildFilters(events) {
  if (!leagueFilter || !platformFilter) return;

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
  const l = leagueFilter ? leagueFilter.value : "all";
  const p = platformFilter ? platformFilter.value : "all";
  const q = searchInput ? searchInput.value.trim().toLowerCase() : "";

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
  renderTodaysGuide();
  renderSchedule();
}

// ==================== HERO ====================
function renderCard(e, forceLiveBadge = false) {
  const start = parseET(e.start_et);
  const media = e.thumbnail_url ? `style="background-image:url('${encodeURI(e.thumbnail_url)}')"` : "";
  const badge = (forceLiveBadge || e.status === "live") ? `<span class="pill live">LIVE</span>` : "";
  const subs = e.subscribers ? `${Number(e.subscribers).toLocaleString()} subs` : "";

  return `
    <div class="card">
      <div class="cardMedia" ${media}></div>
      <div class="cardBody">
        <div class="cardTitle">${escapeHtml(e.title || "")}</div>
        <div class="cardMeta">
          <span>${fmtTimeEt(start)}</span>
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
  if (!nowOn || !upNext) return;

  const live = filteredEvents.find(e => e.status === "live");
  const upcoming = filteredEvents.find(e => e.status !== "live");

  nowOn.innerHTML = live
    ? renderCard(live, true)
    : `<div class="muted">No live event right now.</div>`;

  upNext.innerHTML = upcoming
    ? renderCard(upcoming, false)
    : `<div class="muted">No upcoming events found.</div>`;
}

// ==================== TODAY'S GUIDE (FULL ET DAY) ====================
function renderTodaysGuide() {
  if (!infoTileBody) return;
  if (infoTileHeaderH2) infoTileHeaderH2.textContent = "Today's Guide";

  const now = new Date();
  const dayStart = startOfEtDay(now).getTime();
  const dayEnd = endOfEtDay(now).getTime();

  const todays = filteredEvents
    .filter(e => {
      const s = parseET(e.start_et);
      if (!s) return false;
      const st = s.getTime();
      return st >= dayStart && st <= dayEnd;
    })
    .sort((a, b) => (parseET(a.start_et)?.getTime() ?? 0) - (parseET(b.start_et)?.getTime() ?? 0));

  if (!todays.length) {
    infoTileBody.innerHTML = `<div class="muted">No events scheduled for today.</div>`;
    return;
  }

  const items = todays.map(e => {
    const s = parseET(e.start_et);
    const t = fmtTimeEt(s).replace(" ET", "");
    const isLive = e.status === "live";
    const badge = isLive ? `<span class="chipBadge">LIVE</span>` : "";

    return `
      <a class="chip" href="${escapeHtml(e.watch_url)}" target="_blank" rel="noreferrer">
        <span class="chipTime">${escapeHtml(t)}</span>
        <span class="chipChanStrong">${escapeHtml(e.channel || "")}</span>
        ${badge}
      </a>
    `;
  }).join("");

  infoTileBody.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
      <div class="muted">Today • ${fmtDayEt(now)}</div>
      <div class="muted" style="font-size:12px;">${todays.length} shows</div>
    </div>

    <div class="chipList">${items}</div>

    <style>
      .chipList{display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; padding-right:4px;}
      .chip{display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:999px;
        border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.20); transition:filter .12s ease, transform .12s ease;}
      .chip:hover{filter:brightness(1.07); transform:translateY(-1px);}
      .chipTime{font-weight:900; font-size:12px; color:rgba(255,255,255,.90); min-width:86px; white-space:nowrap;}
      .chipChanStrong{font-weight:900; font-size:13px; color:rgba(255,255,255,.94); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;}
      .chipBadge{margin-left:auto; font-size:11px; padding:4px 9px; border-radius:999px; color:rgba(46,229,157,.95);
        background:rgba(46,229,157,.10); border:1px solid rgba(46,229,157,.30); white-space:nowrap;}
      @media (max-width: 980px){.chipTime{min-width:78px;}}
    </style>
  `;
}

// ==================== SCHEDULE (ET WINDOW, NO SCROLLBARS) ====================
function roundToTickEt(instant) {
  const p = etParts(instant);
  const roundedM = Math.floor(p.m / tickMins) * tickMins;
  return etWallToInstant(p.Y, p.M, p.D, p.h, roundedM);
}

function ensureWindowStart() {
  if (windowStart) return;
  windowStart = roundToTickEt(new Date()); // default to NOW (ET)
}

function renderTimeRow() {
  if (!timeRow || !windowLabel) return;
  ensureWindowStart();

  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;

  const ticks = Math.ceil(windowMins / tickMins) + 1;
  const parts = [];
  for (let i = 0; i < ticks; i++) {
    const dt = new Date(startMs + i * tickMins * 60000);
    parts.push(`<div class="timeTick" style="width:${pxPerTick}px; flex:0 0 ${pxPerTick}px">${fmtTimeEt(dt).replace(" ET","")}</div>`);
  }

  const surfaceW = Math.round(windowMins * pxPerMin);
  timeRow.style.display = "flex";
  timeRow.style.width = `${surfaceW}px`;
  timeRow.style.maxWidth = `${surfaceW}px`;
  timeRow.style.overflow = "hidden";
  timeRow.innerHTML = parts.join("");

  windowLabel.textContent = `${fmtDayEt(windowStart)} • ${fmtTimeEt(windowStart)} → ${fmtTimeEt(new Date(endMs))}`;
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

function renderSchedule() {
  if (!rowsEl || !emptyState) return;

  ensureWindowStart();
  renderTimeRow();

  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;

  const windowEvents = filteredEvents.filter(e => {
    const s = parseET(e.start_et);
    if (!s) return false;
    const ee = eventEnd(e);
    if (!ee) return false;
    return ee.getTime() >= startMs && s.getTime() <= endMs;
  });

  if (!windowEvents.length) {
    rowsEl.innerHTML = "";
    emptyState.style.display = "";
    return;
  }
  emptyState.style.display = "none";

  const surfaceW = Math.round(windowMins * pxPerMin);
  const rows = groupByChannel(windowEvents);

  rowsEl.innerHTML = rows.map(r => {
    const subs = r.maxSubs ? `${Number(r.maxSubs).toLocaleString()} subs` : "";

    const laneBg = `
      background-image: linear-gradient(to right, rgba(255,255,255,0.06) 1px, rgba(0,0,0,0) 1px);
      background-size: ${pxPerTick}px 100%;
    `;

    const blocks = r.list.map(e => {
      const s = parseET(e.start_et);
      const ee = eventEnd(e);
      if (!s || !ee) return "";

      const leftMin = (s.getTime() - startMs) / 60000;
      const rightMin = (ee.getTime() - startMs) / 60000;

      const left = clamp(leftMin * pxPerMin, -9999, 9999);
      const width = clamp((rightMin - leftMin) * pxPerMin, 160, 99999); // keep thumbs readable

      const thumb = e.thumbnail_url || (e.source_id ? `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg` : "");
      const liveBadge = e.status === "live" ? `<span class="badgeLive">LIVE</span>` : "";

      const startLabel = fmtTimeEt(s).replace(" ET", "");
      const endLabel = fmtTimeEt(ee).replace(" ET", "");

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
              <div class="blockTime">${escapeHtml(startLabel)}–${escapeHtml(endLabel)}</div>
              <div style="opacity:.9">${escapeHtml(e.platform || "")}</div>
            </div>
          </div>
        </a>
      `;
    }).join("");

    return `
      <div class="row" style="display:flex; align-items:stretch; border-bottom: 1px solid rgba(255,255,255,0.06);">
        <div class="rowLabel" style="min-width:220px; max-width:220px;">
          <div style="min-width:0;">
            <div class="name">${escapeHtml(r.channel)}</div>
            <div class="subs">${escapeHtml(subs)}</div>
          </div>
        </div>
        <div class="lane" style="width:${surfaceW}px; ${laneBg}">
          ${blocks}
        </div>
      </div>
    `;
  }).join("");
}

function shiftWindow(dir) {
  ensureWindowStart();
  windowStart = new Date(windowStart.getTime() + dir * windowMins * 60000);
  windowStart = roundToTickEt(windowStart);
  renderSchedule();
}

function jumpToNow() {
  windowStart = roundToTickEt(new Date());
  renderSchedule();
}

// ==================== LOAD SCHEDULE ====================
async function loadSchedule() {
  if (nowOn) nowOn.textContent = "Loading…";
  if (upNext) upNext.textContent = "Loading…";
  if (rowsEl) rowsEl.innerHTML = "";
  if (emptyState) emptyState.style.display = "none";

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

  // default schedule window to NOW (ET) every refresh
  windowStart = null;

  const now = new Date();
  if (lastUpdated) lastUpdated.textContent = `Last updated: ${fmtDayEt(now)} ${fmtTimeEt(now)}`;

  applyFilters();
}

// ==================== WIRE ====================
on(leagueFilter, "change", applyFilters);
on(platformFilter, "change", applyFilters);
on(searchInput, "input", applyFilters);

on(refreshBtn, "click", () => loadSchedule().catch(err => {
  console.error(err);
  if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
}));

on(prevWindow, "click", () => shiftWindow(-1));
on(nextWindow, "click", () => shiftWindow(1));
on(jumpNowBtn, "click", jumpToNow);

// initial load
loadSchedule().catch(err => {
  console.error(err);
  if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
});
