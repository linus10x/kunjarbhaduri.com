/**
 * POST /api/collect — first-party, cookieless event collector for all five
 * Kunjar Bhaduri web properties. GET /api/collect?day=YYYY-MM-DD returns one
 * day's events as JSON for the daily digest (read key required).
 *
 * Bind a KV namespace as ANALYTICS in this Pages project (dashboard step;
 * see the analytics build report). Until the binding exists the endpoint
 * still answers 204 so no site ever breaks; events are simply not stored.
 * Optional: set the COLLECT_READ_KEY env var to enable the GET read path.
 *
 * Privacy contract, enforced here:
 * - No cookies are set or read. No fingerprinting. Nothing IP-derived is
 *   stored: the client address is never read, hashed, or logged by us.
 * - Stored fields: site, event, page, referrer, referrer host, utm tags,
 *   door tag, coarse device class, ts. Nothing else is accepted.
 * - Origins are allowlisted to the five properties (apex and www).
 * - Events auto-expire from KV after 90 days.
 */

const SITE_IDS = new Set([
  "readyestates",
  "dfwreplydesk",
  "kunjarbhaduri",
  "ntci",
  "autonomy",
]);

const ALLOWED_ORIGINS = new Set([
  "https://readyestates.us",
  "https://www.readyestates.us",
  "https://dfwreplydesk.com",
  "https://www.dfwreplydesk.com",
  "https://kunjarbhaduri.com",
  "https://www.kunjarbhaduri.com",
  "https://northtexascapitalinvestments.com",
  "https://www.northtexascapitalinvestments.com",
  "https://autonomy-ladder.io",
  "https://www.autonomy-ladder.io",
]);

const EVENT_RX = /^[a-z0-9_]{1,48}$/;
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 4096;
const RETENTION_TTL = 90 * 24 * 60 * 60; // 90 days, in seconds

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const h = { vary: "Origin" };
  if (ALLOWED_ORIGINS.has(origin)) {
    h["access-control-allow-origin"] = origin;
  }
  return h;
}

function originAllowed(request) {
  const origin = request.headers.get("origin") || "";
  if (origin) return ALLOWED_ORIGINS.has(origin);
  // sendBeacon from a page sends Origin in practice; if it is ever absent,
  // fall back to the Referer host rather than accepting blind posts.
  const referer = request.headers.get("referer") || "";
  if (!referer) return false;
  try {
    return ALLOWED_ORIGINS.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

function clip(value, n) {
  return typeof value === "string" ? value.slice(0, n) : "";
}

function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10); // UTC day bucket
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(request);
  if (!originAllowed(request)) {
    return new Response(null, { status: 403, headers: cors });
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return new Response(null, { status: 400, headers: cors });
  }
  if (!raw || raw.length > MAX_BODY) {
    return new Response(null, { status: 400, headers: cors });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400, headers: cors });
  }
  const site = clip(data && data.site, 32);
  const event = clip(data && data.event, 48);
  if (!SITE_IDS.has(site) || !EVENT_RX.test(event)) {
    return new Response(null, { status: 400, headers: cors });
  }
  let page = clip(data && data.page, 200) || "/";
  if (!page.startsWith("/")) page = "/" + page;
  let referrer = clip(data && data.referrer, 300);
  if (referrer) {
    try {
      new URL(referrer);
    } catch {
      referrer = "";
    }
  }
  const now = Date.now();
  let ts = Number(data && data.ts);
  if (!Number.isFinite(ts) || ts < now - 7 * 24 * 3600 * 1000 || ts > now + 3600 * 1000) {
    ts = now;
  }
  const TAG_RX = /^[a-z0-9_\-\.]{0,64}$/i;
  const tag = (v) => {
    const t = clip(v, 64).toLowerCase();
    return TAG_RX.test(t) ? t : "";
  };
  let ref = "";
  if (referrer) {
    try {
      ref = new URL(referrer).hostname.slice(0, 120);
    } catch {
      ref = "";
    }
  }
  const deviceRaw = clip(data && data.device, 16).toLowerCase();
  const device = ["mobile", "tablet", "desktop"].includes(deviceRaw)
    ? deviceRaw
    : "";
  const record = {
    site,
    event,
    page,
    referrer,
    ref,
    utm_source: tag(data && data.utm_source),
    utm_medium: tag(data && data.utm_medium),
    utm_campaign: tag(data && data.utm_campaign),
    door: tag(data && data.door),
    device,
    ts,
  };
  if (env.ANALYTICS) {
    const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const key = `e:${site}:${dayOf(ts)}:${ts}:${rand}`;
    try {
      await env.ANALYTICS.put(key, JSON.stringify(record), {
        expirationTtl: RETENTION_TTL,
      });
    } catch {
      // Storage failure must never surface to the visitor's page.
    }
  }
  return new Response(null, { status: 204, headers: cors });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const readKey = env.COLLECT_READ_KEY || "";
  if (!readKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "read endpoint not configured" }),
      { status: 501, headers: { "content-type": "application/json" } }
    );
  }
  if ((request.headers.get("x-read-key") || "") !== readKey) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (!env.ANALYTICS) {
    return new Response(
      JSON.stringify({ ok: false, error: "ANALYTICS binding missing" }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }
  const url = new URL(request.url);
  const day = url.searchParams.get("day") || dayOf(Date.now() - 24 * 3600 * 1000);
  if (!DAY_RX.test(day)) {
    return new Response(JSON.stringify({ ok: false, error: "bad day" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const onlySite = clip(url.searchParams.get("site") || "", 32);
  const sites = onlySite && SITE_IDS.has(onlySite) ? [onlySite] : [...SITE_IDS];
  const events = [];
  for (const site of sites) {
    let cursor;
    do {
      const list = await env.ANALYTICS.list({
        prefix: `e:${site}:${day}:`,
        cursor,
        limit: 1000,
      });
      for (const k of list.keys) {
        if (events.length >= 10000) break;
        const v = await env.ANALYTICS.get(k.name);
        if (!v) continue;
        try {
          events.push(JSON.parse(v));
        } catch {
          // skip a corrupt record rather than failing the whole read
        }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor && events.length < 10000);
  }
  events.sort((a, b) => a.ts - b.ts);
  return new Response(JSON.stringify({ ok: true, day, count: events.length, events }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestOptions(context) {
  const { request } = context;
  const headers = corsHeaders(request);
  headers["access-control-allow-methods"] = "POST, GET, OPTIONS";
  headers["access-control-allow-headers"] = "content-type, x-read-key";
  headers["access-control-max-age"] = "86400";
  return new Response(null, { status: 204, headers });
}
