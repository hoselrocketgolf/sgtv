import os, re, json, time
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

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/1.0)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
}

# ----------------- HTTP -----------------
def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="ignore")

# ----------------- Sheet (channels) -----------------
def parse_simple_csv(text: str):
    import csv, io
    f = io.StringIO(text)
    return list(csv.DictReader(f))

def load_channels_from_sheet():
    """
    Sheet headers expected (exact):
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

# ----------------- Time helpers -----------------
def iso_to_et_fmt(iso: str) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

# ----------------- RSS -----------------
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
    return entries[:60]

# ----------------- Player Response Parsing -----------------
def extract_player_response(html: str):
    """
    Extract ytInitialPlayerResponse JSON using a brace-balance scan.
    """
    anchors = ["ytInitialPlayerResponse", "var ytInitialPlayerResponse"]
    idx = -1
    for a in anchors:
        idx = html.find(a)
        if idx != -1:
            break
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
                    blob = html[start:i+1]
                    try:
                        return json.loads(blob)
                    except Exception:
                        return None
    return None

def get_live_status(player):
    vd = (player or {}).get("videoDetails", {}) or {}
    micro = (((player or {}).get("microformat", {}) or {}).get("playerMicroformatRenderer", {}) or {})
    live_details = (micro.get("liveBroadcastDetails", {}) or {})

    is_live_now = live_details.get("isLiveNow")
    start_ts = live_details.get("startTimestamp")
    end_ts = live_details.get("endTimestamp")

    is_live = vd.get("isLive")
    is_upcoming = vd.get("isUpcoming")
    is_live_content = vd.get("isLiveContent")

    if is_live_now is True or is_live is True:
        return "live", start_ts, end_ts
    if is_upcoming is True or (is_live_content is True and start_ts and is_live_now is False):
        return "upcoming", start_ts, end_ts
    return None, None, None

def fetch_video_details(video_id: str):
    html = http_get(f"https://www.youtube.com/watch?v={video_id}")

    # 1) primary: parsed player response
    player = extract_player_response(html)
    if player:
        status, start_ts, end_ts = get_live_status(player)
        if status in ("live", "upcoming"):
            if status == "live" and not start_ts:
                now_et = datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")
                return {"status": "live", "start_et": now_et, "end_et": ""}
            if start_ts:
                return {
                    "status": status,
                    "start_et": iso_to_et_fmt(start_ts),
                    "end_et": iso_to_et_fmt(end_ts) if end_ts else ""
                }

    # 2) fallback: LIVE detection via multiple encodings
    if ("\"isLiveNow\":true" in html) or ("\\\"isLiveNow\\\":true" in html) or ("isLiveNow\\\":true" in html):
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "live", "start_et": iso_to_et_fmt(m.group(1)), "end_et": ""}
        now_et = datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")
        return {"status": "live", "start_et": now_et, "end_et": ""}

    # 3) upcoming only if explicitly upcoming-ish
    if ('"isUpcoming":true' in html) or ('"upcomingEventData"' in html) or ("upcomingEventData" in html):
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "upcoming", "start_et": iso_to_et_fmt(m.group(1)), "end_et": ""}

    return None

# ----------------- Live detection per channel -----------------
def fetch_channel_live_video_id(channel_id: str, handle: str = "") -> str:
    """
    Find a channel's currently-live video id (ONLY if actually live).

    We extract candidate videoIds from live/streams pages,
    then CONFIRM the candidate is actually live via fetch_video_details().
    """

    def try_get_final_and_html(url: str):
        try:
            req = urllib.request.Request(url, headers=REQ_HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                final_url = resp.geturl()
                html = resp.read().decode("utf-8", errors="ignore")
            return final_url, html
        except Exception:
            return "", ""

    def extract_vid_from_url(u: str) -> str:
        m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", u)
        return m.group(1) if m else ""

    def extract_vid_from_html(html: str) -> str:
        # BEST: videoId near isLiveNow:true (both directions)
        m = re.search(
            r'"videoId":"([A-Za-z0-9_-]{6,})".{0,1200}"isLiveNow":true',
            html,
            re.DOTALL
        )
        if m:
            return m.group(1)

        m = re.search(
            r'"isLiveNow":true.{0,1200}"videoId":"([A-Za-z0-9_-]{6,})"',
            html,
            re.DOTALL
        )
        if m:
            return m.group(1)

        # canonical watch url
        m = re.search(
            r'rel="canonical"\s+href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{6,})"',
            html
        )
        if m:
            return m.group(1)

        # urlCanonical in JSON
        m = re.search(
            r'"urlCanonical":"https:\\/\\/www\\.youtube\\.com\\/watch\\?v=([A-Za-z0-9_-]{6,})"',
            html
        )
        if m:
            return m.group(1)

        # watchEndpoint videoId
        m = re.search(
            r'"watchEndpoint":\{"videoId":"([A-Za-z0-9_-]{6,})"',
            html
        )
        if m:
            return m.group(1)

        # escaped version
        m = re.search(
            r'\\"watchEndpoint\\":\{\\"videoId\\":\\"([A-Za-z0-9_-]{6,})\\"',
            html
        )
        if m:
            return m.group(1)

        return ""

    h = (handle or "").strip().lstrip("@")

    urls = []
    if h:
        urls.append(f"https://www.youtube.com/@{h}/live")
        urls.append(f"https://www.youtube.com/@{h}/streams?live_view=501")
        urls.append(f"https://www.youtube.com/@{h}/streams")
    urls.append(f"https://www.youtube.com/channel/{channel_id}/live")
    urls.append(f"https://www.youtube.com/channel/{channel_id}/streams?live_view=501")
    urls.append(f"https://www.youtube.com/channel/{channel_id}/streams")

    checked = set()

    for url in urls:
        final_url, html = try_get_final_and_html(url)

        candidates = []
        vid = extract_vid_from_url(final_url)
        if vid:
            candidates.append(vid)

        if html:
            vid2 = extract_vid_from_html(html)
            if vid2:
                candidates.append(vid2)

        for cand in candidates:
            if not cand or cand in checked:
                continue
            checked.add(cand)

            time.sleep(0.15)
            details = fetch_video_details(cand)
            if details and details.get("status") == "live":
                return cand

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
            return parse_subscribers_to_int(m.group(1) if m.groups() else m.group(0))
    return 0

def fetch_channel_subscribers(channel_id: str, handle: str = "") -> int:
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

        print("Channel:", cid, "handle:", handle, "name:", preferred_name, "subs:", subs)

        # 1) detect currently live now (unscheduled)
        live_vid = fetch_channel_live_video_id(cid, handle)
        if live_vid:
            print("LIVE candidate:", cid, live_vid, "(handle:", handle, ")")

        if live_vid and live_vid not in seen:
            time.sleep(0.25)
            details = fetch_video_details(live_vid)
            print("LIVE candidate details:", live_vid, details)

            if details and details.get("status") == "live":
                seen.add(live_vid)
                events.append({
                    "start_et": details.get("start_et", ""),
                    "end_et": details.get("end_et", ""),
                    "title": "LIVE (unscheduled)",
                    "league": "",
                    "platform": "YouTube",
                    "channel": preferred_name,
                    "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                    "source_id": live_vid,
                    "status": "live",
                    "thumbnail_url": f"https://i.ytimg.com/vi/{live_vid}/hqdefault.jpg",
                    "subscribers": subs,
                })

        # 2) upcoming/live from RSS list
        feed = fetch_rss(cid)
        for item in feed:
            vid = item["video_id"]
            if vid in seen:
                continue

            time.sleep(0.25)
            details = fetch_video_details(vid)
            if not details:
                print("Skipped (no live/upcoming):", item.get("title", ""), item.get("watch_url", ""))
                continue

            seen.add(vid)

            yt_name = (item.get("channel") or "").strip()
            final_name = preferred_name or yt_name or ""

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

    # ensure thumbs
    for e in events:
        if not e.get("thumbnail_url") and e.get("source_id"):
            e["thumbnail_url"] = f"https://i.ytimg.com/vi/{e['source_id']}/hqdefault.jpg"

    # sort: live first, then by time, tie by subs desc
    def sort_key(e):
        live_rank = 0 if e.get("status") == "live" else 1
        return (live_rank, e.get("start_et", "9999-99-99 99:99"), -(int(e.get("subscribers") or 0)))

    events.sort(key=sort_key)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"Wrote {len(events)} events to {OUT_PATH}")

if __name__ == "__main__":
    main()
