"""Tests for author URN handling. No network access."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from linkedin.client import LinkedInError, load_dotenv, normalize_author_urn  # noqa: E402

ORG_URN = "urn:li:organization:145207663"


class NormalizeAuthorUrnTests(unittest.TestCase):
    def test_admin_dashboard_url(self):
        self.assertEqual(
            normalize_author_urn("https://www.linkedin.com/company/145207663/admin/dashboard/"),
            ORG_URN,
        )

    def test_plain_company_url(self):
        self.assertEqual(normalize_author_urn("linkedin.com/company/145207663"), ORG_URN)

    def test_bare_numeric_id(self):
        self.assertEqual(normalize_author_urn("145207663"), ORG_URN)

    def test_urn_passes_through(self):
        self.assertEqual(normalize_author_urn(ORG_URN), ORG_URN)

    def test_person_urn_passes_through(self):
        self.assertEqual(normalize_author_urn("urn:li:person:abc123"), "urn:li:person:abc123")

    def test_whitespace_is_trimmed(self):
        self.assertEqual(normalize_author_urn(f"  {ORG_URN}  "), ORG_URN)

    def test_empty_means_post_as_the_token_holder(self):
        self.assertEqual(normalize_author_urn(""), "")

    def test_vanity_url_without_id_is_rejected(self):
        # A vanity slug carries no organization ID, so it cannot be resolved offline.
        with self.assertRaises(LinkedInError):
            normalize_author_urn("https://www.linkedin.com/company/khutsogrc/")

    def test_nonsense_is_rejected(self):
        with self.assertRaises(LinkedInError):
            normalize_author_urn("not-a-page")


if __name__ == "__main__":
    unittest.main()


class LoadDotenvTests(unittest.TestCase):
    """The auth helper and the CLI must read .env identically."""

    def setUp(self):
        self._saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self._saved)))
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.env_file = Path(self._tmp.name) / ".env"

    def test_values_are_loaded(self):
        self.env_file.write_text("LINKEDIN_CLIENT_ID=abc123\n")
        os.environ.pop("LINKEDIN_CLIENT_ID", None)

        load_dotenv(self.env_file)

        self.assertEqual(os.environ["LINKEDIN_CLIENT_ID"], "abc123")

    def test_real_environment_wins_over_file(self):
        # CI sets secrets as real env vars; a stray .env must not override them.
        self.env_file.write_text("LINKEDIN_CLIENT_ID=from-file\n")
        os.environ["LINKEDIN_CLIENT_ID"] = "from-ci"

        load_dotenv(self.env_file)

        self.assertEqual(os.environ["LINKEDIN_CLIENT_ID"], "from-ci")

    def test_comments_and_blanks_are_skipped(self):
        self.env_file.write_text("# a comment\n\nLINKEDIN_CLIENT_ID=ok\n")
        os.environ.pop("LINKEDIN_CLIENT_ID", None)

        load_dotenv(self.env_file)

        self.assertEqual(os.environ["LINKEDIN_CLIENT_ID"], "ok")

    def test_quotes_are_stripped(self):
        self.env_file.write_text('LINKEDIN_AUTHOR_URN="urn:li:organization:145207663"\n')
        os.environ.pop("LINKEDIN_AUTHOR_URN", None)

        load_dotenv(self.env_file)

        self.assertEqual(os.environ["LINKEDIN_AUTHOR_URN"], "urn:li:organization:145207663")

    def test_missing_file_is_not_an_error(self):
        load_dotenv(Path(self._tmp.name) / "does-not-exist")
