"""Tests for author URN handling. No network access."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from linkedin.client import LinkedInError, normalize_author_urn  # noqa: E402

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
