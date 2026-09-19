"""One-time OAuth helper: run locally to mint an access token.

Starts a throwaway HTTP server on localhost to catch LinkedIn's redirect, so
you never have to copy a code out of a URL bar by hand.

    python -m linkedin.auth

Requires LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in the environment,
and http://localhost:8765/callback registered as an authorized redirect URL
on your app at https://www.linkedin.com/developers/apps.
"""

from __future__ import annotations

import datetime as dt
import http.server
import os
import secrets
import sys
import threading
import urllib.parse
import webbrowser

from .client import env_name, exchange_code_for_token, load_dotenv, profile_env

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


def main(argv: list[str] | None = None) -> int:
    """Mint a token. ``--profile <name>`` authorizes a second LinkedIn app."""
    args = argv if argv is not None else sys.argv[1:]
    profile = ""
    if args and args[0] == "--profile":
        if len(args) < 2:
            print("--profile needs a name, e.g. --profile storeburst", file=sys.stderr)
            return 1
        profile = args[1]

    load_dotenv()
    redirect_uri = profile_env("REDIRECT_URI", profile, "http://localhost:8765/callback")
    scopes = profile_env("SCOPES", profile, "openid profile w_member_social")

    client_id = profile_env("CLIENT_ID", profile)
    client_secret = profile_env("CLIENT_SECRET", profile)
    if not client_id or not client_secret:
        print(
            f"Set {env_name('CLIENT_ID', profile)} and "
            f"{env_name('CLIENT_SECRET', profile)} first "
            "(copy .env.example to .env and fill it in).",
            file=sys.stderr,
        )
        return 1

    if profile:
        print(f"Authorizing the '{profile}' app.")
        print("Check you are signed in to LinkedIn as an admin of that page.\n")

    state = secrets.token_urlsafe(16)
    auth_url = "https://www.linkedin.com/oauth/v2/authorization?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "scope": scopes,
        }
    )

    parsed = urllib.parse.urlparse(redirect_uri)
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

    token = exchange_code_for_token(_result["code"], client_id, client_secret, redirect_uri)
    access_token = token["access_token"]
    expires_in = int(token.get("expires_in", 0))
    expires_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=expires_in)

    print("\nAccess token acquired.")
    print(f"Valid for roughly {expires_in // 86400} days, until {expires_at:%Y-%m-%d}.\n")
    print("Add both lines to your .env (never commit them):\n")
    print(f"{env_name('ACCESS_TOKEN', profile)}={access_token}")
    print(f"{env_name('TOKEN_EXPIRES_AT', profile)}={expires_at.isoformat()}\n")
    if "refresh_token" in token:
        print(f"{env_name('REFRESH_TOKEN', profile)}={token['refresh_token']}\n")
    print(f"For CI, store it as the {env_name('ACCESS_TOKEN', profile)} repository secret.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
