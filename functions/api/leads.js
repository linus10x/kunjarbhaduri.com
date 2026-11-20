/**
 * POST /api/leads — store a contact lead, then (optionally) tell the owner.
 * Bind Cloudflare Pages LEADS (KV) or DB (D1). Otherwise 503.
 * Optional: service binding LEAD_NOTIFY -> the internal lead-notify Worker
 * (linus10x/desk-ops systems/lead-notify). It emails the owner's verified
 * inbox after the lead is stored. Storage stays the source of truth: a
 * notification failure never changes the visitor's response.
 *
 * Spam screen (no external service): a hidden honeypot field, a minimum
 * time on page, and two soft content signals. Suspected spam gets the same
 * 303 as a real lead, so bots learn nothing. It is kept under `spam:<id>`
 * (KV, 30-day TTL, metadata spam=1) and never sent to LEAD_NOTIFY, so
 * `lead:` counts stay clean. With D1 only, spam is dropped, because the
 * leads table has no spam column and adding one is a schema change.
 */

const MAX = {
  name: 120,
  email: 120,
  interest: 80,
  notes: 1000,
  source: 40,
};

const INTERESTS = new Set([
  "pe-tech-health",
  "expert-call",
  "permanent",
  "interim",
  "fractional",
  "board",
  "founder-advisory",
  "autonomy-ladder",
  "unsure",
]);

function bad(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function ok(id) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/?lead=${encodeURIComponent(id)}#h-contact`,
      "cache-control": "no-store",
    },
  });
}

const MIN_FILL_MS = 3000; // a person can't pick an interest and submit faster
const SPAM_TTL_S = 60 * 60 * 24 * 30;
// Phrases sellers paste into contact forms. Lowercase; matched as substrings.
const PITCH_PHRASES = [
  "through your contact form",
  "via your contact form",
  "through your contact page",
  "mit study",
  "times more likely",
  "we call them",
  "we make that call",
  "book a demo",
  "free trial",
  "unsubscribe",
  "reply stop",
  "opt out",
  "opt-out",
  "no longer wish to receive",
  "guest post",
  "backlinks",
  "first page of google",
  "more leads",
];

/**
 * Returns the reasons a submission looks automated ([] = looks human).
 * Hard signals: honeypot filled; submitted under MIN_FILL_MS after page load.
 * Vendor pitch: notes contain 2+ distinct cold-pitch phrases (PITCH_PHRASES),
 * e.g. the 2026-11-20 "lead-calling service" template. One phrase alone is
 * never enough, so a real buyer who mentions "our AI" is still a lead.
 * Soft signals (spam only when both fire): notes contain letters but none
 * are Latin; name is one CamelCase token like "RobertLot".
 * A missing or garbled timestamp (no JavaScript) is never counted against
 * the visitor.
 */
export function spamReasons(data, now = Date.now()) {
  const hard = [];
  if (String(data.website || "").trim() !== "") hard.push("honeypot");
  const ts = Number(data.ts);
  if (Number.isFinite(ts) && ts > 0 && now - ts >= 0 && now - ts < MIN_FILL_MS) {
    hard.push("too_fast");
  }
  const lower = String(data.notes || "").toLowerCase();
  const pitchHits = PITCH_PHRASES.filter((p) => lower.includes(p)).length;
  if (pitchHits >= 2) hard.push("vendor_pitch");
  if (hard.length) return hard;

  const soft = [];
  const notes = String(data.notes || "");
  if (/\p{L}/u.test(notes) && !/\p{Script=Latin}/u.test(notes)) soft.push("non_latin_notes");
  if (/^[A-Z][a-z]+[A-Z][a-z]+$/.test(String(data.name || "").trim())) soft.push("camelcase_name");
  return soft.length >= 2 ? soft : [];
}

function clip(value, n) {
  return String(value || "")
    .trim()
    .slice(0, n);
}

function notifyOwner(context, record) {
  const svc = context.env && context.env.LEAD_NOTIFY;
  if (!svc || typeof svc.fetch !== "function") return false;
  const body = JSON.stringify({
    site: "kunjarbhaduri.com",
    kind: "advisory inquiry",
    id: record.id,
    created_at: record.created_at,
    fields: {
      name: record.name,
      email: record.email,
      interest: record.interest,
      notes: record.notes,
      source: record.source,
    },
  });
  const p = svc
    .fetch("https://lead-notify/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    .catch(() => null);
  if (typeof context.waitUntil === "function") context.waitUntil(p);
  return true;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ctype = request.headers.get("content-type") || "";
  let data;
  try {
    if (ctype.includes("application/json")) {
      data = await request.json();
    } else {
      const form = await request.formData();
      data = Object.fromEntries(form.entries());
    }
  } catch {
    return bad(400, "Could not read the form.");
  }

  const name = clip(data.name, MAX.name);
  const email = clip(data.email, MAX.email).toLowerCase();
  const interest = clip(data.interest, MAX.interest);
  const notes = clip(data.notes, MAX.notes);
  const source = clip(data.source, MAX.source) || "kunjarbhaduri-com";

  if (!email || !interest) {
    return bad(400, "Email and interest are required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return bad(400, "Email looks invalid.");
  }
  if (!INTERESTS.has(interest)) {
    return bad(400, "Unknown interest.");
  }

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const record = { id, created_at, name, email, interest, notes, source };

  const reasons = spamReasons(data);
  if (reasons.length) {
    try {
      if (env.LEADS) {
        await env.LEADS.put(
          `spam:${id}`,
          JSON.stringify({ ...record, spam: 1, reasons }),
          {
            expirationTtl: SPAM_TTL_S,
            metadata: { interest, created_at, spam: 1, reasons: reasons.join(",") },
          }
        );
      }
    } catch {
      // Spam storage is best-effort; the bot still gets the normal response.
    }
    return ok(id);
  }

  try {
    if (env.LEADS) {
      await env.LEADS.put(`lead:${id}`, JSON.stringify(record), {
        metadata: { interest, created_at },
      });
      notifyOwner(context, record);
      return ok(id);
    }
    if (env.DB) {
      await env.DB.prepare(
        `INSERT INTO leads (id, created_at, name, email, interest, notes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, created_at, name, email, interest, notes, source)
        .run();
      notifyOwner(context, record);
      return ok(id);
    }
  } catch {
    return bad(500, "Could not store the lead.");
  }

  return bad(
    503,
    "Lead storage is not configured yet. Use Calendly or LinkedIn."
  );
}

export async function onRequestGet() {
  return bad(405, "POST a lead to this URL.");
}
