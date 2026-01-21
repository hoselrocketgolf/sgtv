// SimGolf.TV Guide - app.js
// Stable schedule geometry + correct timezone conversion (ET -> viewer local)

const SCHEDULE_URL = "schedule.json";
const CSV_URL = "";
const MAX_LIVE_AGE_HOURS = 4;
const MAX_LIVE_FUTURE_MINS = 10;

const $ = (id) => document.getElementById(id);
const on = (el, evt, fn) => {
  if (el) el.addEventListener(evt, fn);
};

// Controls
const platformFilter = $("platformFilter");
const searchInput = $("searchInput");
const refreshBtn = $("refreshBtn");

// Hero tiles
const nowOn = $("nowOn");
const upNext = $("upNext");
const lastUpdated = $("lastUpdated");
const livePrev = $("livePrev");
const liveNext = $("liveNext");
const liveCounter = $("liveCounter");
const liveNav = $("liveNav");

// Recent streams
const recentStreams = $("recentStreams");
const recentStreamsMeta = $("recentStreamsMeta");
const recentPrev = $("recentPrev");
const recentNext = $("recentNext");
const recentCounter = $("recentCounter");
const recentNav = $("recentNav");

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

function shuffleArray(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

function getEventStart(e) {
  if (e?.start_override instanceof Date) return e.start_override;
  return parseET(e?.start_et);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === ",") {
      row.push(value);
      value = "";
      continue;
    }
    if (!inQuotes && ch === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }
    if (ch !== "\r") value += ch;
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function normalizeCsvHeaders(headers) {
  return headers.map((h) => h.trim().replace(/^\uFEFF/, "").toLowerCase());
}

function findCsvValue(row, headers, keys) {
  for (const key of keys) {
    const idx = headers.indexOf(key);
    if (idx !== -1 && row[idx] !== undefined) {
      return row[idx].trim();
    }
  }
  return "";
}

function csvRowsToEvents(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];
  const headers = normalizeCsvHeaders(rows[0]);
  const dataRows = rows.slice(1).filter((r) => r.some((cell) => cell.trim().length));

  return dataRows.map((row) => {
    const start = findCsvValue(row, headers, [
      "start_et",
      "start",
      "time",
      "start time",
      "start_time",
    ]);
    const end = findCsvValue(row, headers, ["end_et", "end", "end time", "end_time"]);
    const title = findCsvValue(row, headers, ["title", "event", "name"]);
    const league = findCsvValue(row, headers, ["league", "tour"]);
    const platform = findCsvValue(row, headers, ["platform"]);
    const channel = findCsvValue(row, headers, ["channel", "channel_name", "host"]);
    const watchUrl = findCsvValue(row, headers, ["watch_url", "url", "link", "watch", "watch url"]);
    const status = findCsvValue(row, headers, ["status", "live_status"]);
    const thumbnailUrl = findCsvValue(row, headers, ["thumbnail_url", "thumb", "thumbnail"]);
    const subscribers = findCsvValue(row, headers, ["subscribers", "subs"]);

    return {
      start_et: start,
      end_et: end,
      title,
      league,
      platform,
      channel,
      watch_url: watchUrl,
      status,
      thumbnail_url: thumbnailUrl,
      subscribers,
    };
  });
}

function parseScheduleData(rawText, preferCsv) {
  const trimmed = rawText.trim();
  if (preferCsv) return csvRowsToEvents(rawText);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      // fall through to CSV parsing
    }
  }
  return csvRowsToEvents(rawText);
}

function fmtTime(dt) {
  if (!dt) return "";
  // viewer local time
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

function fmtDay(dt, timeZone) {
  if (!dt) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(dt);
}

function getZonedDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    Y: Number(parts.year),
    M: Number(parts.month),
    D: Number(parts.day),
  };
}

function startOfDayZoned(date, timeZone) {
  const { Y, M, D } = getZonedDateParts(date, timeZone);
  return zonedTimeToUtcDate({ Y, M, D, h: 0, m: 0 }, timeZone);
}

function endOfDayZoned(date, timeZone) {
  const { Y, M, D } = getZonedDateParts(date, timeZone);
  return zonedTimeToUtcDate({ Y, M, D, h: 23, m: 59 }, timeZone);
}

// -------------------- State --------------------
let allEvents = [];
let filteredEvents = [];
let windowStart = null;
let liveIndex = 0;
let recentIndex = 0;
let recentEvents = [];
let isLoadingSchedule = false;

