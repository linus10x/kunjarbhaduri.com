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
 * - Minimized server-side, whatever the client sends (desk-ops research
 *   2026-11-08, kunjarbhaduri.com#26): page is decoded, then keeps the path
 *   only, with /property/<id> and id-like segments as "_"; referrer keeps a
 *   known host or else the registrable domain only; utm and door values come
 *   from a finite list (anything else is "other"). The GET read path applies
 *   the same rules to older records.
 * - Every POST still answers 204 so no page can break, but the
 *   x-collect-status header says stored, unbound or failed. A 204 alone is
 *   not proof that an event was recorded. GET ?health=1 (read key) does a
 *   real KV write-and-read round trip for monitoring.
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

// Path segments that look like identifiers (long tokens with digits, UUIDs,
// long hex) are replaced so private record IDs never reach analytics.
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeId(seg) {
  if (UUID_RX.test(seg)) return true;
  // A readable slug ("dfw-foreclosure-sale-december-2026") is split into
  // short words; an identifier has one long run that mixes in digits.
  return seg.split(/[-_.]/).some((part) => part.length >= 12 && /\d/.test(part));
}
const PRIVATE_PREFIXES = ["property", "properties", "lead", "leads", "deal", "deals", "offer-review", "admin"];

export function minimizePage(value) {
  let page = typeof value === "string" ? value : "";
  // Drop query and fragment no matter what the client sent.
  page = page.split("#")[0].split("?")[0];
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(page)) {
    try {
      page = new URL(page).pathname;
    } catch {
      page = "/";
    }
  }
  // Decode first so an encoded slash ("%2f") or "@" cannot hide a private
  // segment from the checks below. Undecodable input collapses to "/".
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(page); i++) {
    try {
      page = decodeURIComponent(page);
    } catch {
      return "/";
    }
  }
  page = page.split("#")[0].split("?")[0];
  if (!page.startsWith("/")) page = "/" + page;
  const segs = page.split("/");
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    if (/[@\s%]/.test(seg) || looksLikeId(seg)) {
      segs[i] = "_";
    } else if (i > 1 && PRIVATE_PREFIXES.includes(segs[i - 1].toLowerCase())) {
      segs[i] = "_";
    }
  }
  return segs.join("/").slice(0, 200) || "/";
}

// Referrer hosts kept as-is (search engines, social, AI answers, our own
// sites). Any other host is cut to its registrable domain, so a personal
// subdomain ("jane-doe.example.com") never reaches storage.
const KNOWN_REF_HOSTS = new Set([
  "www.google.com", "google.com", "www.bing.com", "bing.com", "duckduckgo.com",
  "search.yahoo.com", "chatgpt.com", "www.perplexity.ai", "perplexity.ai",
  "copilot.microsoft.com", "gemini.google.com", "www.linkedin.com", "lnkd.in",
  "www.facebook.com", "m.facebook.com", "l.facebook.com", "lm.facebook.com",
  "www.instagram.com", "l.instagram.com", "www.pinterest.com", "nextdoor.com",
  "www.youtube.com", "m.youtube.com", "t.co", "x.com", "www.reddit.com",
  "old.reddit.com", "github.com", "news.ycombinator.com",
  ...[...ALLOWED_ORIGINS].map((o) => new URL(o).hostname),
]);
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

export function reduceHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h || !/^[a-z0-9.-]+$/.test(h)) return "";
  if (KNOWN_REF_HOSTS.has(h)) return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const keep = parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export function minimizeReferrer(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const u = new URL(value.slice(0, 2000));
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    const host = reduceHost(u.hostname);
    return host ? `https://${host}` : "";
  } catch {
    return "";
  }
}

