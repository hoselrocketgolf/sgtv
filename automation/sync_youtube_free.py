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
        "https://www.tiktok.com/api-live/user/room/?aid=1988&unique_id=",
        "https://www.tiktok.com/api/live/user/room/?aid=1988&unique_id=",
    ]
    last_error: Exception | None = None
    for base in endpoints:
        url = f"{base}{urllib.parse.quote(handle)}"
        try:
            payload = http_get_json(url)
        except Exception as exc:
            last_error = exc
            continue
        if isinstance(payload, dict) and payload:
            return payload
    if last_error:
        print(f"TikTok API lookup failed for @{handle}: {last_error}")
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
    cover = extract_tiktok_cover(payload)

    if live_state is False:
        return False, "", ""
    if room_id and live_state is not False:
        return True, room_id, cover

    live_url = ensure_tiktok_live_url(handle, tiktok_url)
    profile_url = normalize_tiktok_profile_url(tiktok_url)

    urls_to_try: list[str] = []
    for candidate in [live_url, profile_url, tiktok_url]:
        if candidate and candidate not in urls_to_try:
            urls_to_try.append(candidate)

    last_error: Exception | None = None
    for url in urls_to_try:
        try:
            warm_tiktok_cookies()
            html = http_get(url)
        except Exception as exc:
            last_error = exc
            continue
        status = extract_tiktok_status_from_html(html)
        if status[0] or status[1]:
            return status

    if last_error and handle:
        print(f"TikTok HTML lookup failed for @{handle}: {last_error}")

    if room_id:
        # Some responses omit explicit live flags but still include a room id.
        return True, room_id, cover

    return False, "", ""

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

    return vids

def fetch_search_live_for_channel(channel_id: str, max_results: int = 5) -> list[str]:
    if max_results <= 0:
        return []
    try:
        resp = yt_api("search", {
            "part": "id",
            "channelId": channel_id,
            "eventType": "live",
            "type": "video",
            "maxResults": max_results,
            "order": "date"
        })
    except urllib.error.HTTPError as e:
        print(f"Search API error for {channel_id}: {e}")
        return []
    items = resp.get("items", [])
    ids = []
    for it in items:
        vid = (((it.get("id") or {}).get("videoId")) or "").strip()
        if vid:
            ids.append(vid)
    return ids

def fetch_videos_details(video_ids: list[str]) -> dict:
    details = {}
    for batch in chunked(video_ids, 50):
        resp = yt_api("videos", {
            "part": "snippet,liveStreamingDetails,contentDetails,status",
            "id": ",".join(batch),
            "maxResults": 50
        })
        for item in resp.get("items", []):
            vid = item.get("id", "")
            if vid:
                details[vid] = item
    return details

def classify_video(item: dict, now: datetime):
    """
    Returns tuple(status, start_iso, end_iso, is_live_broadcast, is_premiere, title, thumb_url)
    status in {"live","upcoming","ended","none"}
    """
    snippet = item.get("snippet") or {}
    live = item.get("liveStreamingDetails") or {}
    status_obj = item.get("status") or {}

    title = (snippet.get("title") or "").strip()
    thumbs = snippet.get("thumbnails") or {}
    thumb_url = ""
    for key in ["maxres", "standard", "high", "medium", "default"]:
        t = thumbs.get(key) or {}
        url = (t.get("url") or "").strip()
        if url:
            thumb_url = url
            break

    live_broadcast_content = (snippet.get("liveBroadcastContent") or "").lower()
    is_live_broadcast = live_broadcast_content == "live"
    is_upcoming_broadcast = live_broadcast_content == "upcoming"

    actual_start = live.get("actualStartTime") or ""
    actual_end = live.get("actualEndTime") or ""
    sched_start = live.get("scheduledStartTime") or ""
    sched_end = live.get("scheduledEndTime") or ""

    # Premiere detection
    is_premiere = False
    if (status_obj.get("uploadStatus") or "").lower() == "uploaded":
        if (status_obj.get("privacyStatus") or "").lower() in {"public", "unlisted"}:
            if (item.get("contentDetails") or {}).get("duration"):
                # Use presence of premiere flag in snippet if available
                is_premiere = bool(snippet.get("premiere") or snippet.get("isPremiere"))

    # Determine status
    if actual_start and not actual_end:
        return "live", actual_start, "", True, is_premiere, title, thumb_url
    if sched_start:
        sched_dt = parse_iso(sched_start)
        if sched_dt and sched_dt > now:
            return "upcoming", sched_start, sched_end, False, is_premiere, title, thumb_url

    if actual_end:
        return "ended", actual_start or sched_start, actual_end, False, is_premiere, title, thumb_url

    # Fallback to broadcast hints
    if is_live_broadcast:
        return "live", actual_start or sched_start, actual_end, True, is_premiere, title, thumb_url
    if is_upcoming_broadcast:
        return "upcoming", sched_start, sched_end, False, is_premiere, title, thumb_url

    return "none", sched_start or actual_start, actual_end, False, is_premiere, title, thumb_url

