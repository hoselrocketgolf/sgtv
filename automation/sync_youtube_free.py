import os, csv, io, json, time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import urllib.request
import urllib.parse

ET_TZ = ZoneInfo("America/New_York")

DEFAULT_CHANNEL_SHEET_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv"

def env_or_default(name: str, default: str) -> str:
    v = (os.environ.get(name) or "").strip()
    return v if v else default

CHANNEL_SHEET_CSV = env_or_default("CHANNEL_SHEET_CSV", DEFAULT_CHANNEL_SHEET_CSV)
OUT_PATH = env_or_default("OUT_PATH", "schedule.json")
YT_API_KEY = (os.environ.get("YT_API_KEY") or "").strip()

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/2.0)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
}

# --------- HTTP helpers ---------
def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def http_get_json(url: str) -> dict:
    txt = http_get(url)
    return json.loads(txt)

def yt_api(endpoint: str, params: dict) -> dict:
    if not YT_API_KEY:
        raise SystemExit("Missing YT_API_KEY env var (add it to GitHub Secrets).")
    q = dict(params)
    q["key"] = YT_API_KEY
    url = f"https://www.googleapis.com/youtube/v3/{endpoint}?{urllib.parse.urlencode(q)}"
    return http_get_json(url)

# --------- CSV sheet -> channels ---------
def parse_simple_csv(text: str):
    f = io.StringIO(text)
    return list(csv.DictReader(f))

