/**
 * POST /api/leads — store a contact lead. No email is sent.
 * Bind Cloudflare Pages LEADS (KV) or DB (D1). Otherwise 503.
 */

const MAX = {
  name: 120,
  email: 120,
  interest: 80,
  notes: 1000,
  source: 40,
};

const INTERESTS = new Set([
  "permanent",
  "interim",
  "fractional",
  "board",
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
      return ok(id);
    }
    if (env.DB) {
      await env.DB.prepare(
        `INSERT INTO leads (id, created_at, name, email, interest, notes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, created_at, name, email, interest, notes, source)
        .run();
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
