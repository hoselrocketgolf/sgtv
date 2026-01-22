import os, csv, io, json, time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import urllib.request
import urllib.parse
import urllib.error

ET_TZ = ZoneInfo("America/New_York")

DEFAULT_CHANNEL_SHEET_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv"

def env_or_default(name: str, default: str) -> str:
    v = (os.environ.get(name) or "").strip()
    return v if v else default

CHANNEL_SHEET_CSV = env_or_default("CHANNEL_SHEET_CSV", DEFAULT_CHANNEL_SHEET_CSV)
SCHEDULE_SHEET_CSV = (os.environ.get("SCHEDULE_SHEET_CSV") or "").strip()
OUT_PATH = env_or_default("OUT_PATH", "schedule.json")
YT_API_KEY = (os.environ.get("YT_API_KEY") or "").strip()

# How many recent uploads to scan per channel (more = better live detection, still cheap)
MAX_UPLOAD_SCAN = int(env_or_default("MAX_UPLOAD_SCAN", "30"))
# Ignore uploads older than this many days when scanning playlist items.
# This reduces API usage as you scale channel count.
UPLOAD_LOOKBACK_DAYS = int(env_or_default("UPLOAD_LOOKBACK_DAYS", "30"))
# How far ahead to keep upcoming streams (days).
UPCOMING_HORIZON_DAYS = int(env_or_default("UPCOMING_HORIZON_DAYS", "7"))
# How far back to keep ended live streams (hours).
RECENT_ENDED_HOURS = int(env_or_default("RECENT_ENDED_HOURS", "36"))
# Treat "live" streams older than this many hours as stale and drop them.
MAX_LIVE_HOURS = int(env_or_default("MAX_LIVE_HOURS", "4"))
# How many live results to pull from Search API per channel (0 disables Search API usage).
SEARCH_LIVE_MAX_RESULTS = int(env_or_default("SEARCH_LIVE_MAX_RESULTS", "0"))

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/2.1)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
}

# --------- HTTP helpers ---------
def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=45) as resp:
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

def normalize_headers(headers: list[str]) -> list[str]:
    return [h.strip().lstrip("\ufeff").lower() for h in headers]

def load_schedule_from_sheet(csv_url: str) -> list[dict]:
    csv_text = http_get(csv_url)
    f = io.StringIO(csv_text)
    reader = csv.DictReader(f)
    if not reader.fieldnames:
        return []

    headers = normalize_headers(reader.fieldnames)
    key_map = {h: i for i, h in enumerate(headers)}

    def get_val(row: dict, keys: list[str]) -> str:
        for key in keys:
            if key in key_map and key in row:
                return (row.get(key) or "").strip()
        return ""

    events = []
    for row in reader:
        normalized_row = {}
        for raw_key, value in row.items():
            norm_key = raw_key.strip().lstrip("\ufeff").lower()
            normalized_row[norm_key] = (value or "").strip()

        start_et = get_val(normalized_row, ["start_et", "start", "time", "start time", "start_time"])
        end_et = get_val(normalized_row, ["end_et", "end", "end time", "end_time"])
        title = get_val(normalized_row, ["title", "event", "name"])
        league = get_val(normalized_row, ["league", "tour"])
        platform = get_val(normalized_row, ["platform"])
        channel = get_val(normalized_row, ["channel", "channel_name", "host"])
        watch_url = get_val(normalized_row, ["watch_url", "url", "link", "watch", "watch url"])
        status = get_val(normalized_row, ["status", "live_status"])
        event_type = get_val(normalized_row, ["type", "event_type"])
        is_premiere = get_val(normalized_row, ["is_premiere", "ispremiere", "premiere"])
        thumbnail_url = get_val(normalized_row, ["thumbnail_url", "thumb", "thumbnail"])
        subscribers = get_val(normalized_row, ["subscribers", "subs"])

        if not watch_url:
            continue

        status_normalized = (status or "").strip().lower()
        if not start_et:
            if status_normalized == "live":
                start_et = now_et_fmt()
            else:
                continue

        try:
            subs = int(float(subscribers.replace(",", ""))) if subscribers else 0
        except Exception:
            subs = 0

        events.append({
            "start_et": start_et,
            "end_et": end_et,
            "title": title,
            "league": league,
            "platform": platform,
            "channel": channel,
            "watch_url": watch_url,
            "type": event_type,
            "is_premiere": is_premiere.lower() in {"true", "yes", "1"},
            "status": status_normalized or "upcoming",
            "thumbnail_url": thumbnail_url,
            "subscribers": subs,
        })

    return events

def write_schedule(events: list[dict], out_path: str) -> None:
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)

