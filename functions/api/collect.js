/**
 * POST /api/collect — first-party, cookieless event collector for all five
 * Kunjar Bhaduri web properties. GET /api/collect?day=YYYY-MM-DD returns one
 * day's events as JSON for the daily digest (read key required).
 *
 * Bind a KV namespace as ANALYTICS in this Pages project (dashboard step;
 * see the analytics build report). Unbound or failed storage returns 503;
 * clients already ignore measurement errors, so the page remains usable.
 * Optional: set the COLLECT_READ_KEY env var to enable the GET read path.
 *
 * Privacy contract, enforced here:
 * - No cookies are set or read. No fingerprinting. Nothing IP-derived is
 *   stored: the client address is never read, hashed, or logged by us.
 * - Page, event and attribution values use finite public vocabularies.
 *   Referrers are fixed source categories, never arbitrary URLs/hosts.
 * - Origins are allowlisted to the five properties (apex and www).
 * - Events auto-expire from KV after 90 days.
 */

import { PUBLIC_ROUTES, EVENTS, SOURCES, MEDIUMS, CAMPAIGNS } from "../../lib/analytics-policy.js";

const EVENT_NAMES = new Set(EVENTS);
const SOURCE_NAMES = new Set(SOURCES);
const MEDIUM_NAMES = new Set(MEDIUMS);
const CAMPAIGN_NAMES = new Set(CAMPAIGNS);
const PUBLIC_PATHS = Object.fromEntries(
  Object.entries(PUBLIC_ROUTES).map(([site, routes]) => [site, new Set(routes)])
);

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

function publicPage(site, value) {
  if (typeof value !== "string" || value.length > MAX_BODY) return "/other/";
  try {
    // A foreign absolute URL is not a public route on this site.
    const url = new URL(value, "https://analytics.invalid");
    if (url.origin !== "https://analytics.invalid") return "/other/";
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
    if (/^\/property(?:\/|$)/i.test(path)) return "/property/";
    return PUBLIC_PATHS[site]?.has(path) ? path : "/other/";
  } catch {
    return "/other/";
  }
}

function approvedTag(value, allowed) {
  if (typeof value !== "string") return "";
  const token = value.toLowerCase();
  return allowed.has(token) ? token : "";
}

function referrerCategory(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase();
    // Return only these fixed labels; even a personal subdomain is dropped.
    for (const domain of [
      "gemini.google.com", "google.com", "bing.com", "duckduckgo.com", "yahoo.com",
      "linkedin.com", "facebook.com", "instagram.com", "pinterest.com",
      "youtube.com", "github.com", "pypi.org", "chatgpt.com",
      "perplexity.ai", "claude.ai", "copilot.microsoft.com",
      "readyestates.us", "dfwreplydesk.com", "kunjarbhaduri.com",
      "northtexascapitalinvestments.com", "autonomy-ladder.io",
    ]) {
      if (host === domain || host.endsWith("." + domain)) return domain;
    }
    return "other";
  } catch {
    return "";
  }
}

function safeRecord(data, now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const site = data.site;
  const event = data.event;
  if (!SITE_IDS.has(site) || !EVENT_NAMES.has(event)) return null;
  let ts = Number(data.ts);
  if (!Number.isFinite(ts) || ts < now - 7 * 24 * 3600 * 1000 || ts > now + 3600 * 1000) ts = now;
  const ref = referrerCategory(data.referrer);
  return {
    site,
    event,
    page: publicPage(site, data.page || "/"),
    referrer: ref && ref !== "other" ? "https://" + ref : "",
    ref,
    utm_source: approvedTag(data.utm_source, SOURCE_NAMES),
    utm_medium: approvedTag(data.utm_medium, MEDIUM_NAMES),
    utm_campaign: approvedTag(data.utm_campaign, CAMPAIGN_NAMES),
    door: approvedTag(data.door, SOURCE_NAMES),
    device: ["mobile", "tablet", "desktop"].includes(data.device) ? data.device : "",
    ts,
  };
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
  const record = safeRecord(data);
  if (!record) {
    return new Response(null, { status: 400, headers: cors });
  }
  if (env.ANALYTICS) {
    const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const key = `e:${record.site}:${dayOf(record.ts)}:${record.ts}:${rand}`;
    try {
      await env.ANALYTICS.put(key, JSON.stringify(record), {
        expirationTtl: RETENTION_TTL,
      });
    } catch {
      return new Response(null, { status: 503, headers: cors });
    }
  } else {
    return new Response(null, { status: 503, headers: cors });
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
          const stored = JSON.parse(v);
          // Minimize legacy read output too. This does not rewrite old KV rows.
          const storedTime = Number(stored && stored.ts);
          const record = safeRecord(stored, Number.isFinite(storedTime) ? storedTime : Date.now());
          if (record) events.push(record);
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

