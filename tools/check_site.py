#!/usr/bin/env python3
"""Site checks for kunjarbhaduri.com. Standard library only.

    python3 tools/check_site.py            structure and content rules
    python3 tools/check_site.py --release  also fails on any unfilled placeholder

Exit 0 when every check passes, 1 otherwise.
"""
import argparse
import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://kunjarbhaduri.com"
PERSON_ID = BASE + "/#person"
SKIP_DIRS = {".git", ".github", "_templates", "tools", "tests", "node_modules", "assets"}
TEXT_SUFFIXES = {".html", ".txt", ".xml"}

POSTAL_PATTERNS = [
    (re.compile(r"\bP\.?\s?O\.?\s+Box\b", re.I), "PO box"),
    (re.compile(r"\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Parkway|Pkwy|Court|Ct|Way|Trail|Trl|Circle|Cir)\b\.?"), "street address"),
    (re.compile(r"\b(?:Suite|Ste\.?|Unit|PMB)\s*#?\s*\d+", re.I), "suite or mailbox number"),
    (re.compile(r"\bTX\s+7[5-9]\d{3}\b"), "Texas ZIP code"),
    (re.compile(r"PostalAddress|streetAddress|postalCode", re.I), "postal address schema"),
]
BANNED = [
    (re.compile(r"[\u2013\u2014]"), "en or em dash"),
    (re.compile(r"[\u2190-\u21ff\u27f5-\u27ff]"), "arrow character"),
    (re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]"), "emoji"),
    (re.compile(r"gmail\.com", re.I), "personal Gmail address"),
    (re.compile(r"\bLincoln\b", re.I), "private engagement name"),
]
PLACEHOLDER = re.compile(r"\[KUNJAR[^\]]*\]|\{\{[^}]*\}\}")


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta = {}
        self.canonicals = []
        self.jsonld = []
        self.text = []
        self._in = None
        self._buf = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "link" and (a.get("rel") or "").lower() == "canonical":
            self.canonicals.append(a.get("href", ""))
        elif tag == "meta":
            key = a.get("name") or a.get("property") or a.get("http-equiv")
            if key:
                self.meta[key.lower()] = a.get("content", "")
        elif tag == "title":
            self._in, self._buf = "title", []
        elif tag == "script" and (a.get("type") or "").lower() == "application/ld+json":
            self._in, self._buf = "jsonld", []
        elif tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag == "title" and self._in == "title":
            self.title = "".join(self._buf).strip()
            self._in = None
        elif tag == "script" and self._in == "jsonld":
            self.jsonld.append("".join(self._buf))
            self._in = None
        elif tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if self._in:
            self._buf.append(data)
        elif not self._skip:
            self.text.append(data)

    def visible_text(self):
        return re.sub(r"\s+", " ", html.unescape(" ".join(self.text))).strip()


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def page_files(root):
    for p in sorted(root.rglob("index.html")):
        rel = p.relative_to(root)
        if rel.parts[0] in SKIP_DIRS:
            continue
        yield p


def shipped_text_files(root):
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if p.is_file() and p.suffix in TEXT_SUFFIXES and rel.parts[0] not in SKIP_DIRS:
            yield p


def expected_url(root, path):
    rel = path.parent.relative_to(root).as_posix()
    return BASE + "/" if rel == "." else f"{BASE}/{rel}/"


