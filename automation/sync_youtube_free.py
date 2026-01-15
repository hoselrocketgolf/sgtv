import os, re, json, time
from datetime import datetime
from zoneinfo import ZoneInfo
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

ET_TZ = ZoneInfo("America/New_York")

CHANNEL_SHEET_CSV = os.environ.get(
    "CHANNEL_SHEET_CSV",
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv",
)
OUT_PATH = os.environ.get("OUT_PATH", "schedule.json")

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/1.0; +https://sgtv-9xx.pages.dev/)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
}

# ----------------- HTTP -----------------
def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def http_get_with_final_url(url: str):
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        final_url = resp.geturl()
        html = resp.read().decode("utf-8", errors="ignore")
        return final_url, html

# ----------------- CSV -----------------
def parse_simple_csv(text: str):
    import csv, io
    f = io.StringIO(text)
    return list(csv.DictReader(f))

def load_channels_from_sheet():
    """
    Sheet headers expected:
      handle, display_name, channel_id, subscribers
    - handle can be with or without @
    - subscribers optional (fallback only)
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

        channels.append(
            {
                "channel_id": cid,
                "handle": handle,
                "display_name": display,
                "sheet_subscribers": sheet_subs,
            }
        )

    return channels

# ----------------- Time -----------------
def iso_to_et_fmt(iso: str) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

def now_et_fmt() -> str:
    return datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")

# ----------------- RSS (Upcoming lives appear here) -----------------
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
            entries.append(
                {
                    "video_id": vid,
                    "title": title,
                    "watch_url": link,
                    "published": published,
                    "channel": author_name,
                    "thumbnail_url": thumb,
                }
            )

    entries.sort(key=lambda x: x.get("published", ""), reverse=True)
    return entries[:60]

# ----------------- Player response extraction -----------------
def extract_player_response(html: str):
    """
    Brace-balance extraction for ytInitialPlayerResponse.
    Works better than regex-only when YouTube changes formatting.
    """
    idx = html.find("ytInitialPlayerResponse")
    if idx == -1:
        return None

    start = html.find("{", idx)
    if start == -1:
        return None

    depth = 0
    in_str = False
    esc = False

    for i in range(start, len(html)):
        c = html[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    blob = html[start : i + 1]
                    try:
                        return json.loads(blob)
                    except Exception:
                        return None

    return None

def get_live_status_from_player(player):
    vd = (player or {}).get("videoDetails", {}) or {}
    micro = (
        ((player or {}).get("microformat", {}) or {})
        .get("playerMicroformatRenderer", {})
        or {}
    )
    live_details = micro.get("liveBroadcastDetails", {}) or {}

    is_live_now = live_details.get("isLiveNow")
    start_ts = live_details.get("startTimestamp")
    end_ts = live_details.get("endTimestamp")

    is_live = vd.get("isLive")
    is_upcoming = vd.get("isUpcoming")
    is_live_content = vd.get("isLiveContent")

    title = vd.get("title") or ""

    if is_live_now is True or is_live is True:
        return "live", start_ts, end_ts, title
    if is_upcoming is True or (is_live_content is True and start_ts and is_live_now is False):
        return "upcoming", start_ts, end_ts, title

    return None, None, None, title

def fetch_video_details(video_id: str):
    """
    Returns:
      {"status": "live"|"upcoming", "start_et": "...", "end_et": "...", "title": "..."}
    or None.
    """
    html = http_get(f"https://www.youtube.com/watch?v={video_id}")

    # 1) parsed player response
    player = extract_player_response(html)
    if player:
        status, start_ts, end_ts, title = get_live_status_from_player(player)
        if status in ("live", "upcoming"):
            # live sometimes lacks startTimestamp; use now
            if status == "live" and not start_ts:
                return {"status": "live", "start_et": now_et_fmt(), "end_et": "", "title": title or ""}
            if start_ts:
                return {
                    "status": status,
                    "start_et": iso_to_et_fmt(start_ts),
                    "end_et": iso_to_et_fmt(end_ts) if end_ts else "",
                    "title": title or "",
                }

    # 2) fallback scan (handles escaped versions)
    # detect live
    if re.search(r'isLiveNow\\*":true', html):
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "live", "start_et": iso_to_et_fmt(m.group(1)), "end_et": "", "title": ""}
        return {"status": "live", "start_et": now_et_fmt(), "end_et": "", "title": ""}

    # detect upcoming (only if explicitly upcoming-ish)
    if ('"isUpcoming":true' in html) or ("upcomingEventData" in html):
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "upcoming", "start_et": iso_to_et_fmt(m.group(1)), "end_et": "", "title": ""}

    return None

# ----------------- Live detection per channel -----------------
def extract_video_ids_from_streams_html(html: str):
    """
    On /streams pages, live items are usually tagged with isLiveNow:true.
    We collect a few candidate videoIds near those markers.
    """
    vids = set()

    # videoId ... isLiveNow true (either direction)
    for m in re.finditer(r'"videoId":"([A-Za-z0-9_-]{6,})".{0,1500}isLiveNow\\*":true', html, re.DOTALL):
        vids.add(m.group(1))
    for m in re.finditer(r'isLiveNow\\*":true.{0,1500}"videoId":"([A-Za-z0-9_-]{6,})"', html, re.DOTALL):
        vids.add(m.group(1))

    return list(vids)

def fetch_channel_live_video_id(channel_id: str, handle: str = "") -> str:
    """
    Find a channel's currently-live video id (ONLY if actually live).
    We DO NOT trust /live redirects alone; we confirm with fetch_video_details(...).
    """
    h = (handle or "").strip().lstrip("@")

    urls = []
    if h:
        urls += [
            f"https://www.youtube.com/@{h}/live",
            f"https://www.youtube.com/@{h}/streams?live_view=501",
            f"https://www.youtube.com/@{h}/streams",
        ]
    urls += [
        f"https://www.youtube.com/channel/{channel_id}/live",
        f"https://www.youtube.com/channel/{channel_id}/streams?live_view=501",
        f"https://www.youtube.com/channel/{channel_id}/streams",
    ]

    candidates = []
    checked = set()

    for url in urls:
        try:
            final_url, html = http_get_with_final_url(url)
        except Exception:
            continue

        # candidate from redirect url
        m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", final_url)
        if m:
            candidates.append(m.group(1))

        # candidates from streams HTML
        if "streams" in url and html:
            candidates += extract_video_ids_from_streams_html(html)

        # candidates from canonical watch url if present
        if html:
            m2 = re.search(r'rel="canonical"\s+href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{6,})"', html)
            if m2:
                candidates.append(m2.group(1))

    # confirm candidates are LIVE
    for vid in candidates:
        if not vid or vid in checked:
            continue
        checked.add(vid)

        time.sleep(0.15)
        details = fetch_video_details(vid)
        if details and details.get("status") == "live":
            return vid

    return ""

# ----------------- Subscribers -----------------
def parse_subscribers_to_int(text: str) -> int:
    if not text:
        return 0
    t = text.lower()
    t = t.replace("subscribers", "").replace("subscriber", "").strip()
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
            val = m.group(1) if m.groups() else m.group(0)
            return parse_subscribers_to_int(val)
    return 0

def fetch_channel_subscribers(channel_id: str, handle: str = "") -> int:
    h = (handle or "").strip().lstrip("@")
    urls = []
    if h:
        urls += [f"https://www.youtube.com/@{h}/about", f"https://www.youtube.com/@{h}"]
    urls += [f"https://www.youtube.com/channel/{channel_id}/about", f"https://www.youtube.com/channel/{channel_id}"]

    for u in urls:
        try:
            html = http_get(u)
            subs = scrape_subscribers_from_html(html)
            if subs > 0:
                return subs
        except Exception:
            continue

    return 0

# ----------------- Main -----------------
def main():
    channels = load_channels_from_sheet()
    if not channels:
        raise SystemExit("No channels found in channel sheet CSV (check headers + publish link).")

    print("Loaded channels from sheet:", len(channels))
    print("Channel IDs:", [c["channel_id"] for c in channels])

    events = []
    seen = set()

    for ch in channels:
        cid = ch["channel_id"]
        handle = (ch.get("handle") or "").strip().lstrip("@")

        scraped_subs = fetch_channel_subscribers(cid, handle)
        subs = scraped_subs if scraped_subs > 0 else int(ch.get("sheet_subscribers", 0) or 0)

        sheet_name = (ch.get("display_name") or "").strip()
        preferred_name = sheet_name or (f"@{handle}" if handle else "")

        print("-----")
        print("Channel:", cid, "handle:", handle, "name:", preferred_name, "subs:", subs)

        # 1) LIVE NOW (unscheduled)
        live_vid = fetch_channel_live_video_id(cid, handle)
        if live_vid:
            details = fetch_video_details(live_vid)
            print("LIVE FOUND:", live_vid, details)

            if details and details.get("status") == "live" and live_vid not in seen:
                seen.add(live_vid)
                title = details.get("title") or "LIVE (unscheduled)"
                events.append(
                    {
                        "start_et": details.get("start_et", now_et_fmt()),
                        "end_et": details.get("end_et", ""),
                        "title": title,
                        "league": "",
                        "platform": "YouTube",
                        "channel": preferred_name,
                        "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                        "source_id": live_vid,
                        "status": "live",
                        "thumbnail_url": f"https://i.ytimg.com/vi/{live_vid}/hqdefault.jpg",
                        "subscribers": subs,
                    }
                )
        else:
            print("No LIVE detected right now.")

        # 2) UPCOMING + LIVE flagged videos from RSS list
        feed = fetch_rss(cid)
        for item in feed:
            vid = item.get("video_id", "")
            if not vid or vid in seen:
                continue

            time.sleep(0.20)
            details = fetch_video_details(vid)
            if not details:
                # debug
                print("Skipped (no live/upcoming):", item.get("title", ""), item.get("watch_url", ""))
                continue

            seen.add(vid)

            yt_name = (item.get("channel") or "").strip()
            final_name = preferred_name or yt_name or ""

            events.append(
                {
                    "start_et": details.get("start_et", ""),
                    "end_et": details.get("end_et", ""),
                    "title": item.get("title", "") or details.get("title", "") or "",
                    "league": "",
                    "platform": "YouTube",
                    "channel": final_name,
                    "watch_url": item.get("watch_url", ""),
                    "source_id": vid,
                    "status": details.get("status", ""),
                    "thumbnail_url": item.get("thumbnail_url", "") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    "subscribers": subs,
                }
            )

    # ensure thumbs
    for e in events:
        if not e.get("thumbnail_url") and e.get("source_id"):
            e["thumbnail_url"] = f"https://i.ytimg.com/vi/{e['source_id']}/hqdefault.jpg"

    # sort: LIVE first, then time, tie by subs desc
    def sort_key(e):
        live_rank = 0 if e.get("status") == "live" else 1
        start = e.get("start_et") or "9999-99-99 99:99"
        subs = int(e.get("subscribers") or 0)
        return (live_rank, start, -subs)

    events.sort(key=sort_key)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print("-----")
    print(f"Wrote {len(events)} events to {OUT_PATH}")

if __name__ == "__main__":
    main()
