import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost, onRequestGet, onRequestOptions } from "../functions/api/collect.js";
import { PUBLIC_ROUTES } from "../lib/analytics-policy.js";

const origin = "https://readyestates.us";
const now = Date.now();
const input = { site: "readyestates", event: "page_view", page: "/", ts: now };
function memory() {
  const rows = new Map();
  const calls = [];
  return { rows, calls,
    async put(key, value, options) { rows.set(key, value); calls.push({ key, options }); },
    async get(key) { return rows.get(key); },
    async list({ prefix }) { return { keys: [...rows.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
}
async function post(data = input, storage = memory(), headers = { origin }) {
  const request = new Request("https://kunjarbhaduri.com/api/collect", {
    method: "POST", headers, body: typeof data === "string" ? data : JSON.stringify(data),
  });
  const response = await onRequestPost({ request, env: storage ? { ANALYTICS: storage } : {} });
  return { response, storage, record: storage?.rows?.size ? JSON.parse([...storage.rows.values()].at(-1)) : null };
}
function get(storage, key = "test-only", config = "test-only") {
  return onRequestGet({
    request: new Request("https://kunjarbhaduri.com/api/collect?day=" + new Date(now).toISOString().slice(0, 10), { headers: key ? { "x-read-key": key } : {} }),
    env: { ANALYTICS: storage, COLLECT_READ_KEY: config },
  });
}

test("stores useful public counts with 90-day expiry", async () => {
  const { response, record, storage } = await post({ ...input, page: "/get-a-cash-offer/?email=CANARY#CANARY", utm_source: "sellmydfwhouse", utm_medium: "door", utm_campaign: "email-tarrant", door: "sellmydfwhouse", device: "mobile" });
  assert.equal(response.status, 204);
  assert.equal(record.page, "/get-a-cash-offer");
  assert.equal(record.utm_source, "sellmydfwhouse");
  assert.equal(record.utm_campaign, "email-tarrant");
  assert.equal(record.device, "mobile");
  assert.equal(storage.calls[0].options.expirationTtl, 90 * 24 * 60 * 60);
  assert.ok(!JSON.stringify(record).includes("CANARY"));
});

test("all 127 known public paths retain their useful route", async () => {
  let count = 0;
  for (const [site, paths] of Object.entries(PUBLIC_ROUTES)) for (const page of paths) {
    const { record } = await post({ ...input, site, page: page === "/" ? "/" : page + "/?CANARY#CANARY" });
    assert.equal(record.page, page);
    count++;
  }
  assert.equal(count, 127);
});

test("private, encoded and arbitrary paths cannot retain identifiers", async () => {
  for (const page of ["/property/CANARY/?email=CANARY#CANARY", "/PROPERTY/CANARY", "/property%2fCANARY", "/property%252fCANARY", "/unknown-CANARY", "https://example.invalid/CANARY", "//example.invalid/CANARY", "/%ZZ/CANARY"]) {
    const { record } = await post({ ...input, page });
    assert.ok(["/property/", "/other/"].includes(record.page));
    assert.ok(!JSON.stringify(record).includes("CANARY"));
  }
});

test("referrers collapse to fixed source labels; userinfo, paths and queries disappear", async () => {
  const { record } = await post({ ...input, referrer: "https://CANARY:secret@www.linkedin.com/in/CANARY?email=CANARY#CANARY", ref: "CANARY" });
  assert.equal(record.referrer, "https://linkedin.com");
  assert.equal(record.ref, "linkedin.com");
  for (const referrer of ["https://CANARY.example.invalid/CANARY", "https://linkedin.com.evil.invalid/CANARY", "javascript:CANARY", "not a url"]) {
    const result = await post({ ...input, referrer });
    assert.ok(!JSON.stringify(result.record).includes("CANARY"));
    assert.equal(result.record.referrer, "");
  }
});

test("tags use finite values rather than a permissive character regex", async () => {
  const { record } = await post({ ...input, utm_source: "CANARY_person", utm_medium: "CANARY_phone", utm_campaign: "CANARY_address", door: "CANARY_owner", device: "CANARY_device", email: "CANARY@example.invalid", notes: "CANARY" });
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "door", "device"]) assert.equal(record[key], "");
  assert.ok(!JSON.stringify(record).includes("CANARY"));
});

test("only finite event names and sites are accepted", async () => {
  for (const data of [{ ...input, event: "canary_person" }, { ...input, event: "page_view" + "x".repeat(50) }, { ...input, site: "canary" }, null, [], true]) {
    const { response, storage } = await post(data);
    assert.equal(response.status, 400);
    assert.equal(storage.rows.size, 0);
  }
  for (const event of ["cta_home_readyestates", "buy_portrait_canvas", "cta_book_wwm_pe", "lead_start", "scroll_75"]) assert.equal((await post({ ...input, event })).response.status, 204);
});

test("missing or failing persistence returns 503, never success", async () => {
  assert.equal((await post(input, null)).response.status, 503);
  assert.equal((await post(input, { async put() { throw new Error("synthetic failure"); } })).response.status, 503);
});

test("invalid JSON, oversize and untrusted origins do not reach storage", async () => {
  for (const data of ["{bad", "x".repeat(4097)]) assert.equal((await post(data)).response.status, 400);
  assert.equal((await post(input, memory(), { origin: "https://untrusted.invalid" })).response.status, 403);
  assert.equal((await post(input, memory(), {})).response.status, 403);
  assert.equal((await post(input, memory(), { referer: origin + "/" })).response.status, 204);
});

test("CORS permits only configured properties", async () => {
  for (const source of [origin, "https://untrusted.invalid"]) {
    const response = await onRequestOptions({ request: new Request("https://kunjarbhaduri.com/api/collect", { headers: { origin: source } }) });
    assert.equal(response.headers.get("access-control-allow-origin"), source === origin ? origin : null);
  }
});

test("protected readback returns minimized records and preserves historical timestamp", async () => {
  const storage = memory();
  await post(input, storage);
  const key = [...storage.rows.keys()][0];
  storage.rows.set(key, JSON.stringify({ ...input, page: "/property/CANARY?email=CANARY", referrer: "https://www.google.com/search?q=CANARY", extra: "CANARY", utm_campaign: "CANARY_person" }));
  assert.equal((await get(storage, "wrong")).status, 401);
  assert.equal((await get(storage, null, "")).status, 501);
  assert.equal((await get(undefined)).status, 503);
  const response = await get(storage);
  const body = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.count, 1);
  assert.equal(body.events[0].page, "/property/");
  assert.equal(body.events[0].ts, now);
  assert.ok(!JSON.stringify(body).includes("CANARY"));
  // Read minimization does not pretend to delete legacy KV data.
  assert.ok(storage.rows.get(key).includes("CANARY"));
});
