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
    }

    entries = []
    for entry in root.findall("atom:entry", ns):
        vid = entry.findtext("yt:videoId", default="", namespaces=ns)
        title = entry.findtext("atom:title", default="", namespaces=ns)
        link_el = entry.find("atom:link", ns)
        link = link_el.attrib.get("href", "") if link_el is not None else ""
        published = entry.findtext("atom:published", default="", namespaces=ns)
        author_name = entry.findtext("atom:author/atom:name", default="", namespaces=ns)
        if vid and link:
            entries.append({
                "video_id": vid,
                "title": title,
                "watch_url": link,
                "published": published,
                "channel": author_name
            })
    entries.sort(key=lambda x: x.get("published",""), reverse=True)
    return entries[:50]

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
    if not player:
        return None

    status, start_ts, end_ts = get_live_status(player)
    if status not in ("live", "upcoming"):
        return None
    if not start_ts:
        return None

    return {
        "status": status,
        "start_et": iso_to_et_fmt(start_ts),
        "end_et": iso_to_et_fmt(end_ts) if end_ts else ""
    }

def main():
    if not CHANNEL_IDS:
        raise SystemExit("CHANNEL_IDS env var is empty. Set it in GitHub Secrets.")

    events = []
    seen = set()

    for cid in CHANNEL_IDS:
        feed = fetch_rss(cid)
        for item in feed:
            vid = item["video_id"]
            if vid in seen:
                continue

            time.sleep(0.35)

            details = fetch_video_details(vid)
            if not details:
                continue

            seen.add(vid)
            events.append({
                "start_et": details["start_et"],
                "end_et": details["end_et"],
                "title": item["title"],
                "league": "",
                "platform": "YouTube",
                "channel": item["channel"],
                "watch_url": item["watch_url"],
                "source_id": vid,
                "status": details["status"],
            })

    events.sort(key=lambda x: x["start_et"])

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"Wrote {len(events)} events to {OUT_PATH}")

if __name__ == "__main__":
    main()
