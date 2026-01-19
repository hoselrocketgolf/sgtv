// SimGolf.TV Guide - app.js
// Stable schedule geometry + correct timezone conversion (ET -> viewer local)

const SCHEDULE_URL = "schedule.json";

const $ = (id) => document.getElementById(id);
const on = (el, evt, fn) => {
  if (el) el.addEventListener(evt, fn);
};

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

// -------------------- Timezone helpers --------------------
// schedule.json uses ET clock strings (YYYY-MM-DD HH:MM) for start_et/end_et.
// We convert ET -> real epoch milliseconds -> display in viewer's local timezone.

const ET_TZ = "America/New_York";

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function getOffsetMinutes(date, timeZone) {
  // offset = (zonedTimeAsUTC - actualUTC) in minutes
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    0,
    0
  );
  return (asUTC - date.getTime()) / 60000;
}

function zonedTimeToUtcDate({ Y, M, D, h, m }, timeZone) {
  // Two-pass to handle DST transitions robustly
  const guess = new Date(Date.UTC(Y, M - 1, D, h, m, 0, 0));
  const off1 = getOffsetMinutes(guess, timeZone);
  const d1 = new Date(guess.getTime() - off1 * 60000);
  const off2 = getOffsetMinutes(d1, timeZone);
  return new Date(guess.getTime() - off2 * 60000);
}

function parseET(str) {
  if (!str) return null;
  const [d, t] = str.split(" ");
  if (!d || !t) return null;
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  if (![Y, M, D, h, m].every(Number.isFinite)) return null;
  return zonedTimeToUtcDate({ Y, M, D, h, m }, ET_TZ);
}

function fmtTime(dt) {
  if (!dt) return "";
  // viewer local time
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

function fmtDay(dt) {
  if (!dt) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dt);
}

function startOfDayLocal(dt) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0);
}
function endOfDayLocal(dt) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
}

// -------------------- State --------------------
let allEvents = [];
let filteredEvents = [];
let windowStart = null;

// Window configuration
let windowMins = 240; // 4 hours

// Geometry read from CSS vars so header + blocks NEVER drift
let tickMins = 30;
let pxPerTick = 140;
let pxPerMin = pxPerTick / tickMins;

function readScheduleGeometryFromCss() {
  const cs = getComputedStyle(document.documentElement);

  const tickRaw = cs.getPropertyValue("--tickMins").trim();
  const pxTickRaw = cs.getPropertyValue("--pxPerTick").trim();

  const t = Number.parseFloat(tickRaw);
  const p = Number.parseFloat(pxTickRaw);

  if (Number.isFinite(t) && t > 0) tickMins = t;
  if (Number.isFinite(p) && p > 0) pxPerTick = p;

  pxPerMin = pxPerTick / tickMins;
}

// -------------------- Event end-time logic --------------------
// - Prefer explicit end_et if provided
// - Default: 2 hours from start
// - If LIVE: extend to max(start+2h, now+20m) so it stays visible while live
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

  events.forEach((e) => {
    if (e.league) leagues.add(e.league);
    if (e.platform) platforms.add(e.platform);
  });

  const keepLeague = leagueFilter.value;
  const keepPlat = platformFilter.value;

  leagueFilter.innerHTML =
    `<option value="all">All</option>` +
    [...leagues]
      .sort()
      .map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`)
      .join("");

  platformFilter.innerHTML =
    `<option value="all">All</option>` +
    [...platforms]
      .sort()
      .map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`)
      .join("");

  if ([...leagues].includes(keepLeague)) leagueFilter.value = keepLeague;
  if ([...platforms].includes(keepPlat)) platformFilter.value = keepPlat;
}

