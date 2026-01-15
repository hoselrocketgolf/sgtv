import os, re, json, time
from datetime import datetime
from zoneinfo import ZoneInfo
import urllib.request
import xml.etree.ElementTree as ET
import csv, io

ET_TZ = ZoneInfo("America/New_York")

CHANNEL_SHEET_CSV = os.environ.get(
    "CHANNEL_SHEET_CSV",
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv"
)
OUT_PATH = "schedule.json"

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/1.0)"

# ---------------- helpers ----------------

def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="ignore")

def parse_csv(text: str):
    return list(csv.DictReader(io.StringIO(text)))

def iso_to_et(iso: str) -> str:
    return datetime.fromisoformat(iso.replace("Z","+00:00")).astimezone(ET_TZ).strftime("%Y-%m-%d %H:%M")

# ---------------- youtube ----------------

def fetch_rss(channel_id: str):
    xml = http_get(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")
    root = ET.fromstring(xml)

    ns = {
        "atom":"http://www.w3.org/2005/Atom",
        "yt":"http://www.youtube.com/xml/schemas/2015",
        "media":"http://search.yahoo.com/mrss/"
    }

    out = []
    for e in root.findall("atom:entry", ns):
        vid = e.findtext("yt:videoId", "", ns)
        if not vid:
            continue

        out.append({
            "video_id": vid,
            "title": e.findtext("atom:title","",ns),
            "url": e.find("atom:link",ns).attrib.get("href",""),
            "thumb": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        })
    return out[:40]

def fetch_live_video(channel_id: str):
    try:
        req = urllib.request.Request(
            f"https://www.youtube.com/channel/{channel_id}/live",
            headers={"User-Agent": USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            final = r.geturl()
        m = re.search(r"v=([A-Za-z0-9_-]{6,})", final)
        return m.group(1) if m else ""
    except:
        return ""

def video_status(video_id: str):
    html = http_get(f"https://www.youtube.com/watch?v={video_id}")

    if '"isLiveNow":true' in html:
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        return {
            "status":"live",
            "start": iso_to_et(m.group(1)) if m else datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")
        }

    if '"isUpcoming":true' in html:
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status":"upcoming","start":iso_to_et(m.group(1))}

    return None

def fetch_subs(channel_id: str) -> int:
    try:
        html = http_get(f"https://www.youtube.com/channel/{channel_id}")
        m = re.search(r'([0-9\.]+)([KM])\s+subscribers', html)
        if not m:
            return 0
        n = float(m.group(1))
        return int(n*1000) if m.group(2)=="K" else int(n*1_000_000)
    except:
        return 0

# ---------------- main ----------------

def main():
    channels = parse_csv(http_get(CHANNEL_SHEET_CSV))
    events = []
    seen = set()

    print("Loaded channels:", len(channels))

    for ch in channels:
        cid = ch.get("channel_id","").strip()
        if not cid:
            continue

        name = ch.get("display_name") or ch.get("handle") or ""
        subs = fetch_subs(cid)
        time.sleep(0.4)

        # ---- live first ----
        live_vid = fetch_live_video(cid)
        if live_vid and live_vid not in seen:
            s = video_status(live_vid)
            if s and s["status"]=="live":
                seen.add(live_vid)
                events.append({
                    "start_et": s["start"],
                    "end_et": "",
                    "title": "LIVE",
                    "league":"",
                    "platform":"YouTube",
                    "channel": name,
                    "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                    "source_id": live_vid,
                    "status":"live",
                    "thumbnail_url": f"https://i.ytimg.com/vi/{live_vid}/hqdefault.jpg",
                    "subscribers": subs
                })

        # ---- rss scan ----
        for item in fetch_rss(cid):
            vid = item["video_id"]
            if vid in seen:
                continue

            time.sleep(0.4)
            s = video_status(vid)
            if not s:
                continue

            seen.add(vid)
            events.append({
                "start_et": s["start"],
                "end_et":"",
                "title": item["title"],
                "league":"",
                "platform":"YouTube",
                "channel": name,
                "watch_url": item["url"],
                "source_id": vid,
                "status": s["status"],
                "thumbnail_url": item["thumb"],
                "subscribers": subs
            })

    events.sort(key=lambda x: (x["status"]!="live", -x["subscribers"], x["start_et"]))

    with open(OUT_PATH,"w",encoding="utf-8") as f:
        json.dump(events,f,indent=2)

    print("Wrote",len(events),"events")

if __name__ == "__main__":
    main()
