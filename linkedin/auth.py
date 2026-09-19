"""One-time OAuth helper: run locally to mint an access token.

Starts a throwaway HTTP server on localhost to catch LinkedIn's redirect, so
you never have to copy a code out of a URL bar by hand.

    python -m linkedin.auth

Requires LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in the environment,
and http://localhost:8765/callback registered as an authorized redirect URL
on your app at https://www.linkedin.com/developers/apps.
"""

from __future__ import annotations

import http.server
import os
import secrets
import sys
import threading
import urllib.parse
import webbrowser

from .client import exchange_code_for_token

REDIRECT_URI = os.environ.get("LINKEDIN_REDIRECT_URI", "http://localhost:8765/callback")
SCOPES = os.environ.get("LINKEDIN_SCOPES", "openid profile w_member_social")

_result: dict[str, str] = {}


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _result.update({k: v[0] for k, v in query.items()})

        ok = "code" in _result
        message = "Authorized. You can close this tab." if ok else "Authorization failed."
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"<html><body><h2>{message}</h2></body></html>".encode())
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, *args: object) -> None:
        """Silence the default request logging."""


def main() -> int:
    client_id = os.environ.get("LINKEDIN_CLIENT_ID")
    client_secret = os.environ.get("LINKEDIN_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET first "
            "(copy .env.example to .env and fill it in).",
            file=sys.stderr,
        )
        return 1

    state = secrets.token_urlsafe(16)
    auth_url = "https://www.linkedin.com/oauth/v2/authorization?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "state": state,
            "scope": SCOPES,
        }
    )

    parsed = urllib.parse.urlparse(REDIRECT_URI)
    server = http.server.HTTPServer((parsed.hostname or "localhost", parsed.port or 80), _CallbackHandler)

    print("Opening LinkedIn authorization in your browser.")
    print(f"If it does not open, visit:\n  {auth_url}\n")
    webbrowser.open(auth_url)
    server.serve_forever()
    server.server_close()

    if _result.get("state") != state:
        print("State mismatch -- discarding response. Try again.", file=sys.stderr)
        return 1
    if "code" not in _result:
        print(f"No authorization code returned: {_result}", file=sys.stderr)
        return 1

    token = exchange_code_for_token(_result["code"], client_id, client_secret, REDIRECT_URI)
    access_token = token["access_token"]
    expires_days = int(token.get("expires_in", 0)) // 86400

    print("\nAccess token acquired.")
    print(f"Valid for roughly {expires_days} days.\n")
    print("Add this to your .env (never commit it):\n")
    print(f"LINKEDIN_ACCESS_TOKEN={access_token}\n")
    if "refresh_token" in token:
        print(f"LINKEDIN_REFRESH_TOKEN={token['refresh_token']}\n")
    print("For CI, store it as the LINKEDIN_ACCESS_TOKEN repository secret.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
