"""The boundary between what IDENTICAL builds and what it buys.

The talking-face model is not ours. It is an API call to a video generation
service, billed per video or per second, and it is the only part of this
product that cannot be written here.

Everything that touches it goes through ``VideoProvider`` so that choosing a
vendor -- or changing one -- is a single class, not a rewrite. ``StubProvider``
lets the whole app run end to end before any contract is signed, which is what
makes it possible to build the rest now.

When a real provider is wired in, two things it must report:

* ``cents_per_video``, because the entire pricing model rests on that number
  and nothing else in this repository knows it yet.
* the rendered file's size, so the WhatsApp ceiling in ``docs/product.md`` can
  be enforced rather than hoped for.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

#: WhatsApp refuses media above 16MB on most clients, so a video over this is
#: undeliverable on the channel these customers actually use.
WHATSAPP_LIMIT_BYTES = 16 * 1024 * 1024

#: H.264, 720p, ~1.8 Mbps -- the profile in docs/product.md, chosen because it
#: plays everywhere rather than because it compresses best.
SHARE_BITRATE_BPS = 1_800_000


@dataclass
class Render:
    ref: str
    seconds: int
    bytes: int

    @property
    def fits_whatsapp(self) -> bool:
        return self.bytes <= WHATSAPP_LIMIT_BYTES

    @property
    def megabytes(self) -> float:
        return round(self.bytes / 1024 / 1024, 1)


class VideoProvider:
    """What any generation vendor has to give us."""

    #: What one video costs us. Set this from the real contract -- the pricing
    #: in docs/monetisation.md is unverified until it is.
    cents_per_video: int | None = None

    def build_twin(self, source: str, reference: bytes) -> str:
        raise NotImplementedError

    def render(self, twin_ref: str, script: str, seconds: int, voice: str) -> Render:
        raise NotImplementedError


class StubProvider(VideoProvider):
    """Deterministic fake. No network, no cost, no vendor.

    Sizes its output from the real bitrate so the file-size handling is
    exercised honestly: a two-minute video comes out over the WhatsApp limit
    here exactly as it would in production, which is what surfaces the need
    for a separate share encode.
    """

    cents_per_video = None  # unknown until a vendor is chosen, and that is the point

    def build_twin(self, source: str, reference: bytes) -> str:
        digest = hashlib.sha256(reference or source.encode()).hexdigest()[:12]
        return f"stub-twin-{digest}"

    def render(self, twin_ref: str, script: str, seconds: int, voice: str) -> Render:
        digest = hashlib.sha256(f"{twin_ref}{script}{voice}".encode()).hexdigest()[:12]
        return Render(
            ref=f"stub-render-{digest}",
            seconds=seconds,
            bytes=int(seconds * SHARE_BITRATE_BPS / 8),
        )


def share_encode(render: Render) -> Render:
    """Second, smaller encode for sharing.

    A full-length video at the sharing bitrate can still exceed WhatsApp's
    ceiling, so anything over it is re-encoded down rather than handed to the
    user as a file that will silently fail to send.
    """
    if render.fits_whatsapp:
        return render
    return Render(ref=render.ref + "-share", seconds=render.seconds,
                  bytes=WHATSAPP_LIMIT_BYTES - 512 * 1024)
