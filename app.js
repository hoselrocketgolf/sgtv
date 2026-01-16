// SimGolf.TV Guide
const SCHEDULE_URL = "schedule.json";

const $ = (id) => document.getElementById(id);
const on = (el, evt, fn) => { if (el) el.addEventListener(evt, fn); };

const leagueFilter = $("leagueFilter");
const platformFilter = $("platformFilter");
const searchInput = $("searchInput");
const refreshBtn = $("refreshBtn");

const nowOn = $("nowOn");
const upNext = $("upNext");
const lastUpdated = $("lastUpdated");

// Right tile body (we replace it with “window-only” chips)
const infoTileBody = document.querySelector("#infoTile .tileBody");

// Guide elements
const hScroll = $("hScroll");
const timeRow = $("timeRow");
const rowsEl = $("rows");
const emptyState = $("emptyState");

const prevWindow = $("prevWindow");
const nextWindow = $("nextWindow");
const jumpNowBtn = $("jumpNow");
const windowLabel = $("windowLabel");

// ---------- Time helpers ----------
function parseET(str) {
  if (!str) return null;
  const [d, t] = str.split(" ");
  if (!d || !t) return null;
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  return new Date(Y, (M - 1), D, h, m, 0, 0);
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
  return `${hr}:${m} ${ampm} ET`;
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

// ---------- State ----------
let allEvents = [];
let filteredEvents = [];
let windowStart = null;

// Guide window settings
const windowMins = 240;     // 4 hours visible
const tickMins = 30;        // tick every 30 min
const pxPerTick = 140;      // width per tick
const pxPerMin = pxPerTick / tickMins;

// default show length if no end time in JSON
function eventEnd(e) {
  const end = parseET(e.end_et);
  if (end) return end;
  const start = parseET(e.start_et);
  if (!start) return null;
  // default 2 hours
  return new Date(start.getTime() + 120 * 60000);
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
  renderRightTileWindowList();
  renderGuide();
}

// ---------- Now/Next cards ----------
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

// ---------- Right tile: ONLY show items in current window ----------
function renderRightTileWindowList() {
  if (!infoTileBody) return;

  const now = new Date();
  const base = windowStart || roundToTick(now);
  const startMs = base.getTime();
  const endMs = startMs + windowMins * 60000;

  const windowItems = filteredEvents
    .filter(e => {
      const s = parseET(e.start_et);
      if (!s || !sameDay(s, now)) return false;
      const ee = eventEnd(e) || s;
      const sMs = s.getTime();
      const eMs = ee.getTime();
      return eMs >= startMs && sMs <= endMs;
    })
    .sort((a, b) => (parseET(a.start_et)?.getTime() ?? 0) - (parseET(b.start_et)?.getTime() ?? 0))
    .slice(0, 12);

  if (!windowItems.length) {
    infoTileBody.innerHTML = `<div class="muted">No shows in this window.</div>`;
    return;
  }

  const items = windowItems.map(e => {
    const s = parseET(e.start_et);
    const t = fmtTime(s).replace(" ET", "");
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

  const end = new Date(endMs);

  infoTileBody.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
      <div class="muted">Window • ${fmtTime(base)} → ${fmtTime(end)}</div>
      <div class="muted" style="font-size:12px;">${windowItems.length} shows</div>
    </div>

    <div class="chipList">
      ${items}
    </div>
  `;
}

// ---------- Guide rendering ----------
function roundToTick(dt) {
  const mins = dt.getMinutes();
  const rounded = Math.floor(mins / tickMins) * tickMins;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), rounded, 0, 0);
}

function ensureWindowStart() {
  // IMPORTANT: always default to current time (not “Up Next”)
  if (!windowStart) windowStart = roundToTick(new Date());
}

function renderTimeRow() {
  if (!timeRow || !windowLabel) return;
  ensureWindowStart();

  const ticks = Math.ceil(windowMins / tickMins) + 1;
  const laneWidth = ticks * pxPerTick;

  timeRow.style.minWidth = `${laneWidth}px`;

  const parts = [];
  for (let i = 0; i < ticks; i++) {
    const dt = new Date(windowStart.getTime() + i * tickMins * 60000);
    parts.push(`<div class="timeTick" style="width:${pxPerTick}px">${fmtTime(dt).replace(" ET","")}</div>`);
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
  if (!rowsEl || !emptyState) return;

  ensureWindowStart();
  renderTimeRow();

  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;

  // Only events overlapping window
  const windowEvents = filteredEvents.filter(e => {
    const s = parseET(e.start_et);
    if (!s) return false;
    const ee = eventEnd(e) || s;
    return ee.getTime() >= startMs && s.getTime() <= endMs;
  });

  // keep it “today” only (TV guide vibe)
  const today = new Date();
  const todaysWindow = windowEvents.filter(e => {
    const s = parseET(e.start_et);
    return s && sameDay(s, today);
  });

  if (!todaysWindow.length) {
    rowsEl.innerHTML = "";
    emptyState.style.display = "";
    renderRightTileWindowList();
    return;
  }
  emptyState.style.display = "none";

  const rows = groupByChannel(todaysWindow);

  const ticks = Math.ceil(windowMins / tickMins) + 1;
  const laneWidth = ticks * pxPerTick;

  rowsEl.innerHTML = rows.map(r => {
    const subs = r.maxSubs ? `${Number(r.maxSubs).toLocaleString()} subs` : "";

    const blocks = r.list.map(e => {
      const s = parseET(e.start_et);
      const ee = eventEnd(e) || s;
      if (!s || !ee) return "";

      const leftMin = (s.getTime() - startMs) / 60000;
      const rightMin = (ee.getTime() - startMs) / 60000;

      const left = clamp(leftMin * pxPerMin, -99999, 99999);
      const width = clamp((rightMin - leftMin) * pxPerMin, 160, 99999);

      const thumb = e.thumbnail_url || (e.source_id ? `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg` : "");
      const liveBadge = e.status === "live" ? `<span class="badgeLiveInline">LIVE</span>` : "";

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
              <div class="blockPlat">${escapeHtml(e.platform || "")}</div>
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
        <div class="lane" style="min-width:${laneWidth}px; background-size:${pxPerTick}px 1px;">
          ${blocks}
        </div>
      </div>
    `;
  }).join("");

  renderRightTileWindowList();
}

function shiftWindow(dir) {
  ensureWindowStart();
  windowStart = new Date(windowStart.getTime() + dir * windowMins * 60000);
  renderGuide();
  if (hScroll) hScroll.scrollLeft = 0; // clean snap per window
}

function jumpToNow() {
  windowStart = roundToTick(new Date());
  renderGuide();
  if (hScroll) hScroll.scrollLeft = 0;
}

// ---------- Fetch schedule.json ----------
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

  // IMPORTANT: always start at NOW on load/refresh
  windowStart = roundToTick(new Date());

  const now = new Date();
  if (lastUpdated) lastUpdated.textContent = `Last updated: ${fmtDay(now)} ${fmtTime(now)}`;

  applyFilters();
}

// ---------- Wire up ----------
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

// initial
loadSchedule().catch(err => {
  console.error(err);
  if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
});