// Window configuration
let windowMins = 240; // 4 hours
const recentWindowHours = 36;
const recentStreamCount = 20;

// Geometry read from CSS vars so header + blocks NEVER drift
let tickMins = 30;
let pxPerTick = 140;
let pxPerMin = pxPerTick / tickMins;
let labelW = 220;

function readScheduleGeometryFromCss() {
  const cs = getComputedStyle(document.documentElement);

  const tickRaw = cs.getPropertyValue("--tickMins").trim();
  const pxTickRaw = cs.getPropertyValue("--pxPerTick").trim();
  const labelRaw = cs.getPropertyValue("--labelW").trim();

  const t = Number.parseFloat(tickRaw);
  const p = Number.parseFloat(pxTickRaw);
  const l = Number.parseFloat(labelRaw);

  if (Number.isFinite(t) && t > 0) tickMins = t;
  if (Number.isFinite(p) && p > 0) pxPerTick = p;
  if (Number.isFinite(l) && l > 0) labelW = l;

  pxPerMin = pxPerTick / tickMins;
}

// -------------------- Event end-time logic --------------------
// - Prefer explicit end_et if provided
// - Default: 2 hours from start
// - If LIVE: extend to max(start+2h, now+20m) so it stays visible while live
function eventEnd(e) {
  const end = parseET(e.end_et);
  if (end) return end;

  const start = getEventStart(e);
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

    const as = Number(a.subscribers || 0);
    const bs = Number(b.subscribers || 0);
    if (a.status === "live" && b.status === "live") {
      if (as !== bs) return bs - as;
    }

    const at = getEventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = getEventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;

    return bs - as;
  });
}

function rebuildFilters(events) {
  if (!platformFilter) return;

  const platforms = new Set();

  events.forEach((e) => {
    if (e.platform) platforms.add(e.platform);
  });

  const keepPlat = platformFilter.value;

  platformFilter.innerHTML =
    `<option value="all">All</option>` +
    [...platforms]
      .sort()
      .map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`)
      .join("");

  if ([...platforms].includes(keepPlat)) platformFilter.value = keepPlat;
}

function applyFilters() {
  const p = platformFilter ? platformFilter.value : "all";
  const q = searchInput ? searchInput.value.trim().toLowerCase() : "";

  filteredEvents = allEvents.filter((e) => {
    if (p !== "all" && (e.platform || "") !== p) return false;
    if (q) {
      const blob = `${e.title || ""} ${e.platform || ""} ${e.channel || ""}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  filteredEvents = sortEvents(filteredEvents);
  liveIndex = 0;

  renderNowNext();
  renderTodaysGuide();
  renderSchedule();
}

// -------------------- Hero cards --------------------
function renderCard(e, forceLiveBadge = false) {
  const start = getEventStart(e);
  const media = e.thumbnail_url
    ? `style="background-image:url('${encodeURI(e.thumbnail_url)}')"`
    : "";
  const live = forceLiveBadge || e.status === "live";
  const badge = live ? `<span class="pill live">LIVE</span>` : "";
  const subs = e.subscribers ? `${Number(e.subscribers).toLocaleString()} subs` : "";

  const watchUrl = escapeHtml(e.watch_url || "#");

  return `
  <div class="card${live ? " isLive" : ""}">
    <a class="cardMediaLink" href="${watchUrl}" target="_blank" rel="noreferrer">
      <div class="cardMedia" ${media}></div>
    </a>

    <div class="cardBody">
      <a class="cardTitleLink" href="${watchUrl}" target="_blank" rel="noreferrer">
        ${escapeHtml(e.title || "")}
      </a>
      <div class="cardMeta">
        <span>${fmtTime(start)}</span>
        <span>•</span>
        <span>${escapeHtml(e.platform || "")}</span>
        <span>•</span>
        <span>${escapeHtml(e.channel || "")}</span>
        ${subs ? `<span>•</span><span>${subs}</span>` : ""}
        ${badge ? `<span>•</span>${badge}</span>` : ""}
      </div>

      <div class="cardActions">
        <a class="watchBtn" href="${watchUrl}" target="_blank" rel="noreferrer">Watch</a>
      </div>
    </div>
  </div>
`;
}

