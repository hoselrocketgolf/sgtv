// SimGolf.TV Guide - app.js (polish pack: tz labels + "now" column highlight + live pulse)

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

// Schedule header title (for timezone label)
const scheduleTitleEl = document.querySelector(".scheduleHeader h2");

// -------------------- Timezone helpers --------------------
function getUserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}
function getUserTzShort() {
  try {
    const parts = new Date().toLocaleTimeString([], { timeZoneName: "short" }).split(" ");
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
}
const USER_TZ = getUserTimeZone();
const USER_TZ_SHORT = getUserTzShort();

// -------------------- Time helpers --------------------
// NOTE: schedule.json times are stored like "YYYY-MM-DD HH:MM" (previously ET).
// Your site already states "local time zone" — we display labels in local time.
// (We keep parsing simple like before; your generator defines the source truth.)
function parseLocal(str) {
  if (!str) return null;
  const [d, t] = str.split(" ");
  if (!d || !t) return null;
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  return new Date(Y, (M - 1), D, h, m, 0, 0);
}

function startOfDay(dt) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0);
}
function endOfDay(dt) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
}
function sameDay(a, b) {
  return a && b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}
function fmtTime(dt) {
  if (!dt) return "";
  const h = dt.getHours();
  const m = dt.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = ((h + 11) % 12) + 1;
  return `${hr}:${m} ${ampm}`;
}
function fmtDay(dt) {
  if (!dt) return "";
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${days[dt.getDay()]}, ${months[dt.getMonth()]} ${dt.getDate()}`;
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

// -------------------- State --------------------
let allEvents = [];
let filteredEvents = [];
let windowStart = null;

// Window configuration
let windowMins = 240;     // 4 hours
let tickMins = 30;        // time labels every 30 min
let pxPerTick = 140;      // width per tick
let pxPerMin = pxPerTick / tickMins;

// -------------------- Small UI polish: timezone labels --------------------
function applyTimeZoneLabels() {
  const tz = USER_TZ_SHORT ? ` (${USER_TZ_SHORT})` : "";
  if (scheduleTitleEl) scheduleTitleEl.textContent = `Today's Schedule${tz}`;
  if (infoTileHeaderH2) infoTileHeaderH2.textContent = "Today's Guide";
}
applyTimeZoneLabels();

