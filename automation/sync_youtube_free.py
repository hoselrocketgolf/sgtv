import os, re, json, time, csv, io
from datetime import datetime
from zoneinfo import ZoneInfo
import urllib.request
import xml.etree.ElementTree as ET

ET_TZ = ZoneInfo("America/New_York")

CHANNEL_SHEET_CSV = os.environ.get(
    "CHANNEL_SHEET_CSV",
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv"
)
OUT_PATH = os.environ.get("OUT_PATH", "schedule.json")

MAX_RSS_ENTRIES_PER_CHANNEL = int(os.environ.get("MAX_RSS_ENTRIES_PER_CHANNEL", "18"))
SLEEP_BETWEEN_REQUESTS = float(os.environ.get("SLEEP_BETWEEN_REQUESTS", "0.12"))

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/1.0)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def http_get_final_url(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.geturl()

def parse_simple_csv(text: str):
    f = io.StringIO(text)
    return list(csv.DictReader(f))

def load_channels_from_sheet():
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
            "subscribers": sheet_subs,  # use sheet value (fast + reliable)
        })

    return channels

def now_et_fmt() -> str:
    return datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")

def iso_to_et_fmt(iso: str) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

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
    return entries[:MAX_RSS_ENTRIES_PER_CHANNEL]

# ---------- Live helpers ----------
def extract_vid_from_url(u: str) -> str:
    m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", u)
    return m.group(1) if m else ""

def html_says_live_now(html: str) -> bool:
    return (
        '"isLiveNow":true' in html
        or '\\"isLiveNow\\":true' in html
        or 'isLiveNow\\":true' in html
        or "isLiveNow\":true" in html
    )

def live_vid_from_channel_html(html: str) -> str:
    # Only trust a videoId if same page indicates isLiveNow:true
    if not html_says_live_now(html):
        return ""

    m = re.search(r'"videoId":"([A-Za-z0-9_-]{6,})".{0,1600}"isLiveNow":true', html, re.DOTALL)
    if m:
        return m.group(1)

    m = re.search(r'"isLiveNow":true.{0,1600}"videoId":"([A-Za-z0-9_-]{6,})"', html, re.DOTALL)
    if m:
        return m.group(1)

    m = re.search(r'rel="canonical"\s+href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{6,})"', html)
    if m:
        return m.group(1)

    return ""

def watch_page_confirms_live(video_id: str) -> bool:
    # quick confirm to avoid /live redirect lies
    try:
        html = http_get(f"https://www.youtube.com/watch?v={video_id}")
        return html_says_live_now(html)
    except Exception:
        return False

def fetch_channel_live_video_id(channel_id: str, handle: str = "") -> str:
    """
    Robust LIVE detection:
      1) Try channel/handle pages and only accept if html includes isLiveNow:true.
      2) Try /live redirect to candidate, then CONFIRM via watch page isLiveNow:true.
    """
    h = (handle or "").strip().lstrip("@")

    html_urls = []
    if h:
        html_urls += [
            f"https://www.youtube.com/@{h}/live",
            f"https://www.youtube.com/@{h}/streams?live_view=501",
            f"https://www.youtube.com/@{h}",
        ]
    html_urls += [
        f"https://www.youtube.com/channel/{channel_id}/live",
        f"https://www.youtube.com/channel/{channel_id}/streams?live_view=501",
        f"https://www.youtube.com/channel/{channel_id}",
    ]

    # 1) HTML says live now
    for u in html_urls:
        try:
            html = http_get(u)
        except Exception:
            continue

        vid = live_vid_from_channel_html(html)
        if vid:
            return vid

        time.sleep(SLEEP_BETWEEN_REQUESTS)

    # 2) /live redirect candidate, then confirm
    redirect_urls = []
    if h:
        redirect_urls.append(f"https://www.youtube.com/@{h}/live")
    redirect_urls.append(f"https://www.youtube.com/channel/{channel_id}/live")

    checked = set()
    for u in redirect_urls:
        try:
            final_url = http_get_final_url(u)
        except Exception:
            continue

        cand = extract_vid_from_url(final_url)
        if not cand or cand in checked:
            continue
        checked.add(cand)

        time.sleep(SLEEP_BETWEEN_REQUESTS)
        if watch_page_confirms_live(cand):
            return cand

    return ""

# ---------- Upcoming ----------
def fetch_upcoming_details(video_id: str):
    html = http_get(f"https://www.youtube.com/watch?v={video_id}")

    if not ('"isUpcoming":true' in html or "upcomingEventData" in html or '\\"isUpcoming\\":true' in html):
        return None

    m = re.search(r'"startTimestamp":"([^"]+)"', html)
    if not m:
        return None

    start_ts = m.group(1)
    return {"status": "upcoming", "start_et": iso_to_et_fmt(start_ts), "end_et": ""}

# ---------- Main ----------
def main():
    channels = load_channels_from_sheet()
    if not channels:
        raise SystemExit("No channels found in channel sheet CSV (check headers + publish link).")

    print("Loaded channels from sheet:", len(channels))
    print("-----")

    events = []
    seen = set()

    for ch in channels:
        cid = ch["channel_id"]
        handle = (ch.get("handle") or "").strip().lstrip("@")
        name = (ch.get("display_name") or "").strip() or (f"@{handle}" if handle else "")
        subs = int(ch.get("subscribers") or 0)

        print("Channel:", cid, "handle:", handle, "name:", name, "subs(sheet):", subs)

        # LIVE
        live_vid = fetch_channel_live_video_id(cid, handle)
        if live_vid:
            print("LIVE detected:", live_vid)
            if live_vid not in seen:
                seen.add(live_vid)
                events.append({
                    "start_et": now_et_fmt(),
                    "end_et": "",
                    "title": "LIVE",
                    "league": "",
                    "platform": "YouTube",
                    "channel": name,
                    "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                    "source_id": live_vid,
                    "status": "live",
                    "thumbnail_url": f"https://i.ytimg.com/vi/{live_vid}/hqdefault.jpg",
                    "subscribers": subs,
                })
        else:
            print("No LIVE detected right now.")

        time.sleep(SLEEP_BETWEEN_REQUESTS)

        # UPCOMING
        feed = fetch_rss(cid)
        for item in feed:
            vid = item["video_id"]
            if vid in seen:
                continue

            time.sleep(SLEEP_BETWEEN_REQUESTS)
            details = fetch_upcoming_details(vid)
            if not details:
                continue

            seen.add(vid)
            events.append({
                "start_et": details["start_et"],
                "end_et": "",
                "title": item.get("title", ""),
                "league": "",
                "platform": "YouTube",
                "channel": name or item.get("channel", ""),
                "watch_url": item.get("watch_url", ""),
                "source_id": vid,
                "status": "upcoming",
                "thumbnail_url": item.get("thumbnail_url", "") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "subscribers": subs,
            })

        print("-----")

    # Sort: live first, then time, tie by subs desc
    def sort_key(e):
        live_rank = 0 if e.get("status") == "live" else 1
        start = e.get("start_et") or "9999-99-99 99:99"
        return (live_rank, start, -(int(e.get("subscribers") or 0)))

    events.sort(key=sort_key)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"Wrote {len(events)} events to {OUT_PATH}")

if __name__ == "__main__":
    main()
