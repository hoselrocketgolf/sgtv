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

def parse_simple_csv(text: str):
    # minimal CSV parser that handles quoted commas
    import csv, io
    f = io.StringIO(text)
    return list(csv.DictReader(f))

def load_channels_from_sheet():
    """
    Sheet headers expected:
      handle, display_name, channel_id, subscribers
    subscribers can be blank; it will be used only as fallback.
    """
    csv_text = http_get(CHANNEL_SHEET_CSV)
    rows = parse_simple_csv(csv_text)

    channels = []
    for r in rows:
        cid = (r.get("channel_id") or "").strip()
        if not cid:
            continue

        handle = (r.get("handle") or "").strip()
        display = (r.get("display_name") or "").strip()

        # fallback subscribers from sheet (optional)
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

    # Primary: player response
    player = extract_player_response(html)
    if player:
        status, start_ts, end_ts = get_live_status(player)
        if status in ("live", "upcoming"):
            # Some lives may not expose startTimestamp reliably — use "now" as fallback for live
            if status == "live" and not start_ts:
                now_et = datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")
                return {"status": "live", "start_et": now_et, "end_et": ""}
            if start_ts:
                return {
                    "status": status,
                    "start_et": iso_to_et_fmt(start_ts),
                    "end_et": iso_to_et_fmt(end_ts) if end_ts else ""
                }

    # Secondary: only treat as LIVE if explicitly live
    if '"isLiveNow":true' in html:
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "live", "start_et": iso_to_et_fmt(m.group(1)), "end_et": ""}
        # If live but no timestamp, use now
        now_et = datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")
        return {"status": "live", "start_et": now_et, "end_et": ""}

    # Upcoming: ONLY if page says upcoming (prevents old-video false positives)
    if ('"isUpcoming":true' in html) or ('"upcomingEventData"' in html):
        m = re.search(r'"startTimestamp":"([^"]+)"', html)
        if m:
            return {"status": "upcoming", "start_et": iso_to_et_fmt(m.group(1)), "end_et": ""}

    return None


def fetch_channel_live_video_id(channel_id: str, handle: str = "") -> str:
    """
    Robust free live detection.
    Checks these pages in order:
      1) /channel/<id>/live (redirect)
      2) /channel/<id>/streams (HTML)
      3) /@<handle>/live (redirect)
      4) /@<handle>/streams (HTML)

    On HTML pages, we specifically look for isLiveNow:true and grab the nearest videoId.
    """
    def try_redirect(url: str) -> str:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                final_url = resp.geturl()
            m = re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", final_url)
            return m.group(1) if m else ""
        except Exception:
            return ""

    def try_html_for_live(url: str) -> str:
        try:
            html = http_get(url)

            # Look for videoId near isLiveNow:true (both directions)
            m1 = re.search(r'"videoId":"([A-Za-z0-9_-]{6,})".{0,800}"isLiveNow":true', html, re.DOTALL)
            if m1:
                return m1.group(1)

            m2 = re.search(r'"isLiveNow":true.{0,800}"videoId":"([A-Za-z0-9_-]{6,})"', html, re.DOTALL)
            if m2:
                return m2.group(1)

            return ""
        except Exception:
            return ""

    urls_live = [f"https://www.youtube.com/channel/{channel_id}/live"]
    urls_streams = [f"https://www.youtube.com/channel/{channel_id}/streams"]

    h = (handle or "").strip().lstrip("@")
    if h:
        urls_live.append(f"https://www.youtube.com/@{h}/live")
        urls_streams.append(f"https://www.youtube.com/@{h}/streams")

    # 1) try redirects first
    for u in urls_live:
        vid = try_redirect(u)
        if vid:
            return vid

    # 2) scrape streams pages for isLiveNow:true
    for u in urls_streams:
        vid = try_html_for_live(u)
        if vid:
            return vid

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
    channels = load_channels_from_sheet()
    if not channels:
        raise SystemExit("No channels found in channel sheet CSV (check headers + publish link).")

    print("Loaded channels from sheet:", len(channels))
    print("Channel IDs:", [c["channel_id"] for c in channels])

    events = []
    seen = set()

    for ch in channels:
        cid = ch["channel_id"]

        scraped_subs = fetch_channel_subscribers(cid)
        subs = scraped_subs if scraped_subs > 0 else int(ch.get("sheet_subscribers", 0) or 0)

        sheet_name = (ch.get("display_name") or "").strip()
        sheet_handle = (ch.get("handle") or "").strip()
        preferred_name = sheet_name or (f"@{sheet_handle}" if sheet_handle else "")

        # --- LIVE probe ---
        live_vid = fetch_channel_live_video_id(cid)
        if live_vid:
            print("LIVE candidate:", cid, live_vid, preferred_name)

        if live_vid and live_vid not in seen:
            time.sleep(0.35)
            details = fetch_video_details(live_vid)
            print("LIVE candidate details:", live_vid, details)

            if details and details["status"] == "live":
                seen.add(live_vid)
                events.append({
                    "start_et": details["start_et"],
                    "end_et": details["end_et"],
                    "title": "LIVE (unscheduled)",
                    "league": "",
                    "platform": "YouTube",
                    "channel": preferred_name,
                    "watch_url": f"https://www.youtube.com/watch?v={live_vid}",
                    "source_id": live_vid,
                    "status": details["status"],
                    "thumbnail_url": f"https://i.ytimg.com/vi/{live_vid}/hqdefault.jpg",
                    "subscribers": subs,
                })

        # --- FEED scan ---
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

            yt_name = (item.get("channel") or "").strip()
            final_name = preferred_name or yt_name or ""

            events.append({
                "start_et": details["start_et"],
                "end_et": details["end_et"],
                "title": item.get("title", ""),
                "league": "",
                "platform": "YouTube",
                "channel": final_name,
                "watch_url": item.get("watch_url", ""),
                "source_id": vid,
                "status": details["status"],
                "thumbnail_url": item.get("thumbnail_url", "") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "subscribers": subs,
            })

    events.sort(key=lambda x: x["start_et"])

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"Wrote {len(events)} events to {OUT_PATH}")


if __name__ == "__main__":
    main()
