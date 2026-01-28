# SimGolf TV Guide (Lightweight)

This is a simple, fast TV-guide style site for live simulator golf schedules.

## Powered by Google Sheets
The site reads a **published Google Sheet CSV**.

Your CSV URL is set in `app.js` as `CSV_URL`.

Recommended column headers (case-insensitive):
- start_et (required) — e.g. `2026-01-13 20:00` (Eastern)
- end_et (optional)
- title
- league
- platform
- channel (optional)
- watch_url

The parser also recognizes common alternatives like `start`, `time`, `url`, `link`, etc.
Use platform values like `YouTube`, `TikTok`, `Twitch`, or `Kick`.

## Automating YouTube + TikTok schedules
The automation script reads a published **channel sheet CSV** and writes `schedule.json`.

Expected headers (case-insensitive):
- platform (YouTube, TikTok, Twitch, or Kick)
- handle
- display_name
- channel_id (YouTube only)
- tiktok_url (TikTok only; can be profile URL)
- twitch_url (Twitch only; can be channel URL)
- kick_url (Kick only; can be channel URL)
- subscribers (optional)

For TikTok rows, provide either `handle` or `tiktok_url`. The script will attempt to
detect live status and, when live, emit a `watch_url` pointing at `/live`.

For Twitch/Kick rows, the automation script will emit a rolling “live now” entry using the
provided handle or URL (it does not currently verify live status).


## Run automation in GitHub Actions (recommended for the site)
To keep TikTok LIVE detection server-side (and avoid browser CORS limits), use the
included workflow at `.github/workflows/sync-schedule.yml`.

Set these repo secrets (Settings → Secrets and variables → Actions):
- `CHANNEL_SHEET_CSV` — required published channel sheet CSV URL
- `SCHEDULE_SHEET_CSV` — optional published schedule sheet CSV URL
- `YT_API_KEY` — optional YouTube Data API key

The workflow runs every 15 minutes, fails fast if `CHANNEL_SHEET_CSV` is missing,
and commits any `schedule.json` updates.

## Run locally (optional)
Just open `index.html` in your browser.

Some browsers block `fetch()` from `file://`. If so, use a tiny local server:
- Python: `python -m http.server 8000`
Then visit: http://localhost:8000

## Deploy free (recommended)
### Option A: Cloudflare Pages (free)
1. Create a GitHub repo and upload these files.
2. In Cloudflare Pages, connect the repo and deploy.
3. Add your custom domain (e.g., simgolf.tv).

### Option B: GitHub Pages (free)
1. Create a repo.
2. Upload files to the repo root.
3. Enable Pages in Settings → Pages → Deploy from branch.

## Notes
- Auto-refresh is set to every 5 minutes in `app.js`.
- All times display in America/New_York (Eastern).
