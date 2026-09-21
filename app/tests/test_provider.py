"""The provider boundary, and the file-size limit it has to respect."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.provider import WHATSAPP_LIMIT_BYTES, StubProvider, share_encode  # noqa: E402


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = StubProvider()
        self.twin = self.provider.build_twin("photo", b"face")

    def test_cost_per_video_is_unknown_until_a_vendor_is_chosen(self):
        """Pricing rests on this number. The stub must not invent one."""
        self.assertIsNone(self.provider.cents_per_video)

    def test_short_video_sends_on_whatsapp_unchanged(self):
        render = self.provider.render(self.twin, "hi", 45, "cloned")
        self.assertTrue(render.fits_whatsapp)
        self.assertIs(share_encode(render), render)

    def test_full_length_video_needs_a_second_encode(self):
        """Two minutes at the sharing bitrate exceeds WhatsApp's limit."""
        render = self.provider.render(self.twin, "hi", 120, "cloned")
        self.assertFalse(render.fits_whatsapp)
        shared = share_encode(render)
        self.assertTrue(shared.fits_whatsapp)
        self.assertLessEqual(shared.bytes, WHATSAPP_LIMIT_BYTES)

    def test_renders_are_deterministic(self):
        a = self.provider.render(self.twin, "same", 30, "cloned")
        b = self.provider.render(self.twin, "same", 30, "cloned")
        self.assertEqual(a.ref, b.ref)


if __name__ == "__main__":
    unittest.main()
