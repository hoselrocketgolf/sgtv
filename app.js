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

function isYouTubeUrl(url) {
  if (!url) return false;
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function hasLiveThumbnail(url) {
  if (!url) return false;
  return /_live\.jpg(?:\?|$)/i.test(url);
}

function isPremiereEvent(e) {
  if (!e) return false;
  if (e.is_premiere === true || e.premiere === true || e.isPremiere === true) return true;
  const eventType = String(e.type || e.event_type || "").toLowerCase();
  if (eventType.includes("premiere")) return true;
  const status = (e?.status || "").toLowerCase();
  if (status.includes("premiere")) return true;
  const title = (e?.title || "").toLowerCase();
  if (title.includes("premiere")) return true;
  const watchUrl = (e?.watch_url || "").toLowerCase();
  return watchUrl.includes("premiere");
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
      source_id: "",
      status: status || "",
      thumbnail_url: thumbnailUrl,
      subscribers: subscribers ? Number(subscribers) : undefined,
    };
  });
}

function formatTime(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDay(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatDayLong(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function startOfDayZoned(date, timeZone) {
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
  return zonedTimeToUtcDate({
    Y: Number(parts.year),
    M: Number(parts.month),
    D: Number(parts.day),
    h: 0,
    m: 0,
  }, timeZone);
}

function endOfDayZoned(date, timeZone) {
  const start = startOfDayZoned(date, timeZone);
  return addMinutes(start, 24 * 60 - 1);
}

function eventEnd(e) {
  const end = parseET(e?.end_et);
  if (end) return end;
  const start = getEventStart(e);
  if (!start) return null;
  if (e?.status === "live") return addMinutes(start, 60);
  return addMinutes(start, 60);
}

function eventLengthMins(e) {
  const start = getEventStart(e);
  const end = eventEnd(e);
  if (!start || !end) return 0;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
}

function parseToLocalDate(str) {
  return parseET(str);
}

function fmtTime(date) {
  return date ? formatTime(date) : "";
}

function fmtDay(date) {
  return date ? formatDay(date) : "";
}

function fmtDayLong(date) {
  return date ? formatDayLong(date) : "";
}

function fmtClockTimeRange(start, end) {
  const st = fmtTime(start);
  const en = fmtTime(end);
  return st && en ? `${st} – ${en}` : "";
}

function statusToText(e) {
  if (!e?.status) return "";
  const s = e.status.toLowerCase();
  if (s === "live") return "LIVE";
  if (s === "upcoming" || s === "scheduled") return "UPCOMING";
  if (s === "ended") return "ENDED";
  return s.toUpperCase();
}

function statusToPillClass(e) {
  if (!e?.status) return "";
  const s = e.status.toLowerCase();
  if (s === "live") return "live";
  if (s === "upcoming" || s === "scheduled") return "upcoming";
  if (s === "ended") return "ended";
  return "";
}

function fmtSubs(n) {
  if (!n || !Number.isFinite(n)) return "";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M subs`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K subs`;
  return `${n} subs`;
}

function renderCard(e, live = false) {
  if (!e) return "";
  const start = getEventStart(e);
  const end = eventEnd(e);
  const timeRange = fmtClockTimeRange(start, end);
  const timeText = timeRange || fmtTime(start);
  const subText = e.status ? statusToText(e) : "";
  const subs = fmtSubs(e.subscribers);
  const thumb = e.thumbnail_url ? e.thumbnail_url : "";
  const hasThumb = thumb && !thumb.includes("undefined");
  const media = hasThumb
    ? `style="background-image:url('${thumb}');"`
    : "";
  const watchUrl = e.watch_url || "#";
  const badge = live ? `<span class="pill live">LIVE</span>` : "";

  return `
  <div class="card ${live ? "cardLive" : ""}">
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
    if (isPremiereEvent(e)) return false;

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
  const nowTs = now.getTime();
  const dayStart = startOfDayZoned(now, ET_TZ).getTime();
  const dayEnd = endOfDayZoned(now, ET_TZ).getTime();

  const todays = filteredEvents
    .filter((e) => {
      const s = getEventStart(e);
      if (!s) return false;
      const st = s.getTime();
      if (st < dayStart || st > dayEnd) return false;
      if (e.status === "live") return true;
      const end = eventEnd(e)?.getTime();
      if (!Number.isFinite(end)) return st >= nowTs;
      return end >= nowTs;
    })
    .sort((a, b) => (getEventStart(a)?.getTime() ?? 0) - (getEventStart(b)?.getTime() ?? 0));

  if (!todays.length) {
    infoTileBody.innerHTML = `<div class="muted">No events left today.</div>`;
    return;
  }

  const items = todays.map((e) => {
    const start = getEventStart(e);
    const end = eventEnd(e);
    const isLive = e.status === "live";
    const badge = isLive ? `<span class="chipBadge">LIVE</span>` : "";
    return `
      <div class="listRow">
        <div class="listTime">${fmtTime(start)}</div>
        <div class="listTitle">
          <div class="titleRow">
            <span>${escapeHtml(e.title || "")}</span>
            ${badge}
          </div>
          <div class="listMeta">
            <span>${escapeHtml(e.platform || "")}</span>
            <span>•</span>
            <span>${escapeHtml(e.channel || "")}</span>
          </div>
        </div>
      </div>
    `;
  });

  infoTileBody.innerHTML = items.join("");
}

// -------------------- Schedule table --------------------
const TIMESLOTS = [
  "12a",
  "1a",
  "2a",
  "3a",
  "4a",
  "5a",
  "6a",
  "7a",
  "8a",
  "9a",
  "10a",
  "11a",
  "12p",
  "1p",
  "2p",
  "3p",
  "4p",
  "5p",
  "6p",
  "7p",
  "8p",
  "9p",
  "10p",
  "11p",
];

function fmtSlotLabel(date) {
  const label = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return label.replace(":00", "").toLowerCase();
}

function getSlotStart(date, slotIndex) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(slotIndex * 60);
  return d;
}

function getSlotStartIndex(date) {
  const h = date.getHours();
  return h;
}

function getSlotForEvent(date) {
  return getSlotStartIndex(date);
}

function renderTimeRow() {
  if (!timeRow) return;
  const now = new Date();
  const row = TIMESLOTS.map((slot, idx) => {
    const date = new Date();
    date.setHours(idx, 0, 0, 0);
    const isNow = idx === now.getHours();
    return `<div class="timeCell ${isNow ? "timeNow" : ""}">${slot}</div>`;
  });
  timeRow.innerHTML = row.join("");
}

function renderScheduleRows() {
  if (!rowsEl) return;

  const now = new Date();
  const nowTs = now.getTime();

  const eventsByDay = {};
  for (const e of filteredEvents) {
    const start = getEventStart(e);
    if (!start) continue;
    const dateKey = start.toISOString().slice(0, 10);
    if (!eventsByDay[dateKey]) eventsByDay[dateKey] = [];
    eventsByDay[dateKey].push(e);
  }

  const dates = Object.keys(eventsByDay).sort();
  if (!dates.length) {
    rowsEl.innerHTML = "";
    if (emptyState) emptyState.classList.remove("hidden");
    return;
  }
  if (emptyState) emptyState.classList.add("hidden");

  const rows = dates.map((dateKey) => {
    const events = eventsByDay[dateKey].sort(
      (a, b) => (getEventStart(a)?.getTime() ?? 0) - (getEventStart(b)?.getTime() ?? 0)
    );
    const dayStart = new Date(dateKey + "T00:00:00");
    const label = fmtDayLong(dayStart);

    const cards = events.map((e) => {
      const start = getEventStart(e);
      const end = eventEnd(e);
      const durationMins = eventLengthMins(e);

      const startSlot = getSlotForEvent(start);
      const width = Math.max(1, Math.round((durationMins / 60) * 100));
      const left = Math.round((startSlot / 24) * 100);

      const statusClass = statusToPillClass(e);
      const statusText = statusToText(e);
      const liveBadge = e.status === "live" ? `<span class="badgeLive">LIVE</span>` : "";

      return `
        <div class="eventBlock ${statusClass}" style="left:${left}%;width:${width}%">
          <div class="eventTime">${fmtClockTimeRange(start, end)}</div>
          <div class="eventTitle">
            ${liveBadge}
            <span>${escapeHtml(e.title || "")}</span>
          </div>
          <div class="eventMeta">
            <span>${escapeHtml(e.platform || "")}</span>
            <span>•</span>
            <span>${escapeHtml(e.channel || "")}</span>
            ${statusText ? `<span>•</span><span>${statusText}</span>` : ""}
          </div>
        </div>
      `;
    });

    return `
      <div class="dayRow">
        <div class="dayLabel">${label}</div>
        <div class="dayEvents">${cards.join("")}</div>
      </div>
    `;
  });

  rowsEl.innerHTML = rows.join("");
}

// -------------------- Data pipeline --------------------
let allEvents = [];
let filteredEvents = [];
let liveIndex = 0;
let recentIndex = 0;
let recentEvents = [];

const recentWindowHours = 36;
const recentStreamCount = 20;

function applyFilters() {
  const platform = platformFilter?.value?.toLowerCase().trim() || "";
  const q = searchInput?.value?.toLowerCase().trim() || "";

  filteredEvents = allEvents.filter((e) => {
    if (platform && (e.platform || "").toLowerCase() !== platform) return false;
    if (q) {
      const inTitle = (e.title || "").toLowerCase().includes(q);
      const inChannel = (e.channel || "").toLowerCase().includes(q);
      const inLeague = (e.league || "").toLowerCase().includes(q);
      if (!inTitle && !inChannel && !inLeague) return false;
    }
    return true;
  });
}

function filterLiveEvents() {
  const now = Date.now();
  const maxAge = now - MAX_LIVE_AGE_HOURS * 60 * 60 * 1000;
  const maxFuture = now + MAX_LIVE_FUTURE_MINS * 60 * 1000;
  return filteredEvents.filter((e) => {
    const status = (e.status || "").toLowerCase();
    if (status !== "live") return false;
    const start = getEventStart(e);
    if (!start) return false;
    const ts = start.getTime();
    return ts >= maxAge && ts <= maxFuture;
  });
}

function renderLive() {
  if (!nowOn) return;
  const liveEvents = filterLiveEvents();

  if (!liveEvents.length) {
    nowOn.innerHTML = `<div class="muted">No live event right now.</div>`;
    if (liveNav) liveNav.classList.add("hidden");
    if (liveCounter) liveCounter.textContent = "";
    return;
  }

  if (liveIndex >= liveEvents.length) liveIndex = 0;

  const live = liveEvents[liveIndex];

  nowOn.innerHTML = renderCard(live, true);
  if (liveCounter) liveCounter.textContent = `${liveIndex + 1} / ${liveEvents.length}`;
  if (liveNav) liveNav.classList.toggle("hidden", liveEvents.length <= 1);
}

function renderUpNext() {
  if (!upNext) return;

  const now = Date.now();
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

  upNext.innerHTML = upcoming
    ? renderCard(upcoming, false)
    : `<div class="muted">No upcoming events found.</div>`;
}

function renderBottomSchedule() {
  renderTimeRow();
  renderScheduleRows();
}

function renderAll() {
  applyFilters();
  renderLive();
  renderUpNext();
  renderRecentStreams({ reshuffle: false });
  renderTodaysGuide();
  renderBottomSchedule();
}

function updateLastUpdated(ts) {
  if (!lastUpdated) return;
  const date = new Date(ts);
  lastUpdated.textContent = `Updated ${date.toLocaleString()}`;
}

function normalizeEvent(e) {
  const start = parseET(e.start_et);
  const end = parseET(e.end_et);

  const status = (e.status || "").toLowerCase();
  if (status === "live" && start) {
    const now = Date.now();
    const startTs = start.getTime();
    const maxFuture = now + MAX_LIVE_FUTURE_MINS * 60 * 1000;
    if (startTs > maxFuture) e.status = "upcoming";
  }

  if (status === "upcoming" || status === "scheduled") {
    if (start && start.getTime() <= Date.now()) {
      e.status = "live";
    }
  }

  if (status === "ended") {
    if (end && end.getTime() > Date.now()) {
      e.status = "live";
    }
  }

  if (!e.thumbnail_url && isYouTubeUrl(e.watch_url)) {
    e.thumbnail_url = `https://i.ytimg.com/vi/${e.source_id}/hqdefault.jpg`;
  }

  return e;
}

async function fetchJsonSchedule() {
  const res = await fetch(SCHEDULE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load schedule.json");
  return res.json();
}

async function fetchCsvSchedule() {
  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load CSV");
  return res.text();
}

async function loadSchedule() {
  try {
    if (recentStreams) recentStreams.textContent = "Loading…";
    if (nowOn) nowOn.textContent = "Loading…";
    if (upNext) upNext.textContent = "Loading…";

    let events = [];
    if (CSV_URL) {
      const csvText = await fetchCsvSchedule();
      events = csvRowsToEvents(csvText);
    } else {
      events = await fetchJsonSchedule();
    }

    events = events.map(normalizeEvent);
    allEvents = events;
    renderAll();
    updateLastUpdated(Date.now());
  } catch (err) {
    if (recentStreams)
      recentStreams.innerHTML = `<div class="muted">Failed to load schedule.</div>`;
    if (nowOn) nowOn.innerHTML = `<div class="muted">Failed to load schedule.</div>`;
    if (upNext) upNext.innerHTML = `<div class="muted">Failed to load schedule.</div>`;
    if (rowsEl) rowsEl.innerHTML = "";
    if (emptyState) emptyState.classList.remove("hidden");
    console.error(err);
  }
}

// -------------------- Event listeners --------------------
on(platformFilter, "change", () => {
  renderAll();
});

on(searchInput, "input", () => {
  renderAll();
});

on(refreshBtn, "click", () => {
  loadSchedule();
});

on(livePrev, "click", () => {
  const liveEvents = filterLiveEvents();
  if (!liveEvents.length) return;
  liveIndex = (liveIndex - 1 + liveEvents.length) % liveEvents.length;
  renderLive();
});

on(liveNext, "click", () => {
  const liveEvents = filterLiveEvents();
  if (!liveEvents.length) return;
  liveIndex = (liveIndex + 1) % liveEvents.length;
  renderLive();
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

loadSchedule();
