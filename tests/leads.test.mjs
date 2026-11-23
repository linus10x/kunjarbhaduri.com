// node tests/leads.test.mjs : stores first, notifies after, never fails the visitor on notify errors.
import assert from "node:assert/strict";
import { onRequestPost, spamReasons } from "../functions/api/leads.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("https://kunjarbhaduri.com/api/leads", { method: "POST", body: fd });
}
const good = { name: "Pat", email: "Pat@Example.com", interest: "interim", notes: "hi" };

function kv() { const m = new Map(); const opts = new Map(); return { m, opts, put: async (k, v, o) => { m.set(k, v); opts.set(k, o); } }; }

// 1. no notify binding: unchanged behaviour
{ const LEADS = kv(); const r = await onRequestPost({ request: form(good), env: { LEADS } });
  assert.equal(r.status, 303); assert.equal(LEADS.m.size, 1); }

// 2. notify binding: called once with the stored record, after storage
{ const LEADS = kv(); const calls = []; const waits = [];
  const LEAD_NOTIFY = { fetch: async (u, init) => { calls.push(JSON.parse(init.body)); assert.equal(LEADS.m.size, 1); return new Response("{}"); } };
  const r = await onRequestPost({ request: form(good), env: { LEADS, LEAD_NOTIFY }, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(r.status, 303); assert.equal(calls.length, 1);
  assert.equal(calls[0].site, "kunjarbhaduri.com"); assert.equal(calls[0].fields.email, "pat@example.com"); }

// 3. notify failure never changes the visitor response
{ const LEADS = kv(); const waits = [];
  const LEAD_NOTIFY = { fetch: async () => { throw new Error("down"); } };
  const r = await onRequestPost({ request: form(good), env: { LEADS, LEAD_NOTIFY }, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits); assert.equal(r.status, 303); }

// 4. storage failure: no notification
{ const calls = []; const LEADS = { put: async () => { throw new Error("kv"); } };
  const r = await onRequestPost({ request: form(good), env: { LEADS, LEAD_NOTIFY: { fetch: async () => calls.push(1) } } });
  assert.equal(r.status, 500); assert.equal(calls.length, 0); }

// 5. invalid input: no storage, no notification
{ const LEADS = kv(); const calls = [];
  const r = await onRequestPost({ request: form({ email: "x", interest: "interim" }), env: { LEADS, LEAD_NOTIFY: { fetch: async () => calls.push(1) } } });
  assert.equal(r.status, 400); assert.equal(LEADS.m.size, 0); assert.equal(calls.length, 0); }

// 6. honeypot filled: stored as spam:, same 303, no notify, no lead: key
{ const LEADS = kv(); const calls = [];
  const r = await onRequestPost({ request: form({ ...good, website: "http://x.example" }), env: { LEADS, LEAD_NOTIFY: { fetch: async () => calls.push(1) } } });
  assert.equal(r.status, 303); assert.equal(calls.length, 0);
  const keys = [...LEADS.m.keys()].filter((k) => !k.startsWith("spamsender:"));
  assert.equal(keys.length, 1); assert.ok(keys[0].startsWith("spam:"));
  const o = LEADS.opts.get(keys[0]); assert.equal(o.metadata.spam, 1); assert.equal(o.expirationTtl, 2592000); }

// 7. submitted under 3 s after page load: spam
{ const LEADS = kv();
  const r = await onRequestPost({ request: form({ ...good, ts: String(Date.now() - 500) }), env: { LEADS } });
  assert.equal(r.status, 303); assert.ok([...LEADS.m.keys()][0].startsWith("spam:")); }

// 8. the 2026-11-18 pattern: CamelCase name + non-Latin-only notes (placeholder details)
{ const LEADS = kv(); const calls = [];
  const bot = { name: "RobertLot", email: "bot@example.com", interest: "expert-call", notes: "Hi, \u10db\u10d8\u10dc\u10d3\u10dd\u10d3\u10d0 \u10d5\u10d8\u10ea\u10dd\u10d3\u10d4 \u10d7\u10e5\u10d5\u10d4\u10dc\u10d8 \u10e4\u10d0\u10e1\u10d8." };
  // "Hi," is Latin, so test the stricter real-world form too
  assert.deepEqual(spamReasons({ ...bot, notes: "\u10db\u10d8\u10dc\u10d3\u10dd\u10d3\u10d0 \u10e4\u10d0\u10e1\u10d8" }), ["non_latin_notes", "camelcase_name"]);
  const r = await onRequestPost({ request: form({ ...bot, notes: "\u10db\u10d8\u10dc\u10d3\u10dd\u10d3\u10d0 \u10e4\u10d0\u10e1\u10d8" }), env: { LEADS, LEAD_NOTIFY: { fetch: async () => calls.push(1) } } });
  assert.equal(r.status, 303); assert.equal(calls.length, 0); assert.ok([...LEADS.m.keys()][0].startsWith("spam:")); }

// 9. real people are not flagged: one soft signal alone, slow submit, no JS timestamp, non-Latin name
{ assert.deepEqual(spamReasons({ name: "McKenzie", notes: "Interim CTO for a PE-backed firm" }), []);
  assert.deepEqual(spamReasons({ name: "Pat", notes: "\u4f60\u597d\uff0c\u60f3\u4e86\u89e3\u4e00\u4e0b" }), []);
  assert.deepEqual(spamReasons({ ...good, ts: String(Date.now() - 60000) }), []);
  assert.deepEqual(spamReasons({ ...good, ts: "" }), []);
  assert.deepEqual(spamReasons({ ...good, ts: "garbage" }), []);
  const LEADS = kv(); const r = await onRequestPost({ request: form({ ...good, ts: String(Date.now() - 60000), website: "" }), env: { LEADS } });
  assert.equal(r.status, 303); assert.ok([...LEADS.m.keys()][0].startsWith("lead:")); }

// 10. D1-only: spam is not inserted
{ let inserted = 0; const DB = { prepare: () => ({ bind: () => ({ run: async () => { inserted++; } }) }) };
  const r = await onRequestPost({ request: form({ ...good, website: "x" }), env: { DB } });
  assert.equal(r.status, 303); assert.equal(inserted, 0); }
// 11. the 2026-11-20 vendor-pitch template: spam alone, no notify; one phrase alone is still a lead
{ const pitch = "Hi team,\r\n\r\nThis note arrived through your contact form. Picture I'm a new customer: how soon until I hear back?\r\n\r\nAn MIT study showed that a lead called within 5 minutes is 100 times more likely to be reached. We make that call for you.";
  assert.deepEqual(spamReasons({ name: "Pat Jones", notes: pitch }), ["vendor_pitch"]);
  const LEADS = kv(); const calls = [];
  const r = await onRequestPost({ request: form({ ...good, interest: "board", notes: pitch }), env: { LEADS, LEAD_NOTIFY: { fetch: async () => calls.push(1) } } });
  assert.equal(r.status, 303); assert.equal(calls.length, 0); assert.ok([...LEADS.m.keys()][0].startsWith("spam:"));
  assert.deepEqual(spamReasons({ name: "Pat", notes: "We want a free trial of a tech health snapshot for one portfolio company" }), []);
  assert.deepEqual(spamReasons({ name: "Pat", notes: "Operating partner, 6 portfolio companies; our AI vendor stack needs a review" }), []); }
// 12. repeat_after_spam: honeypot hit, then a clean resend from the same address (any case) within a day = spam, no notify
{ const m = new Map(); const opts = new Map();
  const LEADS = { m, opts, put: async (k, v, o) => { m.set(k, v); opts.set(k, o); }, get: async (k) => m.get(k) ?? null };
  const calls = []; const LEAD_NOTIFY = { fetch: async () => calls.push(1) };
  await onRequestPost({ request: form({ ...good, website: "http://x.example" }), env: { LEADS, LEAD_NOTIFY } });
  assert.equal(opts.get("spamsender:pat@example.com").expirationTtl, 86400);
  const r = await onRequestPost({ request: form({ ...good, email: "PAT@example.com", notes: "" }), env: { LEADS, LEAD_NOTIFY } });
  assert.equal(r.status, 303); assert.equal(calls.length, 0);
  assert.equal([...m.keys()].filter((k) => k.startsWith("lead:")).length, 0);
  const second = [...m.keys()].filter((k) => k.startsWith("spam:"))[1];
  assert.equal(opts.get(second).metadata.reasons, "repeat_after_spam");
  // a different sender is untouched
  const r2 = await onRequestPost({ request: form({ ...good, email: "someone@else.com" }), env: { LEADS, LEAD_NOTIFY } });
  assert.equal(r2.status, 303); assert.equal([...m.keys()].filter((k) => k.startsWith("lead:")).length, 1); }
// 13. a KV get that throws never blocks a real lead
{ const m = new Map(); const LEADS = { m, put: async (k, v) => { m.set(k, v); }, get: async () => { throw new Error("kv"); } };
  const r = await onRequestPost({ request: form(good), env: { LEADS } });
  assert.equal(r.status, 303); assert.ok([...m.keys()][0].startsWith("lead:")); }
console.log("leads: all tests passed");

// 2026-11-23: the CamelCase campaign switched to an English template.
{ assert.deepEqual(spamReasons({ name: "RobertLot", notes: "Hi, I wanted to know your price." }), ["camelcase_name", "price_template"]);
  assert.deepEqual(spamReasons({ name: "Robert Lot", notes: "Hi, I wanted to know your price." }), []);
  assert.deepEqual(spamReasons({ name: "Dana", notes: "Hi, I wanted to know your price for a 3-company snapshot." }), []);
  console.log("ok price_template soft signal");
}