def load_channels_from_sheet():
    """
    Sheet headers expected:
      handle, display_name, channel_id, subscribers
    subscribers may be blank (fallback only).
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

# --------- Time helpers ---------
def iso_to_et_fmt(iso: str) -> str:
    # ISO timestamps from API are UTC with 'Z'
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

def now_utc() -> datetime:
    return datetime.now(timezone.utc)

# --------- YouTube API strategy (fast + reliable) ---------
# 1) channels.list (batch): get uploads playlist + subscriber count + channel title
# 2) playlistItems.list per channel: pull latest N uploads (includes live/upcoming items)
# 3) videos.list (batched): read liveStreamingDetails to classify live/upcoming

def chunked(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i+n]

def fetch_channels_meta(channel_ids: list[str]) -> dict:
    """
    Returns map[channel_id] -> {
      uploads_playlist_id, subscribers, channel_title
    }
    """
    meta = {}
    for batch in chunked(channel_ids, 50):
        resp = yt_api("channels", {
            "part": "contentDetails,statistics,snippet",
            "id": ",".join(batch),
            "maxResults": 50
        })
        for item in resp.get("items", []):
            cid = item.get("id", "")
            uploads = (((item.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")) or ""
            subs_raw = ((item.get("statistics") or {}).get("subscriberCount")) or "0"
            try:
                subs = int(subs_raw)
            except Exception:
                subs = 0
            title = ((item.get("snippet") or {}).get("title")) or ""
            if cid and uploads:
                meta[cid] = {
                    "uploads_playlist_id": uploads,
                    "subscribers": subs,
                    "channel_title": title
                }
    return meta

def fetch_uploads_video_ids(uploads_playlist_id: str, max_results: int = 20) -> list[str]:
    resp = yt_api("playlistItems", {
        "part": "contentDetails",
        "playlistId": uploads_playlist_id,
        "maxResults": max_results
    })
    vids = []
    for it in resp.get("items", []):
        vid = (((it.get("contentDetails") or {}).get("videoId")) or "").strip()
        if vid:
            vids.append(vid)
    return vids

def fetch_videos_details(video_ids: list[str]) -> dict:
    """
    Returns map[video_id] -> video item (snippet + liveStreamingDetails)
    """
    out = {}
    for batch in chunked(video_ids, 50):
        resp = yt_api("videos", {
            "part": "snippet,liveStreamingDetails",
            "id": ",".join(batch),
            "maxResults": 50
        })
        for item in resp.get("items", []):
            vid = item.get("id", "")
            if vid:
                out[vid] = item
    return out

def pick_thumb(snippet: dict) -> str:
    thumbs = (snippet or {}).get("thumbnails") or {}
    for k in ["maxres", "standard", "high", "medium", "default"]:
        u = ((thumbs.get(k) or {}).get("url")) or ""
        if u:
            return u
    return ""

def classify_video(item: dict) -> tuple[str | None, str | None]:
    """
    Returns (status, start_iso)
      status: "live" | "upcoming" | None
      start_iso: ISO timestamp string or None
    """
    lsd = (item.get("liveStreamingDetails") or {})
    snippet = (item.get("snippet") or {})
    live_content = (snippet.get("liveBroadcastContent") or "").lower()

    actual_start = lsd.get("actualStartTime")
    actual_end = lsd.get("actualEndTime")
    scheduled_start = lsd.get("scheduledStartTime")

    # Live if started and not ended
    if actual_start and not actual_end:
        return "live", actual_start

    # Upcoming if scheduled but not started
    if scheduled_start and not actual_start:
        return "upcoming", scheduled_start

    # Sometimes snippet marks it; keep safe fallbacks
    if live_content == "live" and actual_start and not actual_end:
        return "live", actual_start
    if live_content == "upcoming" and scheduled_start:
        return "upcoming", scheduled_start

    return None, None

# --------- Main ---------
def main():
    channels = load_channels_from_sheet()
    if not channels:
        raise SystemExit("No channels found in channel sheet CSV (check publish link + headers).")

    print("Loaded channels from sheet:", len(channels))

    channel_ids = [c["channel_id"] for c in channels]
    meta = fetch_channels_meta(channel_ids)

    # Map for quick lookup of sheet fields
    sheet_by_id = {c["channel_id"]: c for c in channels}

    events = []
    seen_video_ids = set()

    # Build a big list of candidate vids from uploads for all channels
    all_candidate_vids = []
    per_channel_candidate = {}

    for cid in channel_ids:
        m = meta.get(cid)
        if not m:
            print("WARN: channel meta missing (bad channel_id?):", cid)
            continue

        uploads = m["uploads_playlist_id"]
        vids = fetch_uploads_video_ids(uploads, max_results=20)
        per_channel_candidate[cid] = vids
        all_candidate_vids.extend(vids)

        # throttle lightly to be nice
        time.sleep(0.05)

    # Fetch details in batches
    video_details = fetch_videos_details(sorted(set(all_candidate_vids)))

    # Filter to LIVE + upcoming soon
    upcoming_horizon = now_utc() + timedelta(days=7)

    for cid, vids in per_channel_candidate.items():
        m = meta.get(cid) or {}
        sheet = sheet_by_id.get(cid) or {}

        # subscribers: API first, fallback to sheet
        subs_api = int(m.get("subscribers") or 0)
        subs_sheet = int(sheet.get("sheet_subscribers") or 0)
        subs = subs_api if subs_api > 0 else subs_sheet

        # channel name: sheet display_name > @handle > youtube title
        handle = (sheet.get("handle") or "").strip().lstrip("@")
        sheet_name = (sheet.get("display_name") or "").strip()
        yt_title = (m.get("channel_title") or "").strip()
        channel_name = sheet_name or (f"@{handle}" if handle else "") or yt_title or ""

        print("-----")
        print(f"Channel: {cid} name: {channel_name} subs(api): {subs_api} subs(sheet): {subs_sheet}")

        found_live_for_channel = False

        for vid in vids:
            item = video_details.get(vid)
            if not item:
                continue

            status, start_iso = classify_video(item)
            if not status or not start_iso:
                continue

            # Upcoming filter window
            if status == "upcoming":
                try:
                    start_dt = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
                    if start_dt > upcoming_horizon:
                        continue
                except Exception:
                    pass

            if vid in seen_video_ids:
                continue
            seen_video_ids.add(vid)

            snippet = item.get("snippet") or {}
            title = (snippet.get("title") or "").strip()
            thumb = pick_thumb(snippet) or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"

            # Mark we found live
            if status == "live":
                found_live_for_channel = True

            events.append({
                "start_et": iso_to_et_fmt(start_iso),
                "end_et": "",  # can add later if you want actualEndTime
                "title": title,
                "league": "",
                "platform": "YouTube",
                "channel": channel_name,
                "watch_url": f"https://www.youtube.com/watch?v={vid}",
                "source_id": vid,
                "status": status,
                "thumbnail_url": thumb,
                "subscribers": subs
            })

        if not found_live_for_channel:
            print("No LIVE detected right now.")

    # Sort: live first, then by time, tie by subs desc
    def sort_key(e):
        live_rank = 0 if e.get("status") == "live" else 1
        return (
            live_rank,
            e.get("start_et", "9999-99-99 99:99"),
            -(int(e.get("subscribers") or 0))
        )

    events.sort(key=sort_key)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

    print(f"-----\nWrote {len(events)} events to {OUT_PATH}")

if __name__ == "__main__":
    main()
