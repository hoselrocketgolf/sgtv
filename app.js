// SimGolf.TV Guide - app.js (ET source → user local display, schedule blocks clamped to window)

const SCHEDULE_URL = "schedule.json";
const $ = (id) => document.getElementById(id);
const on = (el, evt, fn) => { if (el) el.addEventListener(evt, fn); };

// -------------------- Time zone helpers --------------------
function getUserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}
function getUserTzShort() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(new Date());
    return parts.find(p => p.type === "timeZoneName")?.value || "";
  } catch { return ""; }
}
const USER_TZ = getUserTimeZone();
const USER_TZ_SHORT = getUserTzShort();

// Schedule is authored in Eastern wall time strings:
const ET_TZ = "America/New_York";

function getParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const get = (t) => Number(parts.find(p => p.type === t)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

// Convert ET wall time "YYYY-MM-DD HH:MM" -> instant Date.
function parseET(str) {
  if (!str) return null;
  const [d, t] = str.split(" ");
  if (!d || !t) return null;

  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  if (![Y, M, D, h, m].every(n => Number.isFinite(n))) return null;

  // start guess at UTC with same wall time
  let utc = Date.UTC(Y, M - 1, D, h, m, 0, 0);

  // Iteratively correct until the ET wall clock matches.
  for (let i = 0; i < 4; i++) {
    const got = getParts(new Date(utc), ET_TZ);

    const desiredUTC = Date.UTC(Y, M - 1, D, h, m, 0, 0);
    const gotUTC = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, 0, 0);

    const diff = desiredUTC - gotUTC;
    if (Math.abs(diff) < 30 * 1000) break;
    utc += diff;
  }

  return new Date(utc);
}