function applyFilters() {
  const l = leagueFilter ? leagueFilter.value : "all";
  const p = platformFilter ? platformFilter.value : "all";
  const q = searchInput ? searchInput.value.trim().toLowerCase() : "";

  filteredEvents = allEvents.filter((e) => {
    if (l !== "all" && (e.league || "") !== l) return false;
    if (p !== "all" && (e.platform || "") !== p) return false;
    if (q) {
      const blob = `${e.title || ""} ${e.league || ""} ${e.platform || ""} ${
        e.channel || ""
      }`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  filteredEvents = sortEvents(filteredEvents);

  renderNowNext();
  renderTodaysGuide();
  renderSchedule();
}

// -------------------- Hero cards --------------------
function renderCard(e, forceLiveBadge = false) {
  const start = parseET(e.start_et);
  const media = e.thumbnail_url
    ? `style="background-image:url('${encodeURI(e.thumbnail_url)}')"`
    : "";
  const live = forceLiveBadge || e.status === "live";
  const badge = live ? `<span class="pill live">LIVE</span>` : "";
  const subs = e.subscribers ? `${Number(e.subscribers).toLocaleString()} subs` : "";

 return `
  <a class="card${live ? " isLive" : ""}" 
     href="${escapeHtml(e.watch_url || "#")}" 
     target="_blank" 
     rel="noreferrer">

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
      <span class="watchBtn">Watch</span>
    </div>
  </a>
`;

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

  const live = filteredEvents.find((e) => e.status === "live");
  const upcoming = filteredEvents.find((e) => e.status !== "live");

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
  if (infoTileHeaderH2) infoTileHeaderH2.textContent = "Today's Guide";

  const now = new Date();
  const dayStart = startOfDayLocal(now).getTime();
  const dayEnd = endOfDayLocal(now).getTime();

  const todays = filteredEvents
    .filter((e) => {
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

  const items = todays
    .map((e) => {
      const s = parseET(e.start_et);
      const t = fmtTime(s);
      const isLive = e.status === "live";
      // Preference B: keep LIVE only in the chip (not extra “live now” rows)
      const badge = isLive ? `<span class="chipBadge">LIVE</span>` : "";

      return `
        <a class="chip" href="${escapeHtml(e.watch_url)}" target="_blank" rel="noreferrer">
          <span class="chipTime">${escapeHtml(t)}</span>
          <span class="chipChanStrong">${escapeHtml(e.channel || "")}</span>
          ${badge}
        </a>
      `;
    })
    .join("");

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
      .chipTime{font-weight:900; font-size:12px; color:rgba(255,255,255,.90); min-width:86px; white-space:nowrap;}
      .chipChanStrong{font-weight:900; font-size:13px; color:rgba(255,255,255,.94); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;}
      .chipBadge{margin-left:auto; font-size:11px; padding:4px 9px; border-radius:999px; color:rgba(46,229,157,.95);
        background:rgba(46,229,157,.10); border:1px solid rgba(46,229,157,.30); white-space:nowrap;}
      @media (max-width: 980px){.chipTime{min-width:78px;}}
    </style>
  `;
}

// -------------------- Bottom schedule --------------------
function roundToTick(dt) {
  const mins = dt.getMinutes();
  const rounded = Math.floor(mins / tickMins) * tickMins;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), rounded, 0, 0);
}

function nowInET() {
  const now = new Date();
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  return new Date(
    Number(etParts.year),
    Number(etParts.month) - 1,
    Number(etParts.day),
    Number(etParts.hour),
    Number(etParts.minute),
    0,
    0
  );
}

function ensureWindowStart() {
  if (windowStart) return;
  windowStart = roundToTick(nowInET());
}


function renderTimeRow() {
  if (!timeRow || !windowLabel) return;
  readScheduleGeometryFromCss();
  ensureWindowStart();

  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;

  const ticks = Math.ceil(windowMins / tickMins) + 1;
  const parts = [];
  for (let i = 0; i < ticks; i++) {
    const dt = new Date(startMs + i * tickMins * 60000);
    parts.push(
      `<div class="timeTick" style="width:${pxPerTick}px; flex:0 0 ${pxPerTick}px">${escapeHtml(
        fmtTime(dt)
      )}</div>`
    );
  }

  const surfaceW = Math.round(windowMins * pxPerMin);

  timeRow.style.display = "flex";
  timeRow.style.width = `${surfaceW}px`;
  timeRow.style.maxWidth = `${surfaceW}px`;
  timeRow.style.whiteSpace = "nowrap";
  timeRow.style.overflow = "hidden";
  timeRow.innerHTML = parts.join("");

  const end = new Date(endMs);
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
    const hasLive = list.some((x) => x.status === "live");
    const maxSubs = Math.max(...list.map((x) => Number(x.subscribers || 0)));
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

  readScheduleGeometryFromCss();
  ensureWindowStart();
  renderTimeRow();

  const startMs = windowStart.getTime();
  const endMs = startMs + windowMins * 60000;

  const windowEvents = filteredEvents.filter((e) => {
    const s = parseET(e.start_et);
    if (!s) return false;
    const ee = eventEnd(e);
    if (!ee) return false;
    return ee.getTime() >= startMs && s.getTime() <= endMs; // overlaps window
  });

  if (!windowEvents.length) {
    rowsEl.innerHTML = "";
    emptyState.style.display = "";
    return;
  }
  emptyState.style.display = "none";

  const surfaceW = Math.round(windowMins * pxPerMin);
  const rows = groupByChannel(windowEvents);

  rowsEl.innerHTML = rows
    .map((r) => {
      const subs = r.maxSubs ? `${Number(r.maxSubs).toLocaleString()} subs` : "";

      const blocks = r.list
        .map((e) => {
          const s = parseET(e.start_et);
          const ee = eventEnd(e);
          if (!s || !ee) return "";

          const leftMin = (s.getTime() - startMs) / 60000;
          const rightMin = (ee.getTime() - startMs) / 60000;

          const left = leftMin * pxPerMin;
          const right = rightMin * pxPerMin;

          // Clip to visible surface
          const clippedLeft = clamp(left, 0, surfaceW);
          const clippedRight = clamp(right, 0, surfaceW);

          let width = clippedRight - clippedLeft;
          if (width < 0) return "";

          // Minimum width for usability, but never exceed the surface
          const minW = 160;
          width = Math.max(width, minW);
          if (clippedLeft + width > surfaceW) width = surfaceW - clippedLeft;

          const thumb =
            e.thumbnail_url ||
            (e.source_id ? `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg` : "");
          const liveBadge = e.status === "live" ? `<span class="badgeLive">LIVE</span>` : "";

          const startLabel = fmtTime(s);
          const endLabel = fmtTime(ee);

          return `
            <a class="block${e.status === "live" ? " isLive" : ""}" href="${escapeHtml(
            e.watch_url || "#"
          )}" target="_blank" rel="noreferrer"
              style="left:${clippedLeft}px; width:${width}px;">
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
        })
        .join("");

      return `
        <div class="row">
          <div class="rowLabel">
            <div style="min-width:0;">
              <div class="name">${escapeHtml(r.channel)}</div>
              <div class="subs">${escapeHtml(subs)}</div>
            </div>
          </div>
          <div class="lane" style="width:${surfaceW}px;">
            ${blocks}
          </div>
        </div>
      `;
    })
    .join("");
}