def load_channels_from_sheet():
    """
    Sheet headers expected:
      handle, display_name, channel_id, subscribers
    Only channel_id is required.
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
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

def now_et_fmt() -> str:
    return datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M")

def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def parse_iso(iso: str) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None

# --------- YouTube API strategy ---------
# 1) channels.list (batch): uploads playlist + subscriber count + channel title
# 2) playlistItems.list per channel: pull latest MAX_UPLOAD_SCAN
# 3) videos.list (batched): read liveStreamingDetails to classify live/upcoming

def chunked(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i+n]

def fetch_channels_meta(channel_ids: list[str]) -> dict:
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

def fetch_uploads_video_ids(
    uploads_playlist_id: str,
    max_results: int = 50,
    lookback_days: int = 30
) -> list[str]:
    vids = []
    page_token = None
    now = now_utc()
    cutoff = now - timedelta(days=lookback_days)

    # PlaylistItems maxResults per page is 50
    while len(vids) < max_results:
        per_page = min(50, max_results - len(vids))
        params = {
            "part": "contentDetails",
            "playlistId": uploads_playlist_id,
            "maxResults": per_page
        }
        if page_token:
            params["pageToken"] = page_token

        resp = yt_api("playlistItems", params)
        items = resp.get("items", [])

        for item in items:
            content = item.get("contentDetails") or {}
            vid = (content.get("videoId") or "").strip()
            published_at = content.get("videoPublishedAt") or ""
            dt = parse_iso(published_at)
            if not vid:
                continue
            if dt and dt < cutoff:
                return vids
            vids.append(vid)
            if len(vids) >= max_results:
                break

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

        # small throttle
        time.sleep(0.05)

    return vids

def fetch_videos_details(video_ids: list[str]) -> dict:
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

def fetch_search_live_video_ids(channel_id: str, max_results: int) -> list[str]:
    """
    Pull live video IDs from the Search API to catch live streams
    that may not be present in the uploads playlist (e.g., vertical live).
    """
    resp = yt_api("search", {
        "part": "snippet",
        "channelId": channel_id,
        "eventType": "live",
        "type": "video",
        "order": "date",
        "maxResults": max_results
    })
    vids = []
    for item in resp.get("items", []):
        vid = (((item.get("id") or {}).get("videoId")) or "").strip()
        if vid:
            vids.append(vid)
    return vids

def pick_thumb(snippet: dict) -> str:
    thumbs = (snippet or {}).get("thumbnails") or {}
    for k in ["maxres", "standard", "high", "medium", "default"]:
        u = ((thumbs.get(k) or {}).get("url")) or ""
        if u:
            return u
    return ""

def classify_video(item: dict) -> tuple[str | None, str | None, str | None]:
    """
    Returns (status, start_iso, end_iso)
      status: "live" | "upcoming" | "ended" | None
    """
    lsd = (item.get("liveStreamingDetails") or {})
    snippet = (item.get("snippet") or {})
    live_content = (snippet.get("liveBroadcastContent") or "").lower()

    actual_start = lsd.get("actualStartTime")
    actual_end = lsd.get("actualEndTime")
    scheduled_start = lsd.get("scheduledStartTime")

    # Ended if started and ended
    if actual_start and actual_end:
        return "ended", actual_start, actual_end

    # Live if started and not ended
    if actual_start and not actual_end:
        return "live", actual_start, None

    # Upcoming if scheduled but not started
    if scheduled_start and not actual_start:
        return "upcoming", scheduled_start, None

    # Fallbacks (rare)
    if live_content == "live" and actual_start and not actual_end:
        return "live", actual_start, None
    if live_content == "upcoming" and scheduled_start:
        return "upcoming", scheduled_start, None

    return None, None, None

def is_stale_upcoming(start_iso: str, now: datetime) -> bool:
    """
    If YouTube says 'upcoming' but the scheduled time is in the past,
    it’s almost always a canceled/never-went-live placeholder.
    Drop it if it's older than 30 minutes ago.
    """
    dt = parse_iso(start_iso)
    if not dt:
        return False
    return dt < (now - timedelta(minutes=30))

# --------- Main ---------
def main():
    if SCHEDULE_SHEET_CSV:
        try:
            events = load_schedule_from_sheet(SCHEDULE_SHEET_CSV)
            if events:
                events.sort(key=lambda e: (e.get("start_et", "9999-99-99 99:99")))
                write_schedule(events, OUT_PATH)
                print(f"Wrote {len(events)} events to {OUT_PATH} from schedule sheet.")
                return
            print("Schedule sheet returned no rows. Falling back to YouTube API.")
        except Exception as exc:
            print(f"Failed to load schedule sheet: {exc}. Falling back to YouTube API.")

    if not YT_API_KEY:
        print("Missing YT_API_KEY env var. Skipping sync to avoid failing scheduled workflow.")
        return

    try:
        channels = load_channels_from_sheet()
        if not channels:
            print("No channels found in channel sheet CSV (check publish link + headers). Skipping sync.")
            return

        print("Loaded channels from sheet:", len(channels))
        print("Scanning uploads per channel:", MAX_UPLOAD_SCAN)
        print("Upload lookback days:", UPLOAD_LOOKBACK_DAYS)
        print("Upcoming horizon days:", UPCOMING_HORIZON_DAYS)
        print("Recent ended hours:", RECENT_ENDED_HOURS)
        print("Max live hours:", MAX_LIVE_HOURS)
        print("Search live max results:", SEARCH_LIVE_MAX_RESULTS)
        if SEARCH_LIVE_MAX_RESULTS == 0:
            print("Search API disabled to reduce quota usage.")

        channel_ids = [c["channel_id"] for c in channels]
        meta = fetch_channels_meta(channel_ids)

        sheet_by_id = {c["channel_id"]: c for c in channels}

        events = []
        seen_video_ids = set()

        all_candidate_vids = []
        per_channel_candidate = {}

        # Gather candidates
        for cid in channel_ids:
            m = meta.get(cid)
            if not m:
                print("WARN: channel meta missing (bad channel_id?):", cid)
                continue

            uploads = m["uploads_playlist_id"]
            vids = fetch_uploads_video_ids(
                uploads,
                max_results=MAX_UPLOAD_SCAN,
                lookback_days=UPLOAD_LOOKBACK_DAYS
            )
            if SEARCH_LIVE_MAX_RESULTS > 0:
                live_vids = fetch_search_live_video_ids(cid, SEARCH_LIVE_MAX_RESULTS)
                if live_vids:
                    vids = list(dict.fromkeys(live_vids + vids))
            per_channel_candidate[cid] = vids
            all_candidate_vids.extend(vids)

            time.sleep(0.05)

        # Fetch details for all unique candidates
        video_details = fetch_videos_details(sorted(set(all_candidate_vids)))

        now = now_utc()
        upcoming_horizon = now + timedelta(days=UPCOMING_HORIZON_DAYS)
        ended_cutoff = now - timedelta(hours=RECENT_ENDED_HOURS)

        for cid, vids in per_channel_candidate.items():
            m = meta.get(cid) or {}
            sheet = sheet_by_id.get(cid) or {}

            subs_api = int(m.get("subscribers") or 0)
            subs_sheet = int(sheet.get("sheet_subscribers") or 0)
            subs = subs_api if subs_api > 0 else subs_sheet

            handle = (sheet.get("handle") or "").strip().lstrip("@")
            sheet_name = (sheet.get("display_name") or "").strip()
            yt_title = (m.get("channel_title") or "").strip()
            channel_name = sheet_name or (f"@{handle}" if handle else "") or yt_title or ""

            print("-----")
            print(f"Channel: {cid} name: {channel_name} subs(api): {subs_api} subs(sheet): {subs_sheet}")

            found_live = False

            for vid in vids:
                item = video_details.get(vid)
                if not item:
                    continue

                status, start_iso, end_iso = classify_video(item)
                if not status or not start_iso:
                    continue

                # Kill stale "upcoming" that are already in the past (canceled/never-live)
                if status == "upcoming" and is_stale_upcoming(start_iso, now):
                    continue

                if status == "live":
                    start_dt = parse_iso(start_iso)
                    if start_dt and start_dt < (now - timedelta(hours=MAX_LIVE_HOURS)):
                        continue

                # Upcoming filter window (next 7 days only)
                if status == "upcoming":
                    start_dt = parse_iso(start_iso)
                    if start_dt and start_dt > upcoming_horizon:
                        continue
                if status == "ended":
                    end_dt = parse_iso(end_iso) if end_iso else None
                    if not end_dt or end_dt < ended_cutoff:
                        continue

                if vid in seen_video_ids:
                    continue
                seen_video_ids.add(vid)

                snippet = item.get("snippet") or {}
                title = (snippet.get("title") or "").strip()
                thumb = pick_thumb(snippet) or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"

                if status == "live":
                    found_live = True

                events.append({
                    "start_et": iso_to_et_fmt(start_iso),
                    "end_et": iso_to_et_fmt(end_iso) if end_iso else "",
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

            if not found_live:
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

        write_schedule(events, OUT_PATH)

        print(f"-----\nWrote {len(events)} events to {OUT_PATH}")
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            print("YouTube API request returned 403 (invalid key or quota). Skipping sync.")
            return
        print(f"YouTube API request failed with HTTP {exc.code}. Skipping sync.")
        return

if __name__ == "__main__":
    main()
