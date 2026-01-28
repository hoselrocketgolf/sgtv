const USERNAME_RE = /^[a-zA-Z0-9._]{2,24}$/;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const CHANNEL_TIMEOUT_MS = 4_000;

const rateLimitStore = new Map();

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count += 1;
  rateLimitStore.set(ip, entry);

  return entry.count <= RATE_LIMIT_MAX;
}

function jitter(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function getTtlForStatus(status) {
  if (status === "live") return jitter(10, 20);
  if (status === "offline") return jitter(30, 60);
  return jitter(15, 30);
}

function buildCacheKey(username) {
  return new Request(`https://sgtv-live-cache/${username}`, { method: "GET" });
}

function findRoomId(text) {
  const roomIdMatch = text.match(/"roomId"\s*:\s*"?(\d{4,})"?/i);
  if (roomIdMatch) return roomIdMatch[1];
  const liveRoomMatch = text.match(/"liveRoomId"\s*:\s*"?(\d{4,})"?/i);
  if (liveRoomMatch) return liveRoomMatch[1];
  const altRoomMatch = text.match(/"room_id"\s*:\s*"?(\d{4,})"?/i);
  if (altRoomMatch) return altRoomMatch[1];
  return null;
}

function isBlockedResponse(response, text) {
  if (!response || !text) return true;
  if ([403, 429].includes(response.status)) return true;
  const url = response.url || "";
  if (/captcha|challenge|verify|denied|blocked/i.test(url)) return true;
  return /captcha|verify you are human|access denied|blocked/i.test(text);
}

function detectStatus(text) {
  if (!text) return { status: "unknown", roomId: null };

  const roomId = findRoomId(text);
  const hasLiveFlag = /"isLive"\s*:\s*true/i.test(text) || /"liveStatus"\s*:\s*1/i.test(text);
  const hasLiveRoomId = /"liveRoomId"\s*:\s*"?[1-9]\d*"?/i.test(text);

  if (hasLiveRoomId || (roomId && hasLiveFlag)) {
    return { status: "live", roomId };
  }

  const hasOfflineFlag =
    /"isLive"\s*:\s*false/i.test(text) ||
    /This LIVE has ended|LIVE has ended|isn\'t live|not live right now/i.test(text);

  if (hasOfflineFlag) {
    return { status: "offline", roomId: null };
  }

  return { status: "unknown", roomId: null };
}

async function fetchChannelStatus(username, ctx) {
  const cacheKey = buildCacheKey(username);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    try {
      const cachedPayload = await cached.json();
      return {
        status: cachedPayload.status || "unknown",
        roomId: cachedPayload.roomId || null,
      };
    } catch (err) {
      // ignore cache parse errors and refetch
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), CHANNEL_TIMEOUT_MS);

  let status = "unknown";
  let roomId = null;

  try {
    const response = await fetch(`https://www.tiktok.com/@${username}/live`, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
      redirect: "follow",
    });

    const text = await response.text();

    if (!response.ok || isBlockedResponse(response, text)) {
      status = "unknown";
    } else {
      const detected = detectStatus(text);
      status = detected.status;
      roomId = detected.roomId;
    }
  } catch (err) {
    status = "unknown";
  } finally {
    clearTimeout(timeout);
  }

  const ttl = getTtlForStatus(status);
  const cacheResponse = new Response(JSON.stringify({ status, roomId }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${ttl}`,
    },
  });

  ctx.waitUntil(caches.default.put(cacheKey, cacheResponse.clone()));

  return { status, roomId };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname !== "/live-status") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    const ip = getClientIp(request);
    if (!checkRateLimit(ip)) {
      return jsonResponse(
        { error: "Rate limit exceeded. Please retry in a moment." },
        { status: 429, headers: { "Retry-After": "30" } }
      );
    }

    const rawChannels = url.searchParams.get("channels") || "";
    const channels = rawChannels
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    if (!channels.length) {
      return jsonResponse({ error: "Missing channels query parameter." }, { status: 400 });
    }

    const checkedAt = new Date().toISOString();

    const results = await Promise.all(
      channels.map(async (channel) => {
        if (!USERNAME_RE.test(channel)) {
          return { channel, status: "unknown", roomId: null };
        }

        const result = await fetchChannelStatus(channel, ctx);
        return { channel, ...result };
      })
    );

    const channelPayload = results.reduce((acc, entry) => {
      acc[entry.channel] = {
        status: entry.status,
        roomId: entry.roomId,
      };
      return acc;
    }, {});

    return jsonResponse({ checkedAt, channels: channelPayload }, { headers: { "Cache-Control": "no-store" } });
  },
};