def walk_nodes(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from walk_nodes(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_nodes(v)


def types_of(node):
    t = node.get("@type", [])
    return t if isinstance(t, list) else [t]


def check(root, release):
    errors, warnings = [], []
    indexable = set()

    for path in page_files(root):
        rel = path.relative_to(root).as_posix()
        p = Page()
        p.feed(path.read_text(encoding="utf-8"))
        url = expected_url(root, path)
        noindex = "noindex" in p.meta.get("robots", "").lower()

        if len(p.canonicals) != 1:
            errors.append(f"{rel}: needs exactly one canonical link, found {len(p.canonicals)}")
        if not p.title:
            errors.append(f"{rel}: missing <title>")
        if not p.meta.get("description"):
            errors.append(f"{rel}: missing meta description")

        if noindex:
            continue
        indexable.add(url)
        if p.canonicals and p.canonicals[0] != url:
            errors.append(f"{rel}: canonical {p.canonicals[0]} should be {url}")
        if p.meta.get("og:url") != url:
            errors.append(f"{rel}: og:url should be {url}")
        for key in ("og:title", "og:description", "og:type", "twitter:card"):
            if not p.meta.get(key):
                errors.append(f"{rel}: missing {key}")
        if not p.jsonld:
            errors.append(f"{rel}: no JSON-LD block")

        text = p.visible_text()
        for block in p.jsonld:
            try:
                data = json.loads(block)
            except json.JSONDecodeError as e:
                errors.append(f"{rel}: JSON-LD does not parse ({e})")
                continue
            for node in walk_nodes(data):
                kinds = types_of(node)
                if "Person" in kinds and node.get("@id") != PERSON_ID:
                    errors.append(f"{rel}: Person node must use @id {PERSON_ID}")
                if "Question" in kinds:
                    answer = node.get("acceptedAnswer", {}).get("text", "")
                    if norm(node.get("name", "")) not in text:
                        errors.append(f"{rel}: FAQ question not visible on page: {node.get('name')!r}")
                    if norm(answer) not in text:
                        errors.append(f"{rel}: FAQ answer not visible on page: {answer[:60]!r}")

    sitemap = root / "sitemap.xml"
    listed = set()
    if not sitemap.exists():
        errors.append("sitemap.xml missing")
    else:
        try:
            ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
            listed = {e.text.strip() for e in ET.parse(sitemap).getroot().findall("s:url/s:loc", ns)}
        except ET.ParseError as e:
            errors.append(f"sitemap.xml does not parse ({e})")
        for url in sorted(indexable - listed):
            errors.append(f"sitemap.xml: missing indexable page {url}")
        for url in sorted(listed - indexable):
            errors.append(f"sitemap.xml: lists {url}, which is not an indexable page here")

    robots = root / "robots.txt"
    if not robots.exists():
        errors.append("robots.txt missing")
    else:
        agent, star_disallow_all, has_sitemap = None, False, False
        for line in robots.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            key, _, value = (s.strip() for s in line.partition(":"))
            key = key.lower()
            if key == "user-agent":
                agent = value
            elif key == "disallow" and agent == "*" and value == "/":
                star_disallow_all = True
            elif key == "sitemap" and value == BASE + "/sitemap.xml":
                has_sitemap = True
        if star_disallow_all:
            errors.append("robots.txt: 'User-agent: *' has 'Disallow: /', which blocks every crawler")
        if not has_sitemap:
            errors.append(f"robots.txt: needs 'Sitemap: {BASE}/sitemap.xml'")

    llms = root / "llms.txt"
    if not llms.exists() or not llms.read_text(encoding="utf-8").startswith("# "):
        errors.append("llms.txt missing or does not start with an H1")

    for path in shipped_text_files(root):
        rel = path.relative_to(root).as_posix()
        body = path.read_text(encoding="utf-8")
        for rx, label in POSTAL_PATTERNS + BANNED:
            m = rx.search(body)
            if m:
                errors.append(f"{rel}: {label}: {m.group(0)!r}")
        for m in PLACEHOLDER.finditer(body):
            (errors if release else warnings).append(f"{rel}: unfilled placeholder {m.group(0)}")

    return errors, warnings


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=Path(__file__).resolve().parent.parent, type=Path)
    ap.add_argument("--release", action="store_true", help="fail on unfilled placeholders")
    args = ap.parse_args(argv)
    errors, warnings = check(args.root, args.release)
    for w in warnings:
        print("WARN ", w)
    for e in errors:
        print("FAIL ", e)
    pages = sum(1 for _ in page_files(args.root))
    print(f"{pages} pages checked, {len(errors)} failures, {len(warnings)} warnings"
          + (" (release mode)" if args.release else ""))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
