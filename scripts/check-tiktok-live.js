const fs = require("fs");
const { chromium } = require("playwright");

const fetch = globalThis.fetch;
if (typeof fetch !== "function") {
  throw new Error("Global fetch is not available. Use Node 18+ or enable fetch.");
}

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vR5DMZYPLgP64WZYcE1H0PMOQyjD2Rf67NUM1kRkC3dCPVwZJ0kNcj6dUbugO-LOaSNSx798fPA27tK/pub?gid=0&single=true&output=csv";

const SCHEDULE_PATH = "schedule.json";

/**
 * Robust CSV parser (handles quoted commas)
 */
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines.shift().split(",").map(h => h.trim());

  return lines.map(line => {
    const values =
      line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g)
        ?.map(v => v.replace(/^"|"$/g, "")) || [];

    const row = {};
    headers.forEach((h, i) => (row[h] = values[i] || ""));
    return row;
  });
}

(async () => {
  console.log("Fetching channel sheet…");
  const csv = await fetch(SHEET_CSV_URL).then(r => r.text());
  const rows = parseCSV(csv);

  const tiktokRows = rows.filter(
    r => r.platform === "TikTok" && (r.handle || r.tiktok_url)
  );

  if (!tiktokRows.length) {
    console.log("No TikTok rows found.");
    return;
  }

  console.log(`Checking ${tiktokRows.length} TikTok channels…`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const liveEvents = [];
  const nowET = new Date()
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");

  for (const row of tiktokRows) {
    const handle =
      row.handle?.replace("@", "").trim() ||
      row.tiktok_url.match(/@([^/?#]+)/)?.[1];

    if (!handle) continue;

    const liveUrl = `https://www.tiktok.com/@${handle}/live`;

    try {
      console.log(`Checking @${handle}`);
      await page.goto(liveUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Allow TikTok client JS to hydrate
      await page.waitForTimeout(3000);

      const html = await page.content();

      const isLive =
        html.includes('"isLive":true') ||
        html.includes("room_id") ||
        html.includes("LIVE now");

      if (isLive) {
        console.log(`LIVE: @${handle}`);

        liveEvents.push({
          platform: "TikTok",
          channel: handle,
          title: `${row.display_name || handle} is LIVE`,
          watch_url: liveUrl,
          status: "live",
          start_et: nowET,
        });
      }
    } catch (err) {
      console.warn(`Failed to check @${handle}`);
    }
  }

  await browser.close();

  const existing = fs.existsSync(SCHEDULE_PATH)
    ? JSON.parse(fs.readFileSync(SCHEDULE_PATH, "utf8"))
    : [];

  // Remove old TikTok entries, keep everything else
  const nonTikTok = existing.filter(e => e.platform !== "TikTok");

  const updatedSchedule = [...nonTikTok, ...liveEvents];

  fs.writeFileSync(
    SCHEDULE_PATH,
    JSON.stringify(updatedSchedule, null, 2)
  );

  console.log(
    `Done. ${liveEvents.length} TikTok LIVE channel(s) added.`
  );
})();
