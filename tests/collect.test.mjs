// Run: node tests/collect.test.mjs   (Node 22+, no dependencies)
import assert from "node:assert/strict";
import { onRequestPost, onRequestGet, minimizePage, minimizeReferrer, vocab, minimizeRecord } from "../functions/api/collect.js";

function kv({ failPut = false } = {}) {
  const m = new Map();
  return {
    m,
    async put(k, v) { if (failPut) throw new Error("kv down"); m.set(k, v); },
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
const post = (body, origin = "https://readyestates.us") =>
  new Request("https://kunjarbhaduri.com/api/collect", { method: "POST", headers: { origin }, body: JSON.stringify(body) });
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok", name); };

await t("page drops query and fragment", () => {
  assert.equal(minimizePage("/get-a-cash-offer/?email=a@b.invalid#x"), "/get-a-cash-offer/");
});
await t("property id redacted", () => {
  assert.equal(minimizePage("/property/SYNTHETIC-ONLY/"), "/property/_/");
  assert.equal(minimizePage("/p/a1b2c3d4e5f6a7b8c9/"), "/p/_/");
  assert.equal(minimizePage("/x/someone%40mail.invalid"), "/x/_");
});
await t("public paths unchanged", () => {
  assert.equal(minimizePage("/situations/probate/"), "/situations/probate/");
  assert.equal(minimizePage("/dfw-foreclosure-sale-december-2026/"), "/dfw-foreclosure-sale-december-2026/");
});
await t("full URL page reduced to path", () => {
  assert.equal(minimizePage("https://readyestates.us/property/abc/?q=1"), "/property/_/");
});
await t("referrer origin only", () => {
  assert.equal(minimizeReferrer("https://www.google.com/search?q=sell+my+house+123+main+st"), "https://www.google.com");
  assert.equal(minimizeReferrer("javascript:alert(1)"), "");
  assert.equal(minimizeReferrer("not a url"), "");
});
await t("stored record has no canary", async () => {
  const env = { ANALYTICS: kv() };
  const res = await onRequestPost({ request: post({ site: "readyestates", event: "page_view", page: "/property/CANARY-123456789/?addr=CANARY", referrer: "https://ref.invalid/path?CANARY=1" }), env });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-collect-status"), "stored");
  const stored = [...env.ANALYTICS.m.values()].join("");
  assert.ok(!stored.includes("CANARY"), stored);
  const rec = JSON.parse([...env.ANALYTICS.m.values()][0]);
  assert.equal(rec.page, "/property/_/");
  assert.equal(rec.referrer, "https://ref.invalid");
  assert.equal(rec.ref, "ref.invalid");
});
await t("unbound is visible", async () => {
  const res = await onRequestPost({ request: post({ site: "ntci", event: "page_view", page: "/" }), env: {} });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-collect-status"), "unbound");
});
await t("kv failure is visible", async () => {
  const res = await onRequestPost({ request: post({ site: "ntci", event: "page_view", page: "/" }), env: { ANALYTICS: kv({ failPut: true }) } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-collect-status"), "failed");
});
await t("foreign origin rejected", async () => {
  const res = await onRequestPost({ request: post({ site: "ntci", event: "page_view", page: "/" }, "https://evil.invalid"), env: { ANALYTICS: kv() } });
  assert.equal(res.status, 403);
});
await t("health round trip", async () => {
  const req = (h) => new Request("https://kunjarbhaduri.com/api/collect?health=1", { headers: h });
  assert.equal((await onRequestGet({ request: req({ "x-read-key": "k" }), env: { COLLECT_READ_KEY: "k", ANALYTICS: kv() } })).status, 200);
  assert.equal((await onRequestGet({ request: req({ "x-read-key": "k" }), env: { COLLECT_READ_KEY: "k", ANALYTICS: kv({ failPut: true }) } })).status, 503);
  assert.equal((await onRequestGet({ request: req({}), env: { COLLECT_READ_KEY: "k", ANALYTICS: kv() } })).status, 401);
});
await t("encoded slash cannot hide a property id", () => {
  assert.equal(minimizePage("/property%2fCANARY"), "/property/_");
  assert.equal(minimizePage("/property%252fCANARY/"), "/property/_/");
  assert.equal(minimizePage("/x/%E0%A4%A"), "/");
});
await t("personal subdomain cut to registrable domain", () => {
  assert.equal(minimizeReferrer("https://jane-doe.example.invalid/x"), "https://example.invalid");
  assert.equal(minimizeReferrer("https://canary.mail.example.co.uk/"), "https://example.co.uk");
  assert.equal(minimizeReferrer("https://www.linkedin.com/feed/?x=1"), "https://www.linkedin.com");
  assert.equal(minimizeReferrer("https://sellmydfwhouse.com/"), "https://sellmydfwhouse.com");
});
await t("utm and door values are a finite vocabulary", () => {
  assert.equal(vocab("canary_person", "source"), "other");
  assert.equal(vocab("4695550100", "campaign"), "other");
  assert.equal(vocab("email-denton", "campaign"), "email-denton");
  assert.equal(vocab("email-denton-extra", "campaign"), "other");
  assert.equal(vocab("FPA", "source"), "fpa");
  assert.equal(vocab("door", "medium"), "door");
  assert.equal(vocab("", "source"), "");
});
await t("ntci 913fadf-shaped canary payload stores no canary", async () => {
  const env = { ANALYTICS: kv() };
  const body = { site: "ntci", event: "page_view", page: "/products", referrer: "https://canary-person.example.invalid/p?phone=CANARY",
    ref: "canary-person.example.invalid", utm_source: "canary_person", utm_medium: "canary_medium", utm_campaign: "canary_phone", door: "canary_person", device: "mobile", ts: Date.now() };
  await onRequestPost({ request: post(body, "https://northtexascapitalinvestments.com"), env });
  const stored = [...env.ANALYTICS.m.values()].join("");
  assert.ok(!/canary/i.test(stored), stored);
});
await t("GET re-minimizes legacy records", async () => {
  const env = { COLLECT_READ_KEY: "k", ANALYTICS: kv() };
  const day = new Date().toISOString().slice(0, 10);
  env.ANALYTICS.m.set(`e:ntci:${day}:1:a`, JSON.stringify({ site: "ntci", event: "page_view", page: "/property/CANARY/?q=CANARY", referrer: "https://canary.example.invalid/x", utm_source: "canary_person", ts: Date.now() }));
  const res = await onRequestGet({ request: new Request(`https://kunjarbhaduri.com/api/collect?day=${day}&site=ntci`, { headers: { "x-read-key": "k" } }), env });
  const txt = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!/canary/i.test(txt), txt);
});
console.log(`${n} tests passed`);
