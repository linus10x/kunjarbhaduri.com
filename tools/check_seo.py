#!/usr/bin/env python3
"""SEO and AI-crawl checks for kunjarbhaduri.com. Exits non-zero on failure."""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]
errors = []


def fail(msg):
    errors.append(msg)


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self._in_title = False
        self.meta = {}
        self.canonical = None
        self.ld = []
        self._in_ld = False
        self._buf = ""
        self.text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = a.get("name") or a.get("property")
            if key:
                self.meta[key] = a.get("content", "")
        elif tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")
        elif tag == "script" and a.get("type") == "application/ld+json":
            self._in_ld = True
            self._buf = ""
        elif tag == "img" and not a.get("alt"):
            fail("img missing alt")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script" and self._in_ld:
            self.ld.append(self._buf)
            self._in_ld = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif self._in_ld:
            self._buf += data
        else:
            self.text.append(data)


def main():
    raw = (ROOT / "index.html").read_text()
    p = Page()
    p.feed(raw)
    if not p.title.strip():
        fail("missing title")
    desc = p.meta.get("description", "")
    if not 50 <= len(desc) <= 170:
        fail(f"meta description length {len(desc)}")
    if p.canonical != "https://kunjarbhaduri.com/":
        fail(f"canonical {p.canonical!r}")
    for key in ("og:title", "og:description", "og:url", "twitter:card", "twitter:title", "twitter:description"):
        if not p.meta.get(key):
            fail(f"missing {key}")
    visible = re.sub(r"\s+", " ", " ".join(p.text))
    types = set()
    for blob in p.ld:
        try:
            data = json.loads(blob)
        except json.JSONDecodeError as e:
            fail(f"JSON-LD {e}")
            continue
        types.add(data.get("@type"))
        if data.get("@type") == "FAQPage":
            for q in data.get("mainEntity", []):
                name = q.get("name", "")
                ans = q.get("acceptedAnswer", {}).get("text", "")
                if name not in visible or ans not in visible:
                    fail(f"FAQ not visible: {name!r}")
    for need in ("Person", "WebSite", "FAQPage"):
        if need not in types:
            fail(f"missing {need} schema")
    robots = (ROOT / "robots.txt").read_text()
    for bot in BOTS:
        if f"User-agent: {bot}\nAllow: /\n" not in robots:
            fail(f"robots.txt does not allow {bot}")
    if "https://kunjarbhaduri.com/" not in (ROOT / "sitemap.xml").read_text():
        fail("sitemap missing home")
    llms = (ROOT / "llms.txt").read_text()
    full = (ROOT / "llms-full.txt").read_text()
    if "llms-full.txt" not in llms:
        fail("llms.txt does not link llms-full.txt")
    for blob in (llms, full, robots):
        if re.search(r"inwood|75244", blob, re.I):
            fail("crawl file contains the street address")
    if "$40" in full or "140" in full or "+40%" in full:
        fail("llms-full.txt restates a track-record figure")
    if errors:
        print("\n".join(errors))
        return 1
    print("all checks passed: 1 page")
    return 0


if __name__ == "__main__":
    sys.exit(main())
