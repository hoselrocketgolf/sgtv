import os, re, json, time
from datetime import datetime
from zoneinfo import ZoneInfo
import urllib.request
import xml.etree.ElementTree as ET

ET_TZ = ZoneInfo("America/New_York")

CHANNEL_IDS = [c.strip() for c in os.environ.get("CHANNEL_IDS","").split(",") if c.strip()]
OUT_PATH = os.environ.get("OUT_PATH", "schedule.json")

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/1.0)"

def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def iso_to_et_fmt(iso: str) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

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

        # Thumbnail (best-effort)
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
    # scan deeper so we catch scheduled lives that aren’t among the newest few uploads
    return entries[:60]


def extract_player_response(html: str):
    patterns = [
        r"ytInitialPlayerResponse\\s*=\\s*(\\{.*?\\})\\s*;",
        r"var\\s+ytInitialPlayerResponse\\s*=\\s*(\\{.*?\\})\\s*;",
    ]
    for pat in patterns:
        m = re.search(pat, html, re.DOTALL)
        if m:
            return json.loads(m.group(1))
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
        status = "live"
    elif is_upcoming is True or (is_live_content is True and start_ts and is_live_now is False):
        status = "upcoming"
    else:
        status = None

    return status, start_ts, end_ts

def fetch_video_details(video_id: str):
    html = http_get(f"https://www.youtube.com/watch?v={video_id}")

    player = extract_player_response(html)
    if player:
        status, start_ts, end_ts = get_live_status(player)
        if status in ("live", "upcoming") and start_ts:
            return {
                "status": status,
                "start_et": iso_to_et_fmt(start_ts),
                "end_et": iso_to_et_fmt(end_ts) if end_ts else ""
            }

    # Fallback: search raw HTML for a startTimestamp (works on many upcoming lives)
    m = re.search(r'"startTimestamp":"([^"]+)"', html)
    if m:
        start_ts = m.group(1)
        # if we have a startTimestamp but no explicit status, assume upcoming
        return {
            "status": "upcoming",
            "start_et": iso_to_et_fmt(start_ts),
            "end_et": ""
        }

    # Fallback: if currently live, some pages include isLiveNow true even if parsing fails
    if '"isLiveNow":true' in html:
        m2 = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m2:
            return {
                "status": "live",
                "start_et": iso_to_et_fmt(m2.group(1)),
                "end_et": ""
            }

    return None

def fetch_channel_live_video_id(channel_id: str) -> str:
    """
    Tries to discover a channel's currently-live video (even if it wasn't scheduled),
    by hitting the /live endpoint and reading the final redirected URL.
    Returns video_id or "".
    """
    try:
        url = f"https://www.youtube.com/channel/{channel_id}/live"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            final_url = resp.geturl()  # after redirects
        m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", final_url)
        return m.group(1) if m else ""
    except Exception:
        return ""

def parse_subscribers_to_int(text: str) -> int:
    """
    Converts strings like '128K subscribers' / '1.2M subscribers' / '12,345 subscribers'
    into an integer. Returns 0 if unknown.
    """
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

def fetch_channel_subscribers(channel_id: str) -> int:
    """
    Best-effort subscriber scrape (free, no API).
    Tries multiple patterns because YouTube changes markup.
    """
    try:
        html = http_get(f"https://www.youtube.com/channel/{channel_id}")
    except Exception:
        return 0

    # Common patterns in page data
    patterns = [
        r'"subscriberCountText":\{"simpleText":"([^"]+)"\}',
        r'"subscriberCountText":\{"runs":\[\{"text":"([^"]+)"\}\]\}',
        r'"videoOwnerRenderer".*?"subscriberCountText".*?"simpleText":"([^"]+)"',
        r'"metadataParts".*?"text":"([^"]*subscribers[^"]*)"',
    ]

    for pat in patterns:
        m = re.search(pat, html, re.DOTALL)
        if m:
            return parse_subscribers_to_int(m.group(1))

    # last-ditch: look for “123K subscribers” in raw html
    m2 = re.search(r'([0-9][0-9\.,]*\s*[KM]?)\s+subscribers', html, re.IGNORECASE)
    if m2:
        return parse_subscribers_to_int(m2.group(0))

    return 0

def main():
    if not CHANNEL_IDS:
        raise SystemExit("CHANNEL_IDS env var is empty. Set it in GitHub Secrets.")

    events = []
    seen = set()

    for cid in CHANNEL_IDS:
        # Fetch subscriber count once per channel (best-effort)
        subs = fetch_channel_subscribers(cid)

        # 1) Catch currently-live (even if not scheduled)
        live_vid = fetch_channel_live_video_id(cid)
        if live_vid and live_vid not in seen:
            time.sleep(0.35)
            details = fetch_video_details(live_vid)
            if details and details["status"] == "live":
                seen.add(live_vid)
                events.append({
                    "start_et": details["start_et"],
                    "end_et": details["end_et"],
                    "title": "LIVE (unscheduled)",
                    "league": "",
                    "platform": "YouTube",
                    "channel": "",
                    "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                    "source_id": live_vid,
                    "status": details["status"],
                    "thumbnail_url": "",
                    "subscribers": subs,
                })

        # 2) Scheduled/live from feed
        feed = fetch_rss(cid)
        for item in feed:
            vid = item["video_id"]
            if vid in seen:
                continue

            time.sleep(0.35)

            details = fetch_video_details(vid)
            if not details:
                print("Skipped (no live/upcoming):", item.get("title", ""), item.get("watch_url", ""))
                continue

            seen.add(vid)
            events.append({
                "start_et": details["start_et"],
                "end_et": details["end_et"],
                "title": item.get("title", ""),
                "league": "",
                "platform": "YouTube",
                "channel": item.get("channel", ""),
                "watch_url": item.get("watch_url", ""),
                "source_id": vid,
                "status": details["status"],
                "thumbnail_url": item.get("thumbnail_url", ""),
                "subscribers": subs,
            })

    # Fill missing channel/thumb for unscheduled live if possible (from feed-matched items)
    by_id = {e["source_id"]: e for e in events if e.get("source_id")}
    for e in events:
        if not e.get("channel"):
            match = by_id.get(e.get("source_id", ""))
            if match:
                e["channel"] = match.get("channel", "")
                e["thumbnail_url"] = match.get("thumbnail_url", "")

    events.sort(key=lambda x: x["start_et"])

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"Wrote {len(events)} events to {OUT_PATH}")


if __name__ == "__main__":
    main()

