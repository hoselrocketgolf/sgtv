import os, csv, io, json, time, re, html
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

ET_TZ = ZoneInfo("America/New_York")

DEFAULT_CHANNEL_SHEET_CSV = "https://docs.google.com/spreadsheets/d/1UW39_s_KFxaGjQ75Lq2YH6Z29JHJhIP1rD_uagD144k/export?format=csv&gid=0"

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

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.tiktok.com/",
    "Origin": "https://www.tiktok.com",
}

COOKIE_JAR = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(COOKIE_JAR))

# --------- HTTP helpers ---------
def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=REQ_HEADERS)
    with OPENER.open(req, timeout=45) as resp:
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
    Sheet headers expected (case-insensitive):
      platform, handle, display_name, channel_id, tiktok_url, subscribers
    For YouTube rows, channel_id is required.
    For TikTok rows, handle or tiktok_url is required.
    """
    csv_text = http_get(CHANNEL_SHEET_CSV)
    rows = parse_simple_csv(csv_text)
    if not rows:
        return []

    print("Sheet headers:", list(rows[0].keys()))

    channels = []
    for r in rows:
        platform = (r.get("platform") or "").strip()
        platform_norm = platform.lower() if platform else "youtube"

        cid = (r.get("channel_id") or "").strip()
        handle = (r.get("handle") or "").strip().lstrip("@")
        display = (r.get("display_name") or "").strip()
        tiktok_url = (r.get("tiktok_url") or "").strip()

        if platform_norm == "youtube" and not cid:
            continue
        if platform_norm == "tiktok" and not (handle or tiktok_url):
            continue

        sub_raw = (r.get("subscribers") or "").strip().replace(",", "")
        try:
            sheet_subs = int(float(sub_raw)) if sub_raw else 0
        except Exception:
            sheet_subs = 0

        channels.append({
            "platform": platform if platform else "YouTube",
            "channel_id": cid,
            "handle": handle,
            "display_name": display,
            "tiktok_url": tiktok_url,
            "sheet_subscribers": sheet_subs,
        })

    return channels

# --------- TikTok helpers ---------
def warm_tiktok_cookies() -> None:
    try:
        req = urllib.request.Request("https://www.tiktok.com/", headers=REQ_HEADERS)
        with OPENER.open(req, timeout=45):
            return
    except Exception:
        return

def resolve_tiktok_url(tiktok_url: str) -> str:
    if not tiktok_url:
        return ""
    try:
        warm_tiktok_cookies()
        req = urllib.request.Request(tiktok_url, headers=REQ_HEADERS)
        with OPENER.open(req, timeout=45) as resp:
            return resp.geturl() or tiktok_url
    except Exception:
        return tiktok_url

def normalize_tiktok_handle(handle: str, tiktok_url: str) -> str:
    if handle:
        return handle.lstrip("@").strip().lower()
    if not tiktok_url:
        return ""
    match = re.search(r"/@([^/?#]+)", tiktok_url)
    if not match:
        resolved_url = resolve_tiktok_url(tiktok_url)
        match = re.search(r"/@([^/?#]+)", resolved_url)
    return match.group(1).lower() if match else ""

def normalize_tiktok_profile_url(tiktok_url: str) -> str:
    if not tiktok_url:
        return ""
    parsed = urllib.parse.urlparse(tiktok_url)
    if not parsed.scheme:
        parsed = urllib.parse.urlparse(f"https://{tiktok_url.lstrip('/')}")
    if not parsed.netloc:
        return ""
    if "/@" not in parsed.path:
        resolved_url = resolve_tiktok_url(tiktok_url)
        parsed = urllib.parse.urlparse(resolved_url)
        if not parsed.netloc:
            return ""
    clean_path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{clean_path}"

def ensure_tiktok_live_url(handle: str, tiktok_url: str) -> str:
    normalized_handle = normalize_tiktok_handle(handle, tiktok_url)
    if normalized_handle:
        return f"https://www.tiktok.com/@{normalized_handle}/live"
    normalized_url = normalize_tiktok_profile_url(tiktok_url)
    if not normalized_url:
        return ""
    return normalized_url if "/live" in normalized_url else f"{normalized_url}/live"

def fetch_tiktok_live_data(handle: str) -> dict | None:
    if not handle:
        return None
    warm_tiktok_cookies()
    endpoints = [
        "https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId=",
        "https://www.tiktok.com/api/live/user/room/?aid=1988&uniqueId=",
    ]
    for base in endpoints:
        url = f"{base}{urllib.parse.quote(handle)}"
        try:
            payload = http_get_json(url)
        except Exception:
            continue
        if isinstance(payload, dict):
            return payload
    return None

def extract_tiktok_room_id(payload: dict | None) -> str:
    if not payload or not isinstance(payload, dict):
        return ""
    data = payload.get("data") or {}
    candidates = [data, data.get("room") or {}, data.get("liveRoom") or {}, data.get("roomInfo") or {}]
    for obj in candidates:
        for key in ["roomId", "room_id", "liveRoomId", "live_room_id"]:
            val = obj.get(key)
            if val:
                return str(val)
    return ""

def extract_tiktok_cover(payload: dict | None) -> str:
    if not payload or not isinstance(payload, dict):
        return ""
    data = payload.get("data") or {}
    room = data.get("room") or data.get("liveRoom") or {}
    for key in ["coverUrl", "cover", "coverImage", "coverUrlList"]:
        val = room.get(key) or data.get(key)
        if isinstance(val, list) and val:
            return str(val[0])
        if isinstance(val, str) and val:
            return val
    return ""

def extract_tiktok_live_state(payload: dict | None) -> bool | None:
    if not payload or not isinstance(payload, dict):
        return None
    data = payload.get("data") or {}
    candidates = [data, data.get("room") or {}, data.get("liveRoom") or {}]
    for obj in candidates:
        is_live = obj.get("isLive")
        if isinstance(is_live, bool):
            return is_live
        for key in ["liveStatus", "live_status", "status", "roomStatus"]:
            val = obj.get(key)
            if isinstance(val, str) and val.isdigit():
                val = int(val)
            if isinstance(val, (int, float)):
                if val in {1, 2}:
                    return True
                if val == 0:
                    return False
    return None

def fetch_tiktok_live_status(handle: str, tiktok_url: str) -> tuple[bool, str, str]:
    payload = fetch_tiktok_live_data(handle)
    room_id = extract_tiktok_room_id(payload)
    live_state = extract_tiktok_live_state(payload)
    if live_state is False:
        return False, "", ""
    if room_id and live_state is not False:
        return True, room_id, extract_tiktok_cover(payload)

    if not tiktok_url:
        return False, "", ""

    try:
        warm_tiktok_cookies()
        html = http_get(tiktok_url)
    except Exception:
        return False, "", ""

    status = extract_tiktok_status_from_html(html)
    if status[0] or status[1]:
        return status

    profile_url = normalize_tiktok_profile_url(tiktok_url)
    if "/live" in tiktok_url and profile_url and profile_url != tiktok_url:
        try:
            warm_tiktok_cookies()
            profile_html = http_get(profile_url)
        except Exception:
            return status
        return extract_tiktok_status_from_html(profile_html)

    return status

def find_first_key_value(data: object, keys: set[str]) -> object | None:
    if isinstance(data, dict):
        for key, value in data.items():
            if key in keys:
                return value
            found = find_first_key_value(value, keys)
            if found is not None:
                return found
    elif isinstance(data, list):
        for item in data:
            found = find_first_key_value(item, keys)
            if found is not None:
                return found
    return None

def extract_tiktok_from_embedded_json(html_text: str) -> tuple[str, int | None, str]:
    scripts = [
        re.search(r'id="SIGI_STATE"[^>]*>(.*?)</script>', html_text, re.DOTALL),
        re.search(r'__UNIVERSAL_DATA_FOR_REHYDRATION__\s*=\s*(\{.*?\})\s*;', html_text, re.DOTALL),
    ]
    for match in scripts:
        if not match:
            continue
        payload_raw = match.group(1).strip()
        if not payload_raw:
            continue
        try:
            payload = json.loads(html.unescape(payload_raw))
        except Exception:
            continue

        room_value = find_first_key_value(payload, {"liveRoomId", "roomId", "room_id", "live_room_id"})
        room_id = str(room_value) if room_value else ""
        status_value = find_first_key_value(payload, {"liveStatus", "status", "roomStatus"})
        try:
            status_code = int(status_value) if status_value is not None else None
        except Exception:
            status_code = None
        cover_value = find_first_key_value(payload, {"coverUrl", "cover", "coverImage"})
        cover = str(cover_value) if cover_value else ""
        return room_id, status_code, cover
    return "", None, ""

def extract_tiktok_status_from_html(html: str) -> tuple[bool, str, str]:
    html_lower = html.lower()
    if "live has ended" in html_lower or "this live has ended" in html_lower:
        return False, "", ""

    embedded_room_id, embedded_status, embedded_cover = extract_tiktok_from_embedded_json(html)
    if embedded_status is not None:
        if embedded_status in {1, 2}:
            return True, embedded_room_id, embedded_cover
        if embedded_status == 0:
            return False, "", ""

    room_match = re.search(r'"liveRoomId"\s*:\s*"(\d+)"', html)
    if not room_match:
        room_match = re.search(r'"roomId"\s*:\s*"(\d+)"', html)
    room_id = room_match.group(1) if room_match else ""

    status_match = re.search(r'"liveStatus"\s*:\s*(\d+)', html)
    if not status_match:
        status_match = re.search(r'"status"\s*:\s*(\d+)', html)
    if not status_match:
        status_match = re.search(r'"roomStatus"\s*:\s*(\d+)', html)

    if status_match:
        code = int(status_match.group(1))
        if code in {1, 2}:
            return True, room_id, ""
        if code == 0:
            return False, "", ""

    live_token = re.search(r'"isLive"\s*:\s*true', html, re.IGNORECASE)
    if live_token:
        return True, room_id, ""

    if room_id or embedded_room_id:
        return True, room_id or embedded_room_id, embedded_cover

    return False, "", ""

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
            "part": "snippet,liveStreamingDetails,contentDetails",
            "id": ",".join(batch),
            "maxResults": 50
        })
        for item in resp.get("items", []):
            vid = item.get("id", "")
            if vid:
                out[vid] = item
    return out

def looks_like_premiere(item: dict) -> bool:
    snippet = item.get("snippet") or {}
    title = (snippet.get("title") or "").lower()
    description = (snippet.get("description") or "").lower()
    if "premiere" in title or "premiere" in description:
        return True
    live_content = (snippet.get("liveBroadcastContent") or "").lower()
    duration = ((item.get("contentDetails") or {}).get("duration") or "").strip()
    # Scheduled videos with a known duration are often premieres (pre-recorded).
    return live_content == "upcoming" and duration not in {"", "PT0S"}

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
    schedule_events = []
    used_schedule_sheet = False

    if SCHEDULE_SHEET_CSV:
        try:
            schedule_events = load_schedule_from_sheet(SCHEDULE_SHEET_CSV)
            if schedule_events:
                used_schedule_sheet = True
                print(f"Loaded {len(schedule_events)} events from schedule sheet.")
            else:
                print("Schedule sheet returned no rows. Falling back to YouTube API.")
        except Exception as exc:
            print(f"Failed to load schedule sheet: {exc}. Falling back to YouTube API.")

    try:
        channels = load_channels_from_sheet()
        if not channels and not schedule_events:
            print("No channels found in channel sheet CSV (check publish link + headers). Skipping sync.")
            return

        if channels:
            print("Loaded channels from sheet:", len(channels))

        youtube_channels = [
            c for c in channels if (c.get("platform") or "").strip().lower() == "youtube"
        ]
        tiktok_channels = [
            c for c in channels if (c.get("platform") or "").strip().lower() == "tiktok"
        ]

        events = list(schedule_events)
        now = now_utc()

        if tiktok_channels:
            print("Scanning TikTok handles:", len(tiktok_channels))
            for channel in tiktok_channels:
                handle = normalize_tiktok_handle(channel.get("handle", ""), channel.get("tiktok_url", ""))
                display_name = (channel.get("display_name") or "").strip()
                subs = int(channel.get("sheet_subscribers") or 0)
                live_url = ensure_tiktok_live_url(handle, channel.get("tiktok_url", ""))

                if not live_url:
                    continue

                is_live, room_id, cover = fetch_tiktok_live_status(handle, live_url)
                if not is_live:
                    continue

                fallback_name = f"@{handle}" if handle else "TikTok creator"
                channel_name = display_name or fallback_name
                title = f"{channel_name} is live on TikTok"

                events.append({
                    "start_et": now_et_fmt(),
                    "end_et": "",
                    "title": title,
                    "league": "",
                    "platform": "TikTok",
                    "channel": channel_name,
                    "watch_url": live_url,
                    "source_id": room_id,
                    "type": "",
                    "is_premiere": False,
                    "status": "live",
                    "thumbnail_url": cover,
                    "subscribers": subs
                })

        if used_schedule_sheet:
            if youtube_channels:
                print("Schedule sheet provided. Skipping YouTube sync.")
        elif youtube_channels and not YT_API_KEY:
            print("Missing YT_API_KEY env var. Skipping YouTube sync.")
        elif youtube_channels:
            print("Scanning uploads per channel:", MAX_UPLOAD_SCAN)
            print("Upload lookback days:", UPLOAD_LOOKBACK_DAYS)
            print("Upcoming horizon days:", UPCOMING_HORIZON_DAYS)
            print("Recent ended hours:", RECENT_ENDED_HOURS)
            print("Max live hours:", MAX_LIVE_HOURS)
            print("Search live max results:", SEARCH_LIVE_MAX_RESULTS)
            if SEARCH_LIVE_MAX_RESULTS == 0:
                print("Search API disabled to reduce quota usage.")

            channel_ids = [c["channel_id"] for c in youtube_channels]
            meta = fetch_channels_meta(channel_ids)

            sheet_by_id = {c["channel_id"]: c for c in youtube_channels}

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

                    is_premiere = looks_like_premiere(item)

                    if is_premiere and status == "ended":
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
                        "type": "premiere" if is_premiere else "",
                        "is_premiere": is_premiere,
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
