import os
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

import xml.etree.ElementTree as ET  # kept in case you still want RSS later
import re  # kept in case you still want scraping later


ET_TZ = ZoneInfo("America/New_York")

CHANNEL_SHEET_CSV = os.environ.get(
    "CHANNEL_SHEET_CSV",
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv",
)
OUT_PATH = os.environ.get("OUT_PATH", "schedule.json")

# REQUIRED: set this in GitHub repo secrets
YT_API_KEY = os.environ.get("YT_API_KEY", "").strip()

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/1.0)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
}


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def parse_simple_csv(text: str):
    import csv
    import io

    f = io.StringIO(text)
    return list(csv.DictReader(f))


def load_channels_from_sheet():
    """
    Sheet headers expected:
      handle, display_name, channel_id, subscribers
    subscribers optional (fallback only)
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


def iso_to_et_fmt(iso: str) -> str:
    # YouTube returns RFC3339, e.g. 2026-01-15T22:00:00Z
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")


# -------------------- YouTube Data API helpers --------------------
API_BASE = "https://www.googleapis.com/youtube/v3"


def yt_get(path: str, params: dict) -> dict:
    if not YT_API_KEY:
        raise SystemExit("Missing YT_API_KEY env var (add it to GitHub Secrets).")

    q = dict(params or {})
    q["key"] = YT_API_KEY
    url = f"{API_BASE}/{path}?{urllib.parse.urlencode(q)}"

    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=45) as resp:
        raw = resp.read().decode("utf-8", errors="ignore")
    try:
        return json.loads(raw)
    except Exception:
        return {}


def yt_channels_list(channel_id: str) -> dict:
    # part=contentDetails for uploads playlist, part=statistics for subscriberCount
    data = yt_get(
        "channels",
        {
            "part": "contentDetails,statistics",
            "id": channel_id,
            "maxResults": 1,
        },
    )
    items = data.get("items") or []
    return items[0] if items else {}


def yt_playlistitems_latest(playlist_id: str, max_results: int = 3) -> list[str]:
    data = yt_get(
        "playlistItems",
        {
            "part": "contentDetails",
            "playlistId": playlist_id,
            "maxResults": max_results,
        },
    )
    items = data.get("items") or []
    vids = []
    for it in items:
        cd = it.get("contentDetails") or {}
        vid = cd.get("videoId")
        if vid:
            vids.append(vid)
    return vids


def yt_videos_details(video_ids: list[str]) -> list[dict]:
    if not video_ids:
        return []
    data = yt_get(
        "videos",
        {
            "part": "snippet,liveStreamingDetails",
            "id": ",".join(video_ids),
            "maxResults": len(video_ids),
        },
    )
    return data.get("items") or []


def classify_video(item: dict) -> dict | None:
    """
    Returns event dict for live or upcoming, else None.
    """
    vid = item.get("id", "")
    snippet = item.get("snippet") or {}
    live = item.get("liveStreamingDetails") or {}

    title = snippet.get("title") or ""
    thumbs = snippet.get("thumbnails") or {}
    thumb_url = (
        (thumbs.get("maxres") or {}).get("url")
        or (thumbs.get("standard") or {}).get("url")
        or (thumbs.get("high") or {}).get("url")
        or (thumbs.get("medium") or {}).get("url")
        or (thumbs.get("default") or {}).get("url")
        or ""
    )

    # liveStreamingDetails keys:
    # scheduledStartTime, actualStartTime, actualEndTime
    scheduled = live.get("scheduledStartTime")
    actual_start = live.get("actualStartTime")
    actual_end = live.get("actualEndTime")

    status = None
    start_iso = None
    end_iso = None

    if actual_start and not actual_end:
        status = "live"
        start_iso = actual_start
        end_iso = actual_end
    elif scheduled and not actual_start:
        status = "upcoming"
        start_iso = scheduled
        end_iso = actual_end

    if not status or not start_iso:
        return None

    return {
        "start_et": iso_to_et_fmt(start_iso),
        "end_et": iso_to_et_fmt(end_iso) if end_iso else "",
        "title": title,
        "league": "",
        "platform": "YouTube",
        "channel": "",  # filled by caller
        "watch_url": f"https://www.youtube.com/watch?v={vid}",
        "source_id": vid,
        "status": status,
        "thumbnail_url": thumb_url or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "subscribers": 0,  # filled by caller
    }


# -------------------- Main --------------------
def main():
    channels = load_channels_from_sheet()
    if not channels:
        raise SystemExit("No channels found in channel sheet CSV (check headers + publish link).")

    print("Loaded channels from sheet:", len(channels))

    events: list[dict] = []
    seen: set[str] = set()

    # Throttle a bit to be polite
    def nap():
        time.sleep(0.12)

    for ch in channels:
        cid = ch["channel_id"]
        handle = (ch.get("handle") or "").strip().lstrip("@")
        sheet_name = (ch.get("display_name") or "").strip()
        preferred_name = sheet_name or (f"@{handle}" if handle else cid)

        print("-----")
        print("Channel:", cid, "handle:", handle, "name:", preferred_name)

        ch_info = yt_channels_list(cid)
        nap()

        # uploads playlist
        uploads = (
            ((ch_info.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
            or ""
        )

        # subs
        subs_str = ((ch_info.get("statistics") or {}).get("subscriberCount") or "").strip()
        try:
            subs = int(subs_str) if subs_str else 0
        except Exception:
            subs = 0

        if subs <= 0:
            subs = int(ch.get("sheet_subscribers") or 0)

        if not uploads:
            print("No uploads playlist found for channel (skipping).")
            continue

        # Pull latest few uploads, then check only first 2 for live/upcoming
        latest_video_ids = yt_playlistitems_latest(uploads, max_results=4)
        nap()

        if not latest_video_ids:
            print("No playlist items found (skipping).")
            continue

        # Keep quota low: inspect only first 2 videos
        inspect_ids = latest_video_ids[:2]
        video_items = yt_videos_details(inspect_ids)
        nap()

        found_live_here = False
        for it in video_items:
            ev = classify_video(it)
            if not ev:
                continue

            vid = ev["source_id"]
            if vid in seen:
                continue

            ev["channel"] = preferred_name
            ev["subscribers"] = subs

            seen.add(vid)
            events.append(ev)

            if ev["status"] == "live":
                found_live_here = True

        if not found_live_here:
            print("No LIVE detected right now (via API).")

    # sort: live first, then by time, tie by subs desc
    def sort_key(e: dict):
        live_rank = 0 if e.get("status") == "live" else 1
        # start_et is already YYYY-MM-DD HH:MM, lexicographic sort works
        return (live_rank, e.get("start_et", "9999-99-99 99:99"), -(int(e.get("subscribers") or 0)))

    events.sort(key=sort_key)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"Wrote {len(events)} events to {OUT_PATH}")


if __name__ == "__main__":
    main()
