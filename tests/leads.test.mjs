// node tests/leads.test.mjs : stores first, notifies after, never fails the visitor on notify errors.
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/leads.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("https://kunjarbhaduri.com/api/leads", { method: "POST", body: fd });
}
const good = { name: "Pat", email: "Pat@Example.com", interest: "interim", notes: "hi" };

function kv() { const m = new Map(); return { m, put: async (k, v) => { m.set(k, v); } }; }

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
console.log("leads: all tests passed");