function renderNowNext() {
  if (!nowOn || !upNext) return;

  const now = Date.now();
  const liveEvents = filteredEvents.filter((e) => e.status === "live");
  const upcoming = filteredEvents
    .filter((e) => {
      if (e.status === "live") return false;
      const start = getEventStart(e);
      return start ? start.getTime() >= now : false;
    })
    .sort(
      (a, b) =>
        (getEventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (getEventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER)
    )[0];
  const liveCount = liveEvents.length;
  const safeIndex = liveCount ? liveIndex % liveCount : 0;
  const live = liveEvents[safeIndex];

  if (liveNav) liveNav.classList.toggle("hidden", liveCount <= 1);
  if (liveCounter) liveCounter.textContent = liveCount ? `${safeIndex + 1} / ${liveCount}` : "";

  nowOn.innerHTML = live
    ? renderCard(live, true)
    : `<div class="muted">No live event right now.</div>`;

  upNext.innerHTML = upcoming
    ? renderCard(upcoming, false)
    : `<div class="muted">No upcoming events found.</div>`;
}

// -------------------- Recent streams --------------------
function getRecentStreams() {
  const now = Date.now();
  const cutoff = now - recentWindowHours * 60 * 60 * 1000;

  return allEvents.filter((e) => {
    const status = (e.status || "").toLowerCase();
    if (status === "live" || status === "upcoming" || status === "scheduled") return false;

    const start = getEventStart(e);
    if (!start) return false;
    const end = eventEnd(e);
    if (!end) return false;
    const startTs = start.getTime();
    const endTs = end.getTime();
    return startTs <= now && endTs >= cutoff && endTs <= now;
  });
}

function renderRecentStreams({ reshuffle = true } = {}) {
  if (!recentStreams) return;

  const recent = getRecentStreams();
  if (!recent.length) {
    if (recentStreamsMeta)
      recentStreamsMeta.textContent = `Past ${recentWindowHours} hours`;
    recentStreams.innerHTML = `<div class="muted">No recent live streams in the past ${recentWindowHours} hours.</div>`;
    if (recentNav) recentNav.classList.add("hidden");
    return;
  }

  if (reshuffle || recentEvents.length !== Math.min(recent.length, recentStreamCount)) {
    recentEvents = shuffleArray(recent).slice(0, recentStreamCount);
    recentIndex = 0;
  }

  const safeIndex = recentEvents.length ? recentIndex % recentEvents.length : 0;

  if (recentStreamsMeta)
    recentStreamsMeta.textContent = `${
      recentEvents.length ? `${recentEvents.length} streams • ` : ""
    }Past ${recentWindowHours} hours`;
  if (recentNav) recentNav.classList.toggle("hidden", recentEvents.length <= 1);
  if (recentCounter)
    recentCounter.textContent = recentEvents.length
      ? `${safeIndex + 1} / ${recentEvents.length}`
      : "";
  recentStreams.innerHTML = renderCard(
    recentEvents[safeIndex],
    recentEvents[safeIndex]?.status === "live"
  );
}

// -------------------- Right tile: Today’s Guide (full day) --------------------
function renderTodaysGuide() {
  if (!infoTileBody) return;
  if (infoTileHeaderH2) infoTileHeaderH2.textContent = "Today's Guide";

  const now = new Date();
  const dayStart = startOfDayZoned(now, ET_TZ).getTime();
  const dayEnd = endOfDayZoned(now, ET_TZ).getTime();

  const todays = filteredEvents
    .filter((e) => {
      const s = getEventStart(e);
      if (!s) return false;
      const st = s.getTime();
      return st >= dayStart && st <= dayEnd;
    })
    .sort((a, b) => (getEventStart(a)?.getTime() ?? 0) - (getEventStart(b)?.getTime() ?? 0));

  if (!todays.length) {
    infoTileBody.innerHTML = `<div class="muted">No events scheduled for today.</div>`;
    return;
  }

  const items = todays
    .map((e) => {
      const s = getEventStart(e);
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
      <div class="muted">Today • ${fmtDay(now, ET_TZ)} ET</div>
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

function ensureWindowStart() {
  if (windowStart) return;
  windowStart = roundToTick(new Date());
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
  const totalW = surfaceW + labelW;

  timeRow.style.display = "flex";
  timeRow.style.width = `${totalW}px`;
  timeRow.style.maxWidth = `${totalW}px`;
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
    const s = getEventStart(e);
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

  const totalW = surfaceW + labelW;
  rowsEl.style.width = `${totalW}px`;
  rowsEl.style.maxWidth = `${totalW}px`;

  rowsEl.innerHTML = rows
    .map((r) => {
      const subs = r.maxSubs ? `${Number(r.maxSubs).toLocaleString()} subs` : "";

      const blocks = r.list
        .map((e) => {
          const s = getEventStart(e);
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
              <a class="name"
   href="${escapeHtml(r.list[0]?.watch_url || "#")}"
   target="_blank"
   rel="noreferrer">
  ${escapeHtml(r.channel)}
</a>

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
  if (isLoadingSchedule) return;
  isLoadingSchedule = true;
  if (nowOn) nowOn.textContent = "Loading…";
  if (upNext) upNext.textContent = "Loading…";
  if (recentStreams) recentStreams.textContent = "Loading…";
  if (rowsEl) rowsEl.innerHTML = "";
  if (emptyState) emptyState.style.display = "none";

  try {
    const url = (CSV_URL || "").trim() ? CSV_URL : SCHEDULE_URL;
    const bust = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
    const res = await fetch(bust, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch schedule (${res.status})`);

    const rawText = await res.text();
    const data = parseScheduleData(rawText, Boolean((CSV_URL || "").trim()));
    if (!Array.isArray(data) || !data.length)
      throw new Error("Schedule data is missing or empty");

    const now = Date.now();
    const maxLiveAgeMs = MAX_LIVE_AGE_HOURS * 60 * 60 * 1000;
    const maxLiveFutureMs = MAX_LIVE_FUTURE_MINS * 60 * 1000;

    allEvents = sortEvents(
      data
        .filter((e) => e && e.watch_url && (e.start_et || e.status === "live"))
        .map((e) => {
          const rawStatus = String(e.status || "").trim().toLowerCase();
          let status = rawStatus || "upcoming";
          const start = parseET(e.start_et);
          const explicitEnd = parseET(e.end_et);
          let startOverride = null;

          if (!rawStatus && start) {
            const inferredEnd = explicitEnd || new Date(start.getTime() + 120 * 60000);
            if (start.getTime() <= now && inferredEnd.getTime() >= now) {
              status = "live";
            } else if (start.getTime() > now) {
              status = "upcoming";
            } else {
              status = "ended";
            }
          }

          if (status === "live") {
            if (start) {
              const startTs = start.getTime();
              if (startTs - now > maxLiveFutureMs) {
                startOverride = new Date(now);
              } else if (now - startTs > maxLiveAgeMs) {
                status = "ended";
              }
            } else {
              startOverride = new Date(now);
            }
          }

          return {
            ...e,
            status,
            platform: e.platform || "",
            channel: e.channel || "",
            thumbnail_url: e.thumbnail_url || "",
            subscribers: Number(e.subscribers || 0),
            start_override: startOverride,
          };
        })
    );

    rebuildFilters(allEvents);

    // IMPORTANT: default schedule window to NOW every refresh
    windowStart = null;

    const nowDate = new Date();
    if (lastUpdated)
      lastUpdated.textContent = `Last updated: ${fmtDay(nowDate)} ${fmtTime(nowDate)}`;

    applyFilters();
    renderRecentStreams();
  } finally {
    isLoadingSchedule = false;
  }
}

// -------------------- Wire up --------------------
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
on(livePrev, "click", () => {
  const liveCount = filteredEvents.filter((e) => e.status === "live").length;
  if (!liveCount) return;
  liveIndex = (liveIndex - 1 + liveCount) % liveCount;
  renderNowNext();
});
on(liveNext, "click", () => {
  const liveCount = filteredEvents.filter((e) => e.status === "live").length;
  if (!liveCount) return;
  liveIndex = (liveIndex + 1) % liveCount;
  renderNowNext();
});
on(recentPrev, "click", () => {
  if (!recentEvents.length) return;
  recentIndex = (recentIndex - 1 + recentEvents.length) % recentEvents.length;
  renderRecentStreams({ reshuffle: false });
});
on(recentNext, "click", () => {
  if (!recentEvents.length) return;
  recentIndex = (recentIndex + 1) % recentEvents.length;
  renderRecentStreams({ reshuffle: false });
});

// initial load
loadSchedule().catch((err) => {
  console.error(err);
  if (nowOn) nowOn.innerHTML = `<div class="muted">Error loading schedule.</div>`;
  if (upNext) upNext.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
});

setInterval(() => {
  loadSchedule().catch((err) => console.error(err));
}, 120000);