// Finite attribution vocabulary. Anything else becomes "other" (or "" when
// absent), so free text such as a name or phone number cannot be stored.
// Door sources and campaign parts mirror readyestates src/door-allowlist.json.
const SOURCES = new Set([
  "readyestatesdfw", "sellasisdfw", "sellmydfwhouse", "dfwprobatebuyer",
  "dfwhomeowneroptions", "fpa-door", "fpa", "keptclose-door",
  "google", "bing", "linkedin", "facebook", "instagram", "pinterest", "nextdoor",
  "youtube", "x", "reddit", "github", "pypi", "newsletter", "chatgpt", "perplexity",
  "gbp", "email", "referral",
]);
const MEDIUMS = new Set(["door", "email", "social", "referral", "organic", "profile", "video", "newsletter", "community"]);
const CAMPAIGN_CHANNELS = new Set(["guide", "email", "gbp", "referral", "bigdog", "social", "card"]);
const CAMPAIGN_COUNTIES = new Set(["dallas", "tarrant", "collin", "denton", "rockwall", "kaufman", "ellis", "johnson", "parker", "dfw"]);

export function vocab(value, kind) {
  const v = typeof value === "string" ? value.trim().toLowerCase().slice(0, 64) : "";
  if (!v) return "";
  if (kind === "source") return SOURCES.has(v) ? v : "other";
  if (kind === "medium") return MEDIUMS.has(v) ? v : "other";
  if (kind === "campaign") {
    const [a, b, ...rest] = v.split("-");
    return !rest.length && CAMPAIGN_CHANNELS.has(a) && CAMPAIGN_COUNTIES.has(b) ? v : "other";
  }
  return "";
}

export function minimizeRecord(r) {
  const referrer = minimizeReferrer(r && r.referrer);
  return {
    site: r && r.site,
    event: r && r.event,
    page: minimizePage(r && r.page),
    referrer,
    ref: referrer ? referrer.slice(8) : "",
    utm_source: vocab(r && r.utm_source, "source"),
    utm_medium: vocab(r && r.utm_medium, "medium"),
    utm_campaign: vocab(r && r.utm_campaign, "campaign"),
    door: vocab(r && r.door, "source"),
    device: ["mobile", "tablet", "desktop"].includes(r && r.device) ? r.device : "",
    ts: r && r.ts,
  };
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
  const page = minimizePage(data && data.page);
  const referrer = minimizeReferrer(data && data.referrer);
  const now = Date.now();
  let ts = Number(data && data.ts);
  if (!Number.isFinite(ts) || ts < now - 7 * 24 * 3600 * 1000 || ts > now + 3600 * 1000) {
    ts = now;
  }
  const record = minimizeRecord({
    site,
    event,
    page,
    referrer,
    utm_source: data && data.utm_source,
    utm_medium: data && data.utm_medium,
    utm_campaign: data && data.utm_campaign,
    door: data && data.door,
    device: clip(data && data.device, 16).toLowerCase(),
  });
  record.ts = ts;
  let status = "unbound";
  if (env.ANALYTICS) {
    const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const key = `e:${site}:${dayOf(ts)}:${ts}:${rand}`;
    try {
      await env.ANALYTICS.put(key, JSON.stringify(record), {
        expirationTtl: RETENTION_TTL,
      });
      status = "stored";
    } catch {
      // Storage failure must never surface to the visitor's page, but it
      // must be visible to monitoring (header below, plus GET ?health=1).
      status = "failed";
    }
  }
  return new Response(null, {
    status: 204,
    headers: { ...cors, "x-collect-status": status, "access-control-expose-headers": "x-collect-status" },
  });
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
  if (url.searchParams.get("health") === "1") {
    return healthCheck(env);
  }
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
          // Re-minimize on read so records stored before 2026-11-09 come
          // out under the same rules as new ones.
          const rec = minimizeRecord(JSON.parse(v));
          if (typeof rec.ts !== "number") continue;
          events.push(rec);
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

async function healthCheck(env) {
  const key = `health:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  const nonce = crypto.randomUUID();
  const out = { ok: false, binding: true, write: false, read: false };
  try {
    await env.ANALYTICS.put(key, nonce, { expirationTtl: 60 });
    out.write = true;
    out.read = (await env.ANALYTICS.get(key)) === nonce;
  } catch (e) {
    out.error = "kv_error";
  }
  out.ok = out.write && out.read;
  return new Response(JSON.stringify(out), {
    status: out.ok ? 200 : 503,
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