// -------------------- Event end-time logic --------------------
// - Default: 2 hours from start
// - If LIVE: extend to max(start+2h, now+20m) so it stays visible while live
function eventEnd(e) {
  const end = parseLocal(e.end_et);
  if (end) return end;

  const start = parseLocal(e.start_et);
  if (!start) return null;

  const defaultEnd = new Date(start.getTime() + 120 * 60000);

  if (e.status === "live") {
    const now = new Date();
    const liveHold = new Date(now.getTime() + 20 * 60000);
    return new Date(Math.max(defaultEnd.getTime(), liveHold.getTime()));
  }
  return defaultEnd;
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const aLive = a.status === "live" ? 0 : 1;
    const bLive = b.status === "live" ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;

    const at = parseLocal(a.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = parseLocal(b.start_et)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;

    const as = Number(a.subscribers || 0);
    const bs = Number(b.subscribers || 0);
    return bs - as;
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
  renderTodaysGuide();   // full day list (right tile)
  renderSchedule();      // bottom schedule
}

// -------------------- Hero cards --------------------
function renderCard(e, forceLiveBadge = false) {
  const start = parseLocal(e.start_et);
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

// -------------------- Right tile: Today’s Guide (full day) --------------------
function renderTodaysGuide() {
  if (!infoTileBody) return;

  const now = new Date();
  const dayStart = startOfDay(now).getTime();
  const dayEnd = endOfDay(now).getTime();

  const todays = filteredEvents
    .filter(e => {
      const s = parseLocal(e.start_et);
      if (!s) return false;
      const st = s.getTime();
      return st >= dayStart && st <= dayEnd;
    })
    .sort((a, b) => (parseLocal(a.start_et)?.getTime() ?? 0) - (parseLocal(b.start_et)?.getTime() ?? 0));

  if (!todays.length) {
    infoTileBody.innerHTML = `<div class="muted">No events scheduled for today.</div>`;
    return;
  }

  const items = todays.map(e => {
    const s = parseLocal(e.start_et);
    const t = fmtTime(s);
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
      <div class="muted">Today • ${fmtDay(now)}</div>
      <div class="muted" style="font-size:12px;">${todays.length} shows</div>
    </div>

    <div class="chipList">${items}</div>

    <style>
      .chipList{display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; padding-right:4px;}
      .chip{display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:999px;
        border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.20); transition:filter .12s ease, transform .12s ease;}
      .chip:hover{filter:brightness(1.07); transform:translateY(-1px);}
      .chipTime{font-weight:900; font-size:12px; color:rgba(255,255,255,.90); min-width:78px; white-space:nowrap;}
      .chipChanStrong{font-weight:900; font-size:13px; color:rgba(255,255,255,.94); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;}
      .chipBadge{margin-left:auto; font-size:11px; padding:4px 9px; border-radius:999px; color:rgba(46,229,157,.95);
        background:rgba(46,229,157,.10); border:1px solid rgba(46,229,157,.30); white-space:nowrap;}
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
  windowStart = roundToTick(new Date()); // default to NOW
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
  const tz = USER_TZ_SHORT ? ` (${USER_TZ_SHORT})` : "";
  windowLabel.textContent = `${fmtDay(windowStart)} • ${fmtTime(windowStart)} → ${fmtTime(end)}${tz}`;
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

// ---- NOW column highlight (vertical band + line) ----
function nowOffsetPx() {
  ensureWindowStart();
  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;
  const nowMs = Date.now();

  if (nowMs < startMs || nowMs > endMs) return null;
  const mins = (nowMs - startMs) / 60000;
  return mins * pxPerMin;
}

function renderSchedule() {
  if (!rowsEl || !emptyState) return;

  ensureWindowStart();
  renderTimeRow();

  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;

  const windowEvents = filteredEvents.filter(e => {
    const s = parseLocal(e.start_et);
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

  const nowPx = nowOffsetPx();
  const nowMarker = (nowPx !== null)
    ? `<div class="nowMarker" style="left:${nowPx}px"></div>`
    : "";

  rowsEl.innerHTML = rows.map(r => {
    const subs = r.maxSubs ? `${Number(r.maxSubs).toLocaleString()} subs` : "";

    const blocks = r.list.map(e => {
      const s = parseLocal(e.start_et);
      const ee = eventEnd(e);
      if (!s || !ee) return "";

      const leftMin = (s.getTime() - startMs) / 60000;
      const rightMin = (ee.getTime() - startMs) / 60000;

      const left = clamp(leftMin * pxPerMin, -9999, 9999);
      const width = clamp((rightMin - leftMin) * pxPerMin, 160, 99999);

      const thumb = e.thumbnail_url || (e.source_id ? `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg` : "");
      const liveBadge = e.status === "live" ? `<span class="badgeLive">LIVE</span>` : "";

      const startLabel = fmtTime(s);
      const endLabel = fmtTime(ee);

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

    const rowClass = r.hasLive ? "row isLiveRow" : "row";

    return `
      <div class="${rowClass}">
        <div class="rowLabel">
          <div class="name">${escapeHtml(r.channel)}</div>
          <div class="subs">${escapeHtml(subs)}</div>
          ${r.hasLive ? `<div class="liveMini">Live now</div>` : ``}
        </div>

        <div class="lane" style="width:${surfaceW}px;">
          ${nowMarker}
          ${blocks}
        </div>
      </div>
    `;
  }).join("");

  // brand button pulse if any live exists
  const brandBtn = $("brandBtn");
  if (brandBtn) {
    const anyLive = filteredEvents.some(e => e.status === "live");
    brandBtn.classList.toggle("isLive", anyLive);
  }
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

// ---- Keep "now marker" fresh without refetching ----
let nowMarkerTimer = null;
function startNowMarkerTimer() {
  if (nowMarkerTimer) clearInterval(nowMarkerTimer);
  nowMarkerTimer = setInterval(() => {
    // only repaint schedule if it's on screen
    if (rowsEl && rowsEl.childElementCount) renderSchedule();
  }, 30000); // every 30s
}

// -------------------- Fetch schedule.json --------------------
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

  // default schedule window to NOW each refresh
  windowStart = null;

  const now = new Date();
  const tz = USER_TZ_SHORT ? ` (${USER_TZ_SHORT})` : "";
  if (lastUpdated) lastUpdated.textContent = `Last updated: ${fmtDay(now)} ${fmtTime(now)}${tz}`;

  applyFilters();
  startNowMarkerTimer();
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

// initial load
loadSchedule().catch(err => {
  console.error(err);
  if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
});
