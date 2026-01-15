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

USER_AGENT = "Mozilla/5.0 (compatible; sgtv-bot/2.2)"
REQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    # Strongly discourage caches (helps w/ Google/Cloudflare intermediates)
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

# Treat "upcoming" scheduled in the past as junk if it never started.
# (Example: scheduled 6 months ago, never went live.)
GHOST_UPCOMING_GRACE_MINUTES = 30

# Only keep upcoming within this horizon (prevents pulling far-future junk)
UPCOMING_HORIZON_DAYS = 7

# How many recent uploads to scan per channel
UPLOADS_SCAN_MAX = 25


# --------- HTTP helpers ---------
def add_cache_buster(url: str) -> str:
    """
    Adds a cache-busting query param to help ensure we always read the latest sheet.
    This is especially important for the published Google Sheet CSV.
    """
    try:
        u = urllib.parse.urlparse(url)
        q = dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
        q["cb"] = str(int(time.time()))
        new_query = urllib.parse.urlencode(q)
        return urllib.parse.urlunparse((u.scheme, u.netloc, u.path, u.params, new_query, u.fragment))
    except Exception:
        # If parsing fails, fallback to simple append
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}cb={int(time.time())}"

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
    # Cache-bust the sheet fetch so removals reflect quickly.
    sheet_url = add_cache_buster(CHANNEL_SHEET_CSV)
    csv_text = http_get(sheet_url)
    rows = parse_simple_csv(csv_text)
    if not rows:
        return []

    print("Sheet headers:", list(rows[0].keys()))
    print("Sheet URL (cache-busted):", sheet_url)

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

    # Helpful debug so you can confirm removals are truly reflected
    print("Channel IDs from sheet:", [c["channel_id"] for c in channels])

    return channels


# --------- Time helpers ---------
def iso_to_et_fmt(iso: str) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET_TZ)
    return dt.strftime("%Y-%m-%d %H:%M")

def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def parse_iso_utc(iso: str) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


# --------- YouTube API strategy ---------
# 1) channels.list (batch): get uploads playlist + subscriber count + channel title
# 2) playlistItems.list per channel: pull latest N uploads
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

def fetch_uploads_video_ids(uploads_playlist_id: str, max_results: int = UPLOADS_SCAN_MAX) -> list[str]:
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

def classify_video(item: dict) -> tuple[str | None, str | None, dict]:
    """
    Returns (status, start_iso, live_details)
      status: "live" | "upcoming" | None
      start_iso: ISO timestamp string or None
      live_details: liveStreamingDetails dict
    """
    lsd = (item.get("liveStreamingDetails") or {})
    snippet = (item.get("snippet") or {})
    live_content = (snippet.get("liveBroadcastContent") or "").lower()

    actual_start = lsd.get("actualStartTime")
    actual_end = lsd.get("actualEndTime")
    scheduled_start = lsd.get("scheduledStartTime")

    # Live if started and not ended
    if actual_start and not actual_end:
        return "live", actual_start, lsd

    # Upcoming if scheduled but not started
    if scheduled_start and not actual_start:
        return "upcoming", scheduled_start, lsd

    # Fallbacks
    if live_content == "live" and actual_start and not actual_end:
        return "live", actual_start, lsd
    if live_content == "upcoming" and scheduled_start:
        return "upcoming", scheduled_start, lsd

    return None, None, lsd


def is_ghost_upcoming(start_iso: str, lsd: dict) -> bool:
    """
    If it's "upcoming" but its scheduled time is already in the past,
    and it never actually started, treat it as ghost/junk.
    """
    start_dt = parse_iso_utc(start_iso)
    if not start_dt:
        return False

    # If it has actualStartTime, it's not ghost.
    if lsd.get("actualStartTime"):
        return False

    cutoff = now_utc() - timedelta(minutes=GHOST_UPCOMING_GRACE_MINUTES)
    return start_dt < cutoff


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

    # Build candidate vids from uploads for all channels
    all_candidate_vids = []
    per_channel_candidate = {}

    for cid in channel_ids:
        m = meta.get(cid)
        if not m:
            print("WARN: channel meta missing (bad channel_id?):", cid)
            continue

        uploads = m["uploads_playlist_id"]
        vids = fetch_uploads_video_ids(uploads, max_results=UPLOADS_SCAN_MAX)
        per_channel_candidate[cid] = vids
        all_candidate_vids.extend(vids)

        # small throttle
        time.sleep(0.05)

    # Fetch details in batches
    video_details = fetch_videos_details(sorted(set(all_candidate_vids)))

    upcoming_horizon = now_utc() + timedelta(days=UPCOMING_HORIZON_DAYS)

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

            status, start_iso, lsd = classify_video(item)
            if not status or not start_iso:
                continue

            # Ghost upcoming cleanup (scheduled in the past, never started)
            if status == "upcoming" and is_ghost_upcoming(start_iso, lsd):
                # Debug line so you can see it's working
                try:
                    et = iso_to_et_fmt(start_iso)
                except Exception:
                    et = start_iso
                title = ((item.get("snippet") or {}).get("title") or "").strip()
                print(f"SKIP ghost-upcoming: {et} • {title} • https://www.youtube.com/watch?v={vid}")
                continue

            # Upcoming horizon filter
            if status == "upcoming":
                start_dt = parse_iso_utc(start_iso)
                if start_dt and start_dt > upcoming_horizon:
                    continue

            # Avoid duplicates
            if vid in seen_video_ids:
                continue
            seen_video_ids.add(vid)

            snippet = item.get("snippet") or {}
            title = (snippet.get("title") or "").strip()
            thumb = pick_thumb(snippet) or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"

            if status == "live":
                found_live_for_channel = True

            events.append({
                "start_et": iso_to_et_fmt(start_iso),
                "end_et": "",
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
