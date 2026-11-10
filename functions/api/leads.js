/**
 * POST /api/leads — store a contact lead, then (optionally) tell the owner.
 * Bind Cloudflare Pages LEADS (KV) or DB (D1). Otherwise 503.
 * Optional: service binding LEAD_NOTIFY -> the internal lead-notify Worker
 * (linus10x/desk-ops systems/lead-notify). It emails the owner's verified
 * inbox after the lead is stored. Storage stays the source of truth: a
 * notification failure never changes the visitor's response.
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
