"""Taking money, through Paystack.

Paystack rather than a card processor alone, because it carries the rails
this market actually uses -- EFT, instant EFT, mobile money and cards -- and
the same integration reaches Nigeria, Ghana and Kenya when those markets come.

Three rules this module exists to enforce. Each one is a way of losing money
or trust that is easy to write and hard to notice afterwards:

1. **Never trust an amount from the browser.** What a payment was for is
   decided here, written down before the customer is sent anywhere, and
   checked against what the gateway says was actually paid.
2. **Applying a payment is idempotent.** A webhook is delivered more than
   once by design, and the callback and the webhook both arrive for the same
   transaction. Crediting twice is a refund conversation.
3. **A webhook is not trusted until its signature verifies.** The endpoint is
   public, and an unsigned "payment succeeded" is an invitation to anyone.

The gateway is behind an interface so tests never touch the network and a
development run needs no keys.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

PAYSTACK_API = "https://api.paystack.co"

#: Paystack quotes amounts in the currency's minor unit -- cents for ZAR --
#: which is what this application stores, so no conversion is needed. Getting
#: this wrong by a factor of 100 is the classic integration bug.
CURRENCY = os.environ.get("IDENTICAL_CURRENCY", "ZAR")

HTTP_TIMEOUT_SECONDS = 15


class PaymentError(Exception):
    """The gateway could not be reached, or refused."""


@dataclass
class Checkout:
    """Where to send the customer to pay."""

    reference: str
    url: str


@dataclass
class Verification:
    """What the gateway says actually happened."""

    reference: str
    paid: bool
    cents: int
    currency: str = ""
    gateway_ref: str = ""


def new_reference() -> str:
    """Our reference, not the gateway's. Generated before any money moves."""
    return f"idt_{secrets.token_urlsafe(12)}"


class Gateway:
    def initialise(self, reference: str, email: str, cents: int,
                   callback_url: str, metadata: dict) -> Checkout:
        raise NotImplementedError

    def verify(self, reference: str) -> Verification:
        raise NotImplementedError

    def signature_ok(self, body: bytes, signature: str) -> bool:
        raise NotImplementedError


@dataclass
class StubGateway(Gateway):
    """No network, no keys. Treats every checkout as paid on verification."""

    paid: bool = True
    seen: list[tuple[str, int]] = None

    def __post_init__(self) -> None:
        self.seen = []

    def initialise(self, reference, email, cents, callback_url, metadata):
        self.seen.append((reference, cents))
        return Checkout(reference=reference,
                        url=f"{callback_url}?reference={reference}&stub=1")

    def verify(self, reference):
        cents = next((c for r, c in self.seen if r == reference), 0)
        return Verification(reference=reference, paid=self.paid, cents=cents,
                            currency=CURRENCY, gateway_ref=f"stub_{reference}")

    def signature_ok(self, body: bytes, signature: str) -> bool:
        return signature == "stub"


@dataclass
class PaystackGateway(Gateway):
    secret_key: str

    def _call(self, method: str, path: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            PAYSTACK_API + path, data=data, method=method,
            headers={"Authorization": f"Bearer {self.secret_key}",
                     "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise PaymentError(f"Paystack returned {exc.code}: {detail}") from exc
        except (OSError, ValueError) as exc:
            raise PaymentError(f"could not reach Paystack: {exc}") from exc

        if not body.get("status"):
            raise PaymentError(body.get("message", "Paystack refused the request"))
        return body.get("data", {})

    def initialise(self, reference, email, cents, callback_url, metadata):
        data = self._call("POST", "/transaction/initialize", {
            "email": email,
            "amount": cents,          # already the minor unit
            "currency": CURRENCY,
            "reference": reference,
            "callback_url": callback_url,
            "metadata": metadata,
        })
        url = data.get("authorization_url")
        if not url:
            raise PaymentError("Paystack did not return a checkout URL")
        return Checkout(reference=reference, url=url)

    def verify(self, reference):
        data = self._call("GET", f"/transaction/verify/{urllib.parse.quote(reference)}")
        return Verification(
            reference=reference,
            paid=data.get("status") == "success",
            cents=int(data.get("amount") or 0),
            currency=data.get("currency", ""),
            gateway_ref=str(data.get("id") or ""),
        )

    def signature_ok(self, body: bytes, signature: str) -> bool:
        """Paystack signs the raw body with HMAC-SHA512 of the secret key.

        Compared in constant time, and against the bytes as received -- parse
        the JSON first and a re-serialised body will not match.
        """
        if not signature:
            return False
        expected = hmac.new(self.secret_key.encode(), body, hashlib.sha512).hexdigest()
        return hmac.compare_digest(expected, signature)


def from_env() -> Gateway:
    """Paystack when a secret key is set, otherwise the stub."""
    key = os.environ.get("PAYSTACK_SECRET_KEY", "").strip()
    return PaystackGateway(secret_key=key) if key else StubGateway()
