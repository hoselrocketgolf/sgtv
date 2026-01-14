/*
  SimGolf TV Guide — lightweight static site
  Data source: published Google Sheet as CSV

  If you change the sheet, update CSV_URL below.
*/

const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vS2AzHxr-DjpaPOEsmXMTmoLmEulbqeBEwJBMDv9tykp0xK_3Gl5jtsUlAQTxGlzQOaFr99FgiOUBFf/pub?gid=0&single=true&output=csv";

const { DateTime } = luxon;
const TZ = "America/New_York";

// ---- Helpers: CSV parsing (handles quotes/commas) ----
function parseCSV(text){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    const next = text[i+1];

    if (c === '"'){
      if (inQuotes && next === '"'){ field += '"'; i++; }
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (c === ',' && !inQuotes){
      row.push(field); field = ""; continue;
    }
    if ((c === '\n' || c === '\r') && !inQuotes){
      if (c === '\r' && next === '\n') i++;
      row.push(field); field = "";
      // ignore completely empty trailing line
      if (row.some(v => (v ?? "").trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some(v => (v ?? "").trim() !== "")) rows.push(row);
  return rows;
}

function norm(s){ return (s ?? "").toString().trim(); }
function normKey(s){ return norm(s).toLowerCase().replace(/\s+/g, "_"); }

function pickKey(headers, candidates){
  const set = new Set(headers);
  for (const c of candidates){
    if (set.has(c)) return c;
  }
  return null;
}

function parseDateET(value){
  const v = norm(value);
  if (!v) return null;

  // Try ISO first
  let dt = DateTime.fromISO(v, { zone: TZ });
  if (dt.isValid) return dt;

  // Common formats
  const formats = [
    "yyyy-LL-dd HH:mm",
    "yyyy-LL-dd H:mm",
    "M/d/yyyy H:mm",
    "M/d/yyyy HH:mm",
    "LLL d, yyyy h:mm a",
    "LLL d, yyyy hh:mm a",
    "LLL d yyyy h:mm a",
    "LLL d yyyy hh:mm a",
  ];

  for (const f of formats){
    dt = DateTime.fromFormat(v, f, { zone: TZ });
    if (dt.isValid) return dt;
  }
  return null;
}

function fmtTime(dt){
  return dt.setZone(TZ).toFormat("h:mm a");
}

function fmtDate(dt){
  return dt.setZone(TZ).toFormat("ccc, LLL d");
}

function escapeHtml(s){
  return norm(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ---- UI ----
const leagueFilter = document.getElementById("leagueFilter");
const platformFilter = document.getElementById("platformFilter");
const searchBox = document.getElementById("searchBox");
const refreshBtn = document.getElementById("refreshBtn");

const nowBody = document.getElementById("nowBody");
const nextBody = document.getElementById("nextBody");
const nowPill = document.getElementById("nowPill");

const scheduleCards = document.getElementById("scheduleCards");
const emptyMsg = document.getElementById("emptyMsg");
const lastUpdated = document.getElementById("lastUpdated");

let allEvents = [];

function buildOption(selectEl, values){
  const current = selectEl.value;
  // remove everything but first option
  while (selectEl.options.length > 1) selectEl.remove(1);
  [...values].sort((a,b)=>a.localeCompare(b)).forEach(v=>{
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });
  // restore if still valid
  if ([...selectEl.options].some(o=>o.value===current)) selectEl.value = current;
}

function setCard(el, evt, label){
  if (!evt){
    el.innerHTML = `<p class="muted">No ${label.toLowerCase()} event.</p>`;
    return;
  }
  const start = evt.start;
  const end = evt.end;
  const timeLine = end ? `${fmtTime(start)}–${fmtTime(end)} ET` : `${fmtTime(start)} ET`;
  const subLine = `${fmtDate(start)} • ${escapeHtml(evt.league || "—")} • ${escapeHtml(evt.platform || "—")}`;
  const watch = evt.watch_url ? `<a href="${evt.watch_url}" target="_blank" rel="noopener">Watch</a>` : `<span class="muted">No link</span>`;
  el.innerHTML = `
    <div class="title" style="font-weight:800;font-size:15px;margin-bottom:6px;">${escapeHtml(evt.title || "Untitled")}</div>
    <div class="muted" style="margin-bottom:10px;">${timeLine}</div>
    <div class="muted small" style="margin-bottom:10px;">${subLine}${evt.channel ? ` • ${escapeHtml(evt.channel)}` : ""}</div>
    <div class="watch">${watch}</div>
  `;
}

function computeNowNext(events){
  const now = DateTime.now().setZone(TZ);

  // Sort by start time
  const sorted = [...events].sort((a,b)=>a.start.toMillis()-b.start.toMillis());

  // Determine "live" if within [start, end] or within 2h of start if no end
  const live = sorted.filter(e=>{
    if (!e.start) return false;
    const end = e.end ?? e.start.plus({ hours: 2 });
    return now >= e.start && now <= end;
  }).sort((a,b)=>a.start.toMillis()-b.start.toMillis());

  const upcoming = sorted.filter(e=>e.start && e.start > now).sort((a,b)=>a.start.toMillis()-b.start.toMillis());

  const nowEvt = live[0] || null;
  const nextEvt = upcoming[0] || (nowEvt ? upcoming[0] : null);

  return { nowEvt, nextEvt, isLive: !!nowEvt };
}

function rowMatchesFilters(evt){
  const lf = leagueFilter.value;
  const pf = platformFilter.value;
  const q = norm(searchBox.value).toLowerCase();

  if (lf && norm(evt.league) !== lf) return false;
  if (pf && norm(evt.platform) !== pf) return false;

  if (q){
    const hay = [
      evt.title, evt.league, evt.platform, evt.channel
    ].map(x=>norm(x).toLowerCase()).join(" ");
    if (!hay.includes(q)) return false;
  }
  return true;
}

function render(){
  const filtered = allEvents.filter(rowMatchesFilters);

  // Cards (Now / Next) computed from filtered set so filters affect the view
  const { nowEvt, nextEvt, isLive } = computeNowNext(filtered);
  nowPill.hidden = !isLive;

  setCard(nowBody, nowEvt, "Now");
  setCard(nextBody, nextEvt, "Next");

 // Schedule cards: show today's items from filtered
const now = DateTime.now().setZone(TZ);
const startOfDay = now.startOf("day");
const endOfDay = now.endOf("day");

const todays = filtered
  .filter(e => e.start && e.start >= startOfDay && e.start <= endOfDay)
  .sort((a,b)=>a.start.toMillis()-b.start.toMillis());

scheduleCards.innerHTML = "";

if (todays.length === 0){
  emptyMsg.hidden = false;
  scheduleCards.innerHTML = `<div class="muted">No events scheduled for today with current filters.</div>`;
  return;
}

emptyMsg.hidden = true;

todays.forEach(evt => {
  const now = DateTime.now().setZone(TZ);
  const end = evt.end ?? evt.start.plus({ hours: 2 });
  const isLive = now >= evt.start && now <= end;

  const card = document.createElement("div");
  card.className = `eventCard ${isLive ? "live" : ""}`;

  const timeLine = evt.end
    ? `${fmtTime(evt.start)}–${fmtTime(evt.end)} ET`
    : `${fmtTime(evt.start)} ET`;

  const watch = evt.watch_url
    ? `<a href="${evt.watch_url}" target="_blank" rel="noopener">Watch</a>`
    : `<span class="muted">No link</span>`;

  card.innerHTML = `
    <div class="eventTime">${escapeHtml(timeLine)}</div>
    <div class="eventTitle">${escapeHtml(evt.title || "Untitled")}</div>
    <div class="eventMeta">
      ${isLive ? `<span class="metaPill live">LIVE</span>` : ``}
      ${evt.league ? `<span class="metaPill">${escapeHtml(evt.league)}</span>` : ``}
      ${evt.platform ? `<span class="metaPill">${escapeHtml(evt.platform)}</span>` : ``}
      ${evt.channel ? `<span class="metaPill">${escapeHtml(evt.channel)}</span>` : ``}
    </div>
    <div class="eventActions">${watch}</div>
  `;

  scheduleCards.appendChild(card);
});

  }
}

async function load(){
scheduleCards.innerHTML = `<div class="muted">Loading…</div>`;
  emptyMsg.hidden = true;

  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load CSV (${res.status})`);
  const text = await res.text();

  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error("CSV has no data rows.");

  const headersRaw = rows[0].map(normKey);
  const headerIndex = new Map(headersRaw.map((h,i)=>[h,i]));

  // Candidate header names (case-insensitive normalized)
  const startKey = pickKey(headersRaw, ["start_et","start","start_time","start_time_et","datetime","time","starttime"]);
  const endKey   = pickKey(headersRaw, ["end_et","end","end_time","end_time_et","endtime"]);
  const titleKey = pickKey(headersRaw, ["title","event","name","match","program"]);
  const leagueKey= pickKey(headersRaw, ["league","tour","series","org"]);
  const platKey  = pickKey(headersRaw, ["platform","site","service"]);
  const chanKey  = pickKey(headersRaw, ["channel","creator","host"]);
  const urlKey   = pickKey(headersRaw, ["watch_url","url","link","watch","stream_url","stream"]);

  // Parse events
  const events = [];
  for (let r = 1; r < rows.length; r++){
    const row = rows[r];
    const get = (k) => (k && headerIndex.has(k)) ? norm(row[headerIndex.get(k)]) : "";

    const startRaw = get(startKey);
    const endRaw = get(endKey);

    const start = parseDateET(startRaw);
    const end = parseDateET(endRaw);

    // Skip rows without a parsable start time (keeps table clean)
    if (!start) continue;

    events.push({
      start, end,
      title: get(titleKey),
      league: get(leagueKey),
      platform: get(platKey),
      channel: get(chanKey),
      watch_url: get(urlKey),
      _raw: row
    });
  }

  allEvents = events;

  // Populate filters
  const leagues = new Set(allEvents.map(e=>norm(e.league)).filter(Boolean));
  const plats = new Set(allEvents.map(e=>norm(e.platform)).filter(Boolean));
  buildOption(leagueFilter, leagues);
  buildOption(platformFilter, plats);

  lastUpdated.textContent = `Last updated: ${DateTime.now().setZone(TZ).toFormat("LLL d, yyyy h:mm a")} ET`;

  render();
}

function wire(){
  leagueFilter.addEventListener("change", render);
  platformFilter.addEventListener("change", render);
  searchBox.addEventListener("input", () => {
    // tiny debounce
    window.clearTimeout(window.__qT);
    window.__qT = window.setTimeout(render, 120);
  });
  refreshBtn.addEventListener("click", () => {
    refreshBtn.textContent = "Updating…";
    refreshBtn.disabled = true;
    load()
      .catch(err => {
        alert(err.message);
        console.error(err);
      })
      .finally(()=>{
        refreshBtn.textContent = "Update";
        refreshBtn.disabled = false;
      });
  });

  // Optional auto-refresh every 5 minutes
  setInterval(()=>load().catch(()=>{}), 5 * 60 * 1000);
}

wire();
load().catch(err => {
  nowBody.innerHTML = `<p class="muted">Could not load schedule.</p><p class="muted small">${escapeHtml(err.message)}</p>`;
  nextBody.innerHTML = `<p class="muted">—</p>`;
  scheduleBody.innerHTML = `<tr><td colspan="5" class="muted">Could not load schedule: ${escapeHtml(err.message)}</td></tr>`;
  console.error(err);
});
