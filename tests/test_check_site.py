import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import check_site  # noqa: E402


class CheckSiteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.site = self.tmp / "site"
        shutil.copytree(ROOT, self.site, ignore=shutil.ignore_patterns(".git"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def errors(self, release=False):
        return check_site.check(self.site, release)[0]

    def edit(self, rel, old, new):
        p = self.site / rel
        body = p.read_text(encoding="utf-8")
        self.assertIn(old, body, f"fixture text not found in {rel}")
        p.write_text(body.replace(old, new, 1), encoding="utf-8")

    def assertFailsWith(self, fragment, release=False):
        errs = self.errors(release)
        self.assertTrue(any(fragment in e for e in errs), f"expected a failure containing {fragment!r}, got {errs}")

    def test_repo_passes_structure_checks(self):
        self.assertEqual(self.errors(), [])

    def test_missing_canonical_fails(self):
        self.edit("about/index.html", '<link rel="canonical" href="https://kunjarbhaduri.com/about/">', "")
        self.assertFailsWith("exactly one canonical")

    def test_wrong_canonical_fails(self):
        self.edit("about/index.html", 'rel="canonical" href="https://kunjarbhaduri.com/about/"',
                  'rel="canonical" href="https://kunjarbhaduri.com/"')
        self.assertFailsWith("canonical https://kunjarbhaduri.com/ should be")

    def test_disallow_all_fails(self):
        self.edit("robots.txt", "User-agent: *\nAllow: /", "User-agent: *\nDisallow: /")
        self.assertFailsWith("blocks every crawler")

    def test_page_missing_from_sitemap_fails(self):
        self.edit("sitemap.xml", "<url><loc>https://kunjarbhaduri.com/essays/</loc><lastmod>2026-10-15</lastmod></url>", "")
        self.assertFailsWith("missing indexable page https://kunjarbhaduri.com/essays/")

    def test_broken_jsonld_fails(self):
        self.edit("essays/index.html", '"name": "Essays",', '"name": "Essays",,')
        self.assertFailsWith("JSON-LD does not parse")

    def test_wrong_person_id_fails(self):
        self.edit("about/index.html", '"@id": "https://kunjarbhaduri.com/#person",\n      "name"',
                  '"@id": "https://kunjarbhaduri.com/about/#me",\n      "name"')
        self.assertFailsWith("Person node must use @id")

    def test_faq_answer_drift_fails(self):
        self.edit("advisory/agent-readiness-diagnostic/index.html",
                  "<p>Yes. Bring the vendor's materials", "<p>Sure. Bring the vendor's materials")
        self.assertFailsWith("FAQ answer not visible")

    def test_postal_address_fails(self):
        page = self.site / "advisory/index.html"
        original = page.read_text(encoding="utf-8")
        for text, label in [("PO Box 1234", "PO box"), ("123 Main Street", "street address"),
                            ("Suite 400", "suite or mailbox number"), ("Dallas, TX 75201", "Texas ZIP code")]:
            with self.subTest(text=text):
                page.write_text(original, encoding="utf-8")
                self.edit("advisory/index.html", "Dallas, Texas ·", f"{text} ·")
                self.assertFailsWith(label)

    def test_gmail_fails(self):
        self.edit("llms.txt", "## Profiles", "## Profiles\n\nsomeone" + "@" + "gmail.com")
        self.assertFailsWith("personal Gmail")

    def test_em_dash_fails(self):
        self.edit("index.html", "Field notes</h2>", "Field notes \u2014 soon</h2>")
        self.assertFailsWith("en or em dash")

    def test_placeholder_warns_in_structure_mode_and_fails_in_release(self):
        self.edit("about/index.html", "Dallas, Texas", "[KUNJAR DECISION: test placeholder] Dallas, Texas")
        self.assertTrue(any("[KUNJAR" in w for w in check_site.check(self.site, False)[1]))
        self.assertFailsWith("unfilled placeholder", release=True)

    def test_release_passes_once_placeholders_are_filled(self):
        for p in self.site.rglob("*"):
            if p.is_file() and p.suffix in {".html", ".txt", ".xml"} and "_templates" not in p.parts:
                body = p.read_text(encoding="utf-8")
                body = check_site.PLACEHOLDER.sub("filled", body)
                p.write_text(body, encoding="utf-8")
        self.assertEqual(self.errors(release=True), [])


if __name__ == "__main__":
    unittest.main()