function shiftWindow(dir) {
  readScheduleGeometryFromCss();
  ensureWindowStart();
  windowStart = new Date(windowStart.getTime() + dir * windowMins * 60000);
  windowStart = roundToTick(windowStart);
  renderSchedule();
}

function jumpToNow() {
  readScheduleGeometryFromCss();
  windowStart = roundToTick(new Date());
  renderSchedule();
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
      .filter((e) => e && e.start_et && e.watch_url)
      .map((e) => ({
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

  // IMPORTANT: default schedule window to NOW every refresh
  windowStart = null;

  const now = new Date();
  if (lastUpdated)
    lastUpdated.textContent = `Last updated: ${fmtDay(now)} ${fmtTime(now)}`;

  applyFilters();
}

// -------------------- Wire up --------------------
on(leagueFilter, "change", applyFilters);
on(platformFilter, "change", applyFilters);
on(searchInput, "input", applyFilters);

on(refreshBtn, "click", () =>
  loadSchedule().catch((err) => {
    console.error(err);
    if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
    if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
  })
);

on(prevWindow, "click", () => shiftWindow(-1));
on(nextWindow, "click", () => shiftWindow(1));
on(jumpNowBtn, "click", jumpToNow);

// initial load
loadSchedule().catch((err) => {
  console.error(err);
  if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
});
