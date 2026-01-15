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

# ---- Request headers tuned for YouTube scraping on GitHub Actions ----
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    # Key fix: bypass many EU/consent interstitials that hide ytInitialPlayerResponse
    "Cookie": "CONSENT=YES+1; SOCS=CAI;",
}

# Tune these to control runtime
RSS_SCAN_LIMIT = int(os.environ.get("RSS_SCAN_LIMIT", "25"))   # was 60
SLEEP_BETWEEN = float(os.environ.get("SLEEP_BETWEEN", "0.08")) # keep small to avoid throttling

def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def http_get_final_and_html(url: str):
    """Returns (final_url_after_redirects, html)."""
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        final_url = resp.geturl()
        html = resp.read().decode("utf-8", errors="ignore")
    return final_url, html

def parse_simple_csv(text: str):
    import csv, io
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

    entries.sort(key=lambda x: x.get("published",""), reverse=True)
    return entries[:RSS_SCAN_LIMIT]

# ----------------- Player Response Parsing (brace-balance) -----------------
def extract_player_response(html: str):
    """
    Extract ytInitialPlayerResponse JSON via brace-balance scan.
    Works even when YouTube minifies scripts.
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

    # sometimes these exist instead
    is_live = vd.get("isLive")
    is_upcoming = vd.get("isUpcoming")
    is_live_content = vd.get("isLiveContent")

    if is_live_now is True or is_live is True:
        return "live", start_ts, end_ts
    if is_upcoming is True or (is_live_content is True and start_ts and is_live_now is False):
        return "upcoming", start_ts, end_ts
    return None, None, None

def fetch_video_details(video_id: str):
    """
    Returns {status, start_et, end_et} if live/upcoming, else None.
    Uses consent-friendly URL params too.
    """
    url = f"https://www.youtube.com/watch?v={video_id}&bpctr=9999999999&has_verified=1"
    html = http_get(url)

    # If we got an interstitial / consent wall, this catches it quickly
    if "consent.youtube.com" in html or "Before you continue" in html:
        # try again with same cookies/headers (sometimes first response is cached)
        html = http_get(url)

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

    # fallback string checks (covers some cases where JSON parse fails)
    live_markers = [
        '"isLiveNow":true',
        '\\"isLiveNow\\":true',
        'isLiveNow\\":true',
    ]
    if any(m in html for m in live_markers):
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "live", "start_et": iso_to_et_fmt(m.group(1)), "end_et": ""}
        now_et = datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")
        return {"status": "live", "start_et": now_et, "end_et": ""}

    if ('"isUpcoming":true' in html) or ('"upcomingEventData"' in html) or ("upcomingEventData" in html):
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "upcoming", "start_et": iso_to_et_fmt(m.group(1)), "end_et": ""}

    return None

# ----------------- Live detection per channel -----------------
def extract_video_ids_from_html(html: str):
    """
    Pull candidate videoIds from a channel page / streams page.
    We return a small unique list (order preserved).
    """
    found = []
    seen = set()

    # Strongest signal: videoId close to isLiveNow:true
    patterns = [
        r'"videoId":"([A-Za-z0-9_-]{6,})".{0,1500}"isLiveNow":true',
        r'"isLiveNow":true.{0,1500}"videoId":"([A-Za-z0-9_-]{6,})"',
        r'"urlCanonical":"https:\\/\\/www\\.youtube\\.com\\/watch\\?v=([A-Za-z0-9_-]{6,})"',
        r'rel="canonical"\s+href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{6,})"',
        r'"watchEndpoint":\{"videoId":"([A-Za-z0-9_-]{6,})"',
        r'\\"watchEndpoint\\":\{\\"videoId\\":\\"([A-Za-z0-9_-]{6,})\\"',
    ]
    for pat in patterns:
        for m in re.finditer(pat, html, re.DOTALL):
            vid = m.group(1)
            if vid and vid not in seen:
                seen.add(vid)
                found.append(vid)
            if len(found) >= 6:
                return found
    return found

def fetch_channel_live_video_id(channel_id: str, handle: str = "") -> str:
    """
    IMPORTANT: /live can redirect to a *recent upload* even when not live.
    So we gather candidates from multiple endpoints, then confirm using fetch_video_details(...).
    """
    h = (handle or "").strip().lstrip("@")

    urls = []
    if h:
        urls.extend([
            f"https://www.youtube.com/@{h}/live",
            f"https://www.youtube.com/@{h}/streams?live_view=501",
            f"https://www.youtube.com/@{h}/streams",
        ])
    urls.extend([
        f"https://www.youtube.com/channel/{channel_id}/live",
        f"https://www.youtube.com/channel/{channel_id}/streams?live_view=501",
        f"https://www.youtube.com/channel/{channel_id}/streams",
    ])

    checked = set()

    for url in urls:
        try:
            final_url, html = http_get_final_and_html(url)
        except Exception:
            continue

        # candidate from redirect
        m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", final_url or "")
        candidates = []
        if m:
            candidates.append(m.group(1))

        # candidates from html
        if html:
            candidates.extend(extract_video_ids_from_html(html))

        for cand in candidates:
            if not cand or cand in checked:
                continue
            checked.add(cand)

            time.sleep(SLEEP_BETWEEN)
            details = fetch_video_details(cand)
            if details and details.get("status") == "live":
                return cand

    return ""

# ----------------- Subscribers -----------------
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
        return int(num * 1_000_000)
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
        urls.extend([
            f"https://www.youtube.com/@{h}/about",
            f"https://www.youtube.com/@{h}",
        ])
    urls.extend([
        f"https://www.youtube.com/channel/{channel_id}/about",
        f"https://www.youtube.com/channel/{channel_id}",
    ])

    for u in urls:
        try:
            html = http_get(u + ("?bpctr=9999999999&has_verified=1" if "youtube.com/" in u else ""))
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

        # 1) Live RIGHT NOW (even if unscheduled)
        live_vid = fetch_channel_live_video_id(cid, handle)
        if live_vid:
            print("LIVE CONFIRMED:", live_vid)

            if live_vid not in seen:
                details = fetch_video_details(live_vid)  # should be live
                if details and details.get("status") == "live":
                    seen.add(live_vid)
                    events.append({
                        "start_et": details.get("start_et", ""),
                        "end_et": details.get("end_et", ""),
                        "title": "LIVE (right now)",
                        "league": "",
                        "platform": "YouTube",
                        "channel": preferred_name,
                        "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                        "source_id": live_vid,
                        "status": "live",
                        "thumbnail_url": f"https://i.ytimg.com/vi/{live_vid}/hqdefault.jpg",
                        "subscribers": subs,
                    })
        else:
            print("No LIVE detected right now.")

        # 2) Upcoming/live from RSS
        feed = fetch_rss(cid)
        for item in feed:
            vid = item["video_id"]
            if vid in seen:
                continue

            time.sleep(SLEEP_BETWEEN)
            details = fetch_video_details(vid)
            if not details:
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

    # Ensure thumbs for everything
    for e in events:
        if not e.get("thumbnail_url") and e.get("source_id"):
            e["thumbnail_url"] = f"https://i.ytimg.com/vi/{e['source_id']}/hqdefault.jpg"

    # Sort: live first, then time, tie-break by subs desc
    def sort_key(e):
        live_rank = 0 if e.get("status") == "live" else 1
        return (live_rank, e.get("start_et", "9999-99-99 99:99"), -(int(e.get("subscribers") or 0)))

    events.sort(key=sort_key)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"-----\nWrote {len(events)} events to {OUT_PATH}")

if __name__ == "__main__":
    main()
