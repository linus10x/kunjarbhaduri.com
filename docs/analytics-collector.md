# Collector minimization and verification

The collector accepts counts from the five configured properties. It stores only finite site/event/route/source values, a fixed referrer category, coarse device class and timestamp. It sets no cookies and stores no IP or persistent visitor identifier. KV records expire after 90 days.

`lib/analytics-policy.js` is a reviewed vocabulary, not a dynamic URL registry. It lists the 127 public sitemap routes captured on November 8, 2026, currently observed event names and existing door/campaign tokens. Trailing slashes are normalized. Unknown paths become `/other/`; `/property/*` becomes `/property/`. Queries, fragments, arbitrary referrer hosts, unknown event names and free-text campaign tags are never stored. New public routes, campaign tokens or events require a policy update. Unknown events receive 400; unknown attribution fields become empty, so unregistered campaigns will be unattributed rather than retained as free text.

The schema remains compatible with the existing digest: `referrer` contains only a fixed canonical origin or an empty string; `ref` contains the corresponding fixed category, `other`, or empty. Country-specific search domains not in the vocabulary count as other. Counts are events, not people or verified commercial outcomes. A client-side `lead_submit` is still an attempted submission, not evidence of a stored lead or notification.

POST returns 204 only after a successful KV write. Missing binding or a failed write returns 503; the existing clients ignore measurement failures without blocking the visitor. `sendBeacon()` returning true means queued for transport, not stored. An operator must inspect the HTTP result and protected readback.

GET still requires `COLLECT_READ_KEY`. Returned legacy rows are minimized as well, but existing KV rows are not rewritten or deleted. Any historical-data inspection or cleanup is a separate authorized operation. KV readback may be eventually consistent; a missing immediate read is not proof of a failed write.

Run locally with a recent Node runtime:

```
node --test test/collect.test.mjs
python3 tools/check_seo.py
```

Tests use synthetic data and an in-memory KV; they do not submit to production. They cover all known public routes, private/encoded paths, arbitrary attribution and referrers, storage failure, origin rejection and protected readback.

Before production acceptance, finish client-side minimization in each site's adapted script too: this patch prevents storage of arbitrary values, but older clients can still transmit full referrers and raw attribution to the endpoint. Review the exact head, deploy only through the repository's approval process, then use an authorized synthetic event and protected readback to verify the binding, retention and sanitized record. Verify actual lead delivery and response in the separate lead workflow; this collector sends no notifications.

Rollback is a revert of this scoped commit. Pause new instrumentation if minimization cannot be maintained. Reverting is not a privacy fix and does not delete previously stored data.