def within_upcoming_horizon(iso: str, now: datetime, horizon_days: int) -> bool:
    dt = parse_iso(iso)
    if not dt:
        return False
    return dt <= (now + timedelta(days=horizon_days))

def within_recent_window(iso: str, now: datetime, hours: int) -> bool:
    dt = parse_iso(iso)
    if not dt:
        return False
    return dt >= (now - timedelta(hours=hours))

def is_stale_live(start_iso: str, now: datetime, max_hours: int) -> bool:
    dt = parse_iso(start_iso)
    if not dt:
        return False
    return dt < (now - timedelta(hours=max_hours))

def is_stale_upcoming(sched_iso: str, now: datetime) -> bool:
    dt = parse_iso(sched_iso)
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
            detected_live = 0
            for channel in tiktok_channels:
                handle = normalize_tiktok_handle(channel.get("handle", ""), channel.get("tiktok_url", ""))
                display_name = (channel.get("display_name") or "").strip()
                subs = int(channel.get("sheet_subscribers") or 0)
                live_url = ensure_tiktok_live_url(handle, channel.get("tiktok_url", ""))

                if not live_url:
                    print("TikTok row missing handle/url, skipping:", display_name or handle or "unknown")
                    continue

                is_live, room_id, cover = fetch_tiktok_live_status(handle, live_url)
                label = display_name or (f"@{handle}" if handle else live_url)
                print(f"TikTok check: {label} -> {'LIVE' if is_live else 'offline'}")
                if not is_live:
                    continue

                detected_live += 1
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
            print("TikTok live detected:", detected_live)

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
                    continue
                uploads_id = m["uploads_playlist_id"]

                vids = fetch_uploads_video_ids(
                    uploads_id,
                    max_results=MAX_UPLOAD_SCAN,
                    lookback_days=UPLOAD_LOOKBACK_DAYS
                )

                if SEARCH_LIVE_MAX_RESULTS > 0:
                    live_search_vids = fetch_search_live_for_channel(cid, SEARCH_LIVE_MAX_RESULTS)
                    # Prepend live search vids so they get priority
                    vids = list(dict.fromkeys(live_search_vids + vids))

                per_channel_candidate[cid] = vids
                all_candidate_vids.extend(vids)

            # Deduplicate while preserving order
            deduped_vids = []
            for vid in all_candidate_vids:
                if vid in seen_video_ids:
                    continue
                seen_video_ids.add(vid)
                deduped_vids.append(vid)

            details = fetch_videos_details(deduped_vids)

            # Classify per channel and build events
            for cid in channel_ids:
                vids = per_channel_candidate.get(cid, [])
                if not vids:
                    continue

                m = meta.get(cid) or {}
                sheet_row = sheet_by_id.get(cid) or {}

                channel_title = (sheet_row.get("display_name") or "").strip() or m.get("channel_title") or ""
                subs = int(m.get("subscribers") or 0)

                # Best candidate selection
                best_live = None
                best_upcoming = None
                recent_ended = []

                for vid in vids:
                    item = details.get(vid)
                    if not item:
                        continue

                    status, start_iso, end_iso, is_live_broadcast, is_premiere, title, thumb_url = classify_video(item, now)

                    # Skip premieres for live detection
                    if is_premiere:
                        continue

                    if status == "live":
                        if start_iso and is_stale_live(start_iso, now, MAX_LIVE_HOURS):
                            continue
                        best_live = (vid, start_iso, end_iso, title, thumb_url)
                        # live beats all, break early
                        break

                    if status == "upcoming" and start_iso:
                        if not within_upcoming_horizon(start_iso, now, UPCOMING_HORIZON_DAYS):
                            continue
                        if is_stale_upcoming(start_iso, now):
                            continue
                        if not best_upcoming:
                            best_upcoming = (vid, start_iso, end_iso, title, thumb_url)

                    if status == "ended" and end_iso:
                        if within_recent_window(end_iso, now, RECENT_ENDED_HOURS):
                            recent_ended.append((vid, start_iso, end_iso, title, thumb_url))

                # Emit live if found
                if best_live:
                    vid, start_iso, end_iso, title, thumb_url = best_live
                    events.append({
                        "start_et": iso_to_et_fmt(start_iso or now.isoformat()),
                        "end_et": "",
                        "title": title,
                        "league": "",
                        "platform": "YouTube",
                        "channel": channel_title,
                        "watch_url": f"https://www.youtube.com/watch?v={vid}",
                        "source_id": vid,
                        "type": "",
                        "is_premiere": False,
                        "status": "live",
                        # Use _live thumbnail hint when live
                        "thumbnail_url": (thumb_url.replace(".jpg", "_live.jpg") if thumb_url else ""),
                        "subscribers": subs
                    })
                    continue

                # Otherwise upcoming
                if best_upcoming:
                    vid, start_iso, end_iso, title, thumb_url = best_upcoming
                    events.append({
                        "start_et": iso_to_et_fmt(start_iso),
                        "end_et": iso_to_et_fmt(end_iso) if end_iso else "",
                        "title": title,
                        "league": "",
                        "platform": "YouTube",
                        "channel": channel_title,
                        "watch_url": f"https://www.youtube.com/watch?v={vid}",
                        "source_id": vid,
                        "type": "",
                        "is_premiere": False,
                        "status": "upcoming",
                        "thumbnail_url": thumb_url,
                        "subscribers": subs
                    })

                # Emit recent ended streams (dedupe by vid)
                for vid, start_iso, end_iso, title, thumb_url in recent_ended:
                    events.append({
                        "start_et": iso_to_et_fmt(start_iso or end_iso),
                        "end_et": iso_to_et_fmt(end_iso) if end_iso else "",
                        "title": title,
                        "league": "",
                        "platform": "YouTube",
                        "channel": channel_title,
                        "watch_url": f"https://www.youtube.com/watch?v={vid}",
                        "source_id": vid,
                        "type": "",
                        "is_premiere": False,
                        "status": "ended",
                        "thumbnail_url": thumb_url,
                        "subscribers": subs
                    })

        # Finalize
        # Deduplicate by (platform, source_id) preferring live > upcoming > ended
        priority = {"live": 3, "upcoming": 2, "ended": 1}
        merged = {}
        for e in events:
            key = (e.get("platform"), e.get("source_id") or e.get("watch_url"))
            prev = merged.get(key)
            if not prev:
                merged[key] = e
                continue
            prev_p = priority.get((prev.get("status") or "").lower(), 0)
            new_p = priority.get((e.get("status") or "").lower(), 0)
            if new_p >= prev_p:
                merged[key] = e

        final_events = list(merged.values())

        # Sort by live first, then start time desc for ended, asc for upcoming
        def sort_key(e):
            st = (e.get("status") or "").lower()
            start = e.get("start_et") or ""
            if st == "live":
                return (0, start)
            if st == "upcoming":
                return (1, start)
            return (2, start)

        final_events.sort(key=sort_key)

        write_schedule(final_events, OUT_PATH)
        print(f"Wrote {len(final_events)} events to {OUT_PATH}")

    except urllib.error.HTTPError as e:
        print("HTTPError:", e.read().decode("utf-8", errors="ignore"))
        raise
    except Exception as e:
        print("Error:", e)
        raise

if __name__ == "__main__":
    main()