function startOfDay(dt) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0);
}
function endOfDay(dt) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
}
function fmtTime(dt) {
  if (!dt) return "";
  return dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function fmtDay(dt) {
  if (!dt) return "";
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
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

// -------------------- DOM --------------------
const leagueFilter = $("leagueFilter");
const platformFilter = $("platformFilter");
const searchInput = $("searchInput");
const refreshBtn = $("refreshBtn");

const nowOn = $("nowOn");
const upNext = $("upNext");
const lastUpdated = $("lastUpdated");

const infoTileBody = document.querySelector("#infoTile .tileBody");
const infoTileHeaderH2 = document.querySelector("#infoTile .tileHeader h2");

const timeRow = $("timeRow");
const rowsEl = $("rows");
const emptyState = $("emptyState");

const prevWindow = $("prevWindow");
const nextWindow = $("nextWindow");
const jumpNowBtn = $("jumpNow");
const windowLabel = $("windowLabel");

// -------------------- State --------------------
let allEvents = [];
let filteredEvents = [];
let windowStart = null;

// Window config
let windowMins = 240;
let tickMins = 30;
let pxPerTick = 140;
let pxPerMin = pxPerTick / tickMins;

// Safety: kill native scrollbars inside schedule
(function injectNoScrollCss() {
  const css = `
    #timeRow, #rows { overflow: hidden !important; }
    .row { overflow: hidden !important; }
    .lane { overflow: hidden !important; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

// -------------------- End time logic --------------------
// Default: 2h. If LIVE: extend to max(start+2h, now+20m)
function eventEnd(e) {
  const explicit = parseET(e.end_et);
  if (explicit) return explicit;

  const start = parseET(e.start_et);
  if (!start) return null;

  const defaultEnd = new Date(start.getTime() + 120 * 60000);

  if (e.status === "live") {
    const liveHold = new Date(Date.now() + 20 * 60000);
    return new Date(Math.max(defaultEnd.getTime(), liveHold.getTime()));
  }
  return defaultEnd;
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const aLive = a.status === "live" ? 0 : 1;
    const bLive = b.status === "live" ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;

    const at = parseET(a.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = parseET(b.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;

    return (Number(b.subscribers || 0) - Number(a.subscribers || 0));
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

function setBrandLiveGlow() {
  const brandBtn = $("brandBtn");
  if (!brandBtn) return;
  const anyLive = filteredEvents.some(e => e.status === "live");
  brandBtn.classList.toggle("glow", anyLive);
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

  setBrandLiveGlow();
  renderNowNext();
  renderTodaysGuide();
  renderSchedule();
}

// -------------------- Hero cards --------------------
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

// -------------------- Today's Guide (Preference B: subtle dot, no extra LIVE pills) --------------------
function renderTodaysGuide() {
  if (!infoTileBody) return;
  if (infoTileHeaderH2) infoTileHeaderH2.textContent = "Today's Guide";

  const now = new Date();
  const dayStart = startOfDay(now).getTime();
  const dayEnd = endOfDay(now).getTime();

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
    const isLive = e.status === "live";
    return `
      <a class="chip ${isLive ? "chipLive" : ""}" href="${escapeHtml(e.watch_url)}" target="_blank" rel="noreferrer">
        <span class="chipTime">
          ${isLive ? `<span class="chipDot" aria-hidden="true"></span>` : ``}
          ${escapeHtml(fmtTime(s))}
        </span>
        <span class="chipChanStrong">${escapeHtml(e.channel || "")}</span>
      </a>
    `;
  }).join("");

  infoTileBody.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
      <div class="muted">Today • ${fmtDay(now)}</div>
      <div class="muted" style="font-size:12px;">${todays.length} shows</div>
    </div>

    <div class="chipList">${items}</div>

    <style>
      .chipList{display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; padding-right:4px;}
      .chip{display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:999px;
        border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.20); transition:filter .12s ease, transform .12s ease;}
      .chip:hover{filter:brightness(1.07); transform:translateY(-1px);}
      .chipTime{font-weight:900; font-size:12px; color:rgba(255,255,255,.90); min-width:110px; white-space:nowrap; display:inline-flex; align-items:center; gap:8px;}
      .chipChanStrong{font-weight:900; font-size:13px; color:rgba(255,255,255,.94); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;}
      .chipLive .chipTime{color:rgba(70,240,170,.95);}
      .chipDot{width:8px; height:8px; border-radius:999px; background:rgba(70,240,170,.95); box-shadow:0 0 10px rgba(70,240,170,.25);}
      @media (max-width: 980px){.chipTime{min-width:98px;}}
    </style>
  `;
}

// -------------------- Bottom schedule --------------------
function roundToTick(dt) {
  const mins = dt.getMinutes();
  const rounded = Math.floor(mins / tickMins) * tickMins;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), rounded, 0, 0);
}

function ensureWindowStart() {
  if (windowStart) return;
  windowStart = roundToTick(new Date()); // always NOW on refresh
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
    parts.push(`<div class="timeTick" style="width:${pxPerTick}px; flex:0 0 ${pxPerTick}px">${escapeHtml(fmtTime(dt))}</div>`);
  }

  const surfaceW = Math.round(windowMins * pxPerMin);

  timeRow.style.display = "flex";
  timeRow.style.width = `${surfaceW}px`;
  timeRow.style.maxWidth = `${surfaceW}px`;
  timeRow.style.whiteSpace = "nowrap";
  timeRow.style.overflow = "hidden";
  timeRow.innerHTML = parts.join("");

  const end = new Date(endMs);
  windowLabel.textContent = `${fmtDay(windowStart)} • ${fmtTime(windowStart)} → ${fmtTime(end)}${USER_TZ_SHORT ? ` (${USER_TZ_SHORT})` : ""}`;
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
  const surfaceW = Math.round(windowMins * pxPerMin);

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

      // Raw pixel positions relative to window start
      const leftPxRaw = ((s.getTime() - startMs) / 60000) * pxPerMin;
      const rightPxRaw = ((ee.getTime() - startMs) / 60000) * pxPerMin;

      // ✅ CRITICAL FIX: clamp to visible window so block always matches header ticks
      const leftPx = clamp(leftPxRaw, 0, surfaceW);
      const rightPx = clamp(rightPxRaw, 0, surfaceW);

      if (rightPx <= leftPx) return ""; // nothing visible

      const widthPx = Math.max(rightPx - leftPx, 160); // keep thumbs readable, but start/end are correct

      const thumb = e.thumbnail_url || (e.source_id ? `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg` : "");
      const liveBadge = e.status === "live" ? `<span class="badgeLive">LIVE</span>` : "";

      // Labels reflect true times; bar reflects clamped visibility
      const startLabel = fmtTime(s);
      const endLabel = fmtTime(ee);

      return `
        <a class="block" href="${escapeHtml(e.watch_url || "#")}" target="_blank" rel="noreferrer"
           style="left:${leftPx}px; width:${widthPx}px;">
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
      <div class="row">
        <div class="rowLabel">
          <div class="name">${escapeHtml(r.channel)}</div>
          <div class="subs">${escapeHtml(subs)}</div>
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
  windowStart = roundToTick(windowStart);
  renderSchedule();
}

function jumpToNow() {
  windowStart = roundToTick(new Date());
  renderSchedule();
}

// -------------------- Fetch schedule --------------------
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
  windowStart = null; // reset window to NOW on refresh

  const now = new Date();
  if (lastUpdated) lastUpdated.textContent = `Last updated: ${fmtDay(now)} ${fmtTime(now)}${USER_TZ_SHORT ? ` (${USER_TZ_SHORT})` : ""}`;

  applyFilters();
}

// -------------------- Wire up --------------------
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

loadSchedule().catch(err => {
  console.error(err);
  if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
});
