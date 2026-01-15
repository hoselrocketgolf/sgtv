import os, re, json, time, csv, io
from datetime import datetime
from zoneinfo import ZoneInfo
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

ET_TZ = ZoneInfo("America/New_York")

CHANNEL_SHEET_CSV = os.environ.get(
    "CHANNEL_SHEET_CSV",
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv"
)
OUT_PATH = os.environ.get("OUT_PATH", "schedule.json")

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/1.0)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

# ---------- HTTP ----------
def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def safe_get(url: str) -> tuple[str, str]:
    """
    Returns (final_url, html). urllib follows redirects automatically.
    """
    req = urllib.request.Request(url, headers=REQ_HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        final_url = resp.geturl()
        html = resp.read().decode("utf-8", errors="ignore")
        return final_url, html

# ---------- CSV ----------
def parse_simple_csv(text: str):
    f = io.StringIO(text)
    return list(csv.DictReader(f))

def load_channels_from_sheet():
    """
    Sheet headers expected:
      handle, display_name, channel_id, subscribers
    """
    csv_text = http_get(CHANNEL_SHEET_CSV)
    rows = parse_simple_csv(csv_text)

    if not rows:
        return []

    print("Sheet headers:", list(rows[0].keys()))

    channels = []
    for r in rows:
        cid = (r.get("channel_id") or "").strip()
        if not cid:
            continue

        handle = (r.get("handle") or "").strip().lstrip("@")
        display = (r.get("display_name") or "").strip()

        sub_raw = (r.get("subscribers") or "").strip().replace(",", "")
        try:
            sheet_subs = int(float(sub_raw)) if sub_raw else 0
        except Exception:
            sheet_subs = 0

        channels.append({
            "channel_id": cid,
            "handle": handle,
            "display_name": display,
            "sheet_subscribers": sheet_subs
        })

    return channels

# ---------- Time ----------
def iso_to_et_fmt(iso: str) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

def now_et_fmt() -> str:
    return datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")

# ---------- RSS ----------
def fetch_rss(channel_id: str):
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    xml_text = http_get(url)
    root = ET.fromstring(xml_text)

    ns = {
        "atom": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
        "media": "http://search.yahoo.com/mrss/",
    }

    entries = []
    for entry in root.findall("atom:entry", ns):
        vid = entry.findtext("yt:videoId", default="", namespaces=ns)
        title = entry.findtext("atom:title", default="", namespaces=ns)

        link_el = entry.find("atom:link", ns)
        link = link_el.attrib.get("href", "") if link_el is not None else ""

        published = entry.findtext("atom:published", default="", namespaces=ns)
        author_name = entry.findtext("atom:author/atom:name", default="", namespaces=ns)

        thumb = ""
        thumb_el = entry.find("media:group/media:thumbnail", ns)
        if thumb_el is not None:
            thumb = thumb_el.attrib.get("url", "") or ""

        if vid and link:
            entries.append({
                "video_id": vid,
                "title": title,
                "watch_url": link,
                "published": published,
                "channel": author_name,
                "thumbnail_url": thumb
            })

    entries.sort(key=lambda x: x.get("published", ""), reverse=True)
    return entries[:80]

# ---------- Watch page (video status) ----------
def fetch_video_details(video_id: str):
    """
    Returns:
      {"status": "live"/"upcoming", "start_et": "...", "end_et": "..."}
    or None.
    """
    html = http_get(f"https://www.youtube.com/watch?v={video_id}")

    # If YouTube serves a consent / blocked page, this catches it in logs
    if "consent.youtube.com" in html.lower() or "before you continue" in html.lower():
        print("WARN: Consent/blocked page for watch:", video_id)
        return None

    # LIVE NOW check (raw or escaped)
    live_now = (
        '"isLiveNow":true' in html
        or '\\"isLiveNow\\":true' in html
        or 'isLiveNow\\":true' in html
        or "isLiveNow\":true" in html
    )
    upcoming = (
        '"isUpcoming":true' in html
        or '\\"isUpcoming\\":true' in html
        or "upcomingEventData" in html
    )

    # start / end timestamps (often present for both live and upcoming)
    m_start = re.search(r'"startTimestamp":"([^"]+)"', html)
    m_end = re.search(r'"endTimestamp":"([^"]+)"', html)

    start_ts = m_start.group(1) if m_start else ""
    end_ts = m_end.group(1) if m_end else ""

    if live_now:
        return {
            "status": "live",
            "start_et": iso_to_et_fmt(start_ts) if start_ts else now_et_fmt(),
            "end_et": iso_to_et_fmt(end_ts) if end_ts else ""
        }

    if upcoming and start_ts:
        return {
            "status": "upcoming",
            "start_et": iso_to_et_fmt(start_ts),
            "end_et": iso_to_et_fmt(end_ts) if end_ts else ""
        }

    return None

# ---------- Channel LIVE discovery ----------
def extract_video_id_candidates(html: str) -> list[str]:
    """
    Pull possible videoIds from channel pages.
    We return multiple; caller confirms via fetch_video_details(...).
    """
    cands = []

    # canonical watch url
    m = re.search(r'rel="canonical"\s+href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{6,})"', html)
    if m:
        cands.append(m.group(1))

    # urlCanonical inside JSON
    m = re.search(r'"urlCanonical":"https:\\/\\/www\\.youtube\\.com\\/watch\\?v=([A-Za-z0-9_-]{6,})"', html)
    if m:
        cands.append(m.group(1))

    # watchEndpoint videoId (common)
    for mm in re.finditer(r'"watchEndpoint":\{"videoId":"([A-Za-z0-9_-]{6,})"', html):
        cands.append(mm.group(1))

    # escaped watchEndpoint
    for mm in re.finditer(r'\\"watchEndpoint\\":\{\\"videoId\\":\\"([A-Za-z0-9_-]{6,})\\"', html):
        cands.append(mm.group(1))

    # de-dupe preserve order
    out = []
    seen = set()
    for v in cands:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out

def fetch_channel_live_video_id(channel_id: str, handle: str = "") -> str:
    """
    Goal: find a candidate video id from channel pages, then CONFIRM it's live.
    This avoids /live redirect lying.
    """
    h = (handle or "").strip().lstrip("@")

    urls = []
    if h:
        urls.extend([
            f"https://www.youtube.com/@{h}/live",
            f"https://www.youtube.com/@{h}/streams",
            f"https://www.youtube.com/@{h}/streams?live_view=501",
            f"https://www.youtube.com/@{h}",
        ])
    urls.extend([
        f"https://www.youtube.com/channel/{channel_id}/live",
        f"https://www.youtube.com/channel/{channel_id}/streams",
        f"https://www.youtube.com/channel/{channel_id}/streams?live_view=501",
        f"https://www.youtube.com/channel/{channel_id}",
    ])

    checked = set()

    for url in urls:
        try:
            final_url, html = safe_get(url)
        except Exception:
            continue

        # If redirect URL has ?v=..., try it too
        m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", final_url)
        if m:
            vid = m.group(1)
            if vid not in checked:
                checked.add(vid)
                time.sleep(0.2)
                d = fetch_video_details(vid)
                if d and d.get("status") == "live":
                    return vid

        # Otherwise pull candidates from the HTML
        cands = extract_video_id_candidates(html)
        for vid in cands[:12]:  # don't go crazy
            if vid in checked:
                continue
            checked.add(vid)
            time.sleep(0.2)
            d = fetch_video_details(vid)
            if d and d.get("status") == "live":
                return vid

    return ""

# ---------- Subscribers (best effort) ----------
def parse_subscribers_to_int(text: str) -> int:
    if not text:
        return 0
    t = text.lower().replace("subscribers", "").replace("subscriber", "").strip()
    t = t.replace(",", "").replace(" ", "")
    m = re.search(r"([0-9]*\.?[0-9]+)([km]?)", t)
    if not m:
        return 0
    num = float(m.group(1))
    suf = m.group(2)
    if suf == "k":
        return int(num * 1000)
    if suf == "m":
        return int(num * 1000000)
    return int(num)

def scrape_subscribers_from_html(html: str) -> int:
    patterns = [
        r'"subscriberCountText":\{"simpleText":"([^"]+)"\}',
        r'"subscriberCountText":\{"runs":\[\{"text":"([^"]+)"\}\]\}',
        r'"metadataParts".*?"text":"([^"]*subscribers[^"]*)"',
        r'([0-9][0-9\.,]*\s*[KM]?)\s+subscribers',
    ]
    for pat in patterns:
        m = re.search(pat, html, re.DOTALL | re.IGNORECASE)
        if m:
            return parse_subscribers_to_int(m.group(1) if m.groups() else m.group(0))
    return 0

def fetch_channel_subscribers(channel_id: str, handle: str = "", sheet_fallback: int = 0) -> int:
    h = (handle or "").strip().lstrip("@")
    urls = []
    if h:
        urls.append(f"https://www.youtube.com/@{h}/about")
        urls.append(f"https://www.youtube.com/@{h}")
    urls.append(f"https://www.youtube.com/channel/{channel_id}/about")
    urls.append(f"https://www.youtube.com/channel/{channel_id}")

    for u in urls:
        try:
            html = http_get(u)
            subs = scrape_subscribers_from_html(html)
            if subs > 0:
                # sanity: if scrape returns tiny junk (like 1-9) but sheet has real value, prefer sheet
                if subs < 10 and sheet_fallback >= 10:
                    return sheet_fallback
                return subs
        except Exception:
            continue

    return sheet_fallback if sheet_fallback > 0 else 0

# ---------- Main ----------
def main():
    channels = load_channels_from_sheet()
    if not channels:
        raise SystemExit("No channels found in channel sheet CSV (check headers + publish link).")

    print("Loaded channels from sheet:", len(channels))
    print("Channel IDs:", [c["channel_id"] for c in channels])
    print("-----")

    events = []
    seen = set()

    for ch in channels:
        cid = ch["channel_id"]
        handle = (ch.get("handle") or "").strip().lstrip("@")
        sheet_name = (ch.get("display_name") or "").strip()
        sheet_subs = int(ch.get("sheet_subscribers") or 0)

        subs = fetch_channel_subscribers(cid, handle, sheet_fallback=sheet_subs)

        display_name = sheet_name or (f"@{handle}" if handle else "")

        print("Channel:", cid, "handle:", handle, "name:", display_name, "subs:", subs)

        # 1) CURRENT LIVE (unscheduled)
        live_vid = fetch_channel_live_video_id(cid, handle)
        if not live_vid:
            print("No LIVE detected right now.")
        else:
            print("LIVE detected:", live_vid)

        if live_vid and live_vid not in seen:
            time.sleep(0.25)
            details = fetch_video_details(live_vid)
            print("LIVE details:", details)

            if details and details.get("status") == "live":
                seen.add(live_vid)
                events.append({
                    "start_et": details.get("start_et", ""),
                    "end_et": details.get("end_et", ""),
                    "title": "LIVE (unscheduled)",
                    "league": "",
                    "platform": "YouTube",
                    "channel": display_name,
                    "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                    "source_id": live_vid,
                    "status": "live",
                    "thumbnail_url": f"https://i.ytimg.com/vi/{live_vid}/hqdefault.jpg",
                    "subscribers": subs,
                })

        # 2) UPCOMING/LIVE from RSS (scheduled streams often show here)
        feed = fetch_rss(cid)
        for item in feed:
            vid = item["video_id"]
            if vid in seen:
                continue

            time.sleep(0.25)
            details = fetch_video_details(vid)
            if not details:
                # useful debug
                print("Skipped (no live/upcoming):", item.get("title", ""), item.get("watch_url", ""))
                continue

            seen.add(vid)

            yt_name = (item.get("channel") or "").strip()
            final_name = display_name or yt_name or ""

            events.append({
                "start_et": details.get("start_et", ""),
                "end_et": details.get("end_et", ""),
                "title": item.get("title", ""),
                "league": "",
                "platform": "YouTube",
                "channel": final_name,
                "watch_url": item.get("watch_url", ""),
                "source_id": vid,
                "status": details.get("status", ""),
                "thumbnail_url": item.get("thumbnail_url", "") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "subscribers": subs,
            })

        print("-----")

    # ensure thumbs
    for e in events:
        if not e.get("thumbnail_url") and e.get("source_id"):
            e["thumbnail_url"] = f"https://i.ytimg.com/vi/{e['source_id']}/hqdefault.jpg"

    # Sort: LIVE first, then soonest start, tie-break subs desc
    def sort_key(e):
        live_rank = 0 if (e.get("status") == "live") else 1
        start = e.get("start_et") or "9999-99-99 99:99"
        subs = int(e.get("subscribers") or 0)
        return (live_rank, start, -subs)

    events.sort(key=sort_key)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"Wrote {len(events)} events to {OUT_PATH}")

if __name__ == "__main__":
    main()
