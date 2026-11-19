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
  const keys = [...LEADS.m.keys()];
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
console.log("leads: all tests passed");
