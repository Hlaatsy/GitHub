"""Thin client over LinkedIn's Posts API.

Standard library only, so this runs anywhere Python 3.9+ does without a
pip install step. LinkedIn's REST surface is versioned by a monthly date
header; see LINKEDIN_VERSION below.
"""

from __future__ import annotations

import datetime as dt
import json
import mimetypes
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .queue import parse_timestamp

API_BASE = "https://api.linkedin.com"

# LinkedIn versions its REST API by month (YYYYMM) and retires versions
# roughly a year after release. Bump this when LinkedIn deprecates it --
# an out-of-date value comes back as a 426 Upgrade Required.
LINKEDIN_VERSION = os.environ.get("LINKEDIN_VERSION", "202505")


REPO_ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path | None = None) -> None:
    """Populate os.environ from the repo's .env, leaving real env vars alone.

    Every entry point calls this before reading configuration, so running a
    command manually behaves the same as running it from CI.
    """
    path = path or REPO_ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if sep:
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


EXPIRY_WARNING_DAYS = 7


def token_expires_at(profile: str = "") -> dt.datetime | None:
    """When the current access token dies, if auth.py recorded it."""
    raw = profile_env("TOKEN_EXPIRES_AT", profile)
    if not raw:
        return None
    try:
        return parse_timestamp(raw)
    except ValueError:
        return None


def days_until_expiry(now: dt.datetime | None = None, profile: str = "") -> int | None:
    """Whole days left on the token, negative once expired, None if unknown."""
    expiry = token_expires_at(profile)
    if expiry is None:
        return None
    delta = expiry - (now or dt.datetime.now(dt.timezone.utc))
    return delta.days


def expiry_warning(now: dt.datetime | None = None, profile: str = "") -> str:
    """A line worth printing about the token, or "" when there is nothing to say."""
    days = days_until_expiry(now, profile)
    if days is None:
        return ""
    if days < 0:
        return (
            "Access token EXPIRED "
            f"{abs(days)} day(s) ago. Re-run `python -m linkedin.auth` -- "
            "posts will fail until you do."
        )
    if days <= EXPIRY_WARNING_DAYS:
        return (
            f"Access token expires in {days} day(s). "
            "Re-run `python -m linkedin.auth` to renew it."
        )
    return ""


def review_date() -> dt.datetime | None:
    """When the agreed run window closes, if one was configured."""
    raw = os.environ.get("LINKEDIN_SCHEDULE_ENDS_AT", "").strip()
    if not raw:
        return None
    try:
        return parse_timestamp(raw)
    except ValueError:
        return None


def review_due(now: dt.datetime | None = None) -> bool:
    """True once the run window has closed, so publishing should pause."""
    ends = review_date()
    if ends is None:
        return False
    return (now or dt.datetime.now(dt.timezone.utc)) >= ends


def review_notice(now: dt.datetime | None = None) -> str:
    """A line about the run window, or "" when there is nothing to say."""
    ends = review_date()
    if ends is None:
        return ""

    now = now or dt.datetime.now(dt.timezone.utc)
    if now >= ends:
        return (
            f"Run window ended {ends:%Y-%m-%d}. Publishing is paused pending review. "
            "Extend or clear LINKEDIN_SCHEDULE_ENDS_AT to resume."
        )
    days = (ends - now).days
    if days <= EXPIRY_WARNING_DAYS:
        return f"Run window closes in {days} day(s), on {ends:%Y-%m-%d}."
    return ""


class LinkedInError(RuntimeError):
    """An API call failed. Carries the HTTP status and LinkedIn's response body."""

    def __init__(self, status: int, body: str, url: str) -> None:
        # status 0 is used for local/configuration problems, which have no
        # HTTP context worth printing.
        message = body if status == 0 else f"LinkedIn API {status} for {url}: {body}"
        super().__init__(message)
        self.status = status
        self.body = body
        self.url = url


@dataclass
class PostResult:
    urn: str

    @property
    def url(self) -> str:
        return f"https://www.linkedin.com/feed/update/{self.urn}/"


def _request(
    method: str,
    url: str,
    *,
    token: str | None = None,
    json_body: Any = None,
    raw_body: bytes | None = None,
    content_type: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["LinkedIn-Version"] = LINKEDIN_VERSION
        headers["X-Restli-Protocol-Version"] = "2.0.0"
    if extra_headers:
        headers.update(extra_headers)

    body = raw_body
    if json_body is not None:
        body = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if content_type:
        headers["Content-Type"] = content_type

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        raise LinkedInError(exc.code, exc.read().decode("utf-8", "replace"), url) from exc


ORG_URL_RE = re.compile(r"linkedin\.com/company/(\d+)")


def env_name(setting: str, profile: str = "") -> str:
    """The environment variable a setting reads for a given profile.

    Default profile: ``LINKEDIN_ACCESS_TOKEN``.
    Profile "storeburst": ``LINKEDIN_STOREBURST_ACCESS_TOKEN``.
    """
    slug = re.sub(r"[^A-Za-z0-9]+", "_", profile).strip("_").upper()
    return f"LINKEDIN_{slug}_{setting}" if slug else f"LINKEDIN_{setting}"


#: Settings that identify *who is posting*. A named profile must supply these
#: itself -- they never fall back to the default profile's value. Inheriting a
#: token or a page from another brand is how a post ends up on the wrong
#: company page, which is the failure this whole mechanism exists to prevent.
CREDENTIALS = frozenset({"CLIENT_ID", "CLIENT_SECRET", "ACCESS_TOKEN", "AUTHOR_URN"})


def profile_env(setting: str, profile: str = "", default: str = "") -> str:
    """Read a setting for a profile.

    Non-credential settings (API version, redirect URI, scopes, schedule
    window) fall back to the shared ``LINKEDIN_*`` value, because they are the
    same whoever is posting. Credentials do not -- see ``CREDENTIALS``.
    """
    value = os.environ.get(env_name(setting, profile), "").strip()
    if value or (profile and setting in CREDENTIALS):
        return value
    return os.environ.get(env_name(setting), "").strip() or default


#: Every per-profile setting, used to recognise a profile's variables.
SETTINGS = (
    "CLIENT_ID",
    "CLIENT_SECRET",
    "ACCESS_TOKEN",
    "AUTHOR_URN",
    "TOKEN_EXPIRES_AT",
    "REFRESH_TOKEN",
    "SCOPES",
    "REDIRECT_URI",
    "VERSION",
)


def configured_profiles() -> list[str]:
    """Profile names that have at least one LINKEDIN_<NAME>_* variable set.

    Discovered from the environment rather than hard-coded, so adding a brand
    is a matter of adding its variables. The unnamed default profile is not
    listed here -- it has no prefix to find.
    """
    known = set(SETTINGS)
    found: set[str] = set()
    for key in os.environ:
        if not key.startswith("LINKEDIN_"):
            continue
        rest = key[len("LINKEDIN_") :]
        for setting in known:
            if rest.endswith(f"_{setting}"):
                name = rest[: -len(setting) - 1]
                if name:
                    found.add(name.lower())
    return sorted(found)


def normalize_author_urn(value: str) -> str:
    """Accept a URN, a bare organization ID, or a company page URL.

    The admin dashboard URL carries the organization ID, so pasting it
    straight from the browser is the common case:
    ``linkedin.com/company/145207663/admin/`` -> ``urn:li:organization:145207663``
    """
    value = value.strip()
    if not value:
        return ""
    if value.startswith("urn:li:"):
        return value

    match = ORG_URL_RE.search(value)
    if match:
        return f"urn:li:organization:{match.group(1)}"
    if value.isdigit():
        return f"urn:li:organization:{value}"

    raise LinkedInError(
        0,
        f"cannot read an author URN from {value!r}; expected urn:li:organization:<id>, "
        "a numeric page ID, or a linkedin.com/company/<id> URL",
        "",
    )


class LinkedInClient:
    """Publishes posts as a member or as an organization page.

    The token must carry ``w_member_social`` to post as a member, or
    ``w_organization_social`` (Community Management API, requires LinkedIn
    review) to post as a company page.
    """

    def __init__(
        self, token: str | None = None, author: str | None = None, profile: str = ""
    ) -> None:
        self.profile = profile
        self.token = token or profile_env("ACCESS_TOKEN", profile)
        if not self.token:
            name = env_name("ACCESS_TOKEN", profile)
            hint = (
                f" -- run `python -m linkedin.auth --profile {profile}` to mint one"
                if profile
                else ""
            )
            raise LinkedInError(0, f"{name} is not set{hint}", "")
        self._author = normalize_author_urn(author or profile_env("AUTHOR_URN", profile))

    @property
    def author(self) -> str:
        """The URN posts are attributed to, resolved from the token if unset."""
        if not self._author:
            self._author = f"urn:li:person:{self.me()['sub']}"
        return self._author

    def me(self) -> dict[str, Any]:
        """OpenID Connect userinfo for the token holder. Needs the ``profile`` scope."""
        _, _, body = _request("GET", f"{API_BASE}/v2/userinfo", token=self.token)
        return json.loads(body)

    def create_post(
        self,
        commentary: str,
        *,
        visibility: str = "PUBLIC",
        media_urn: str | None = None,
        media_alt_text: str = "",
        article_url: str | None = None,
        article_title: str | None = None,
    ) -> PostResult:
        """Publish a post. Returns its URN, which LinkedIn puts in a response header."""
        payload: dict[str, Any] = {
            "author": self.author,
            "commentary": commentary,
            "visibility": visibility,
            "distribution": {
                "feedDistribution": "MAIN_FEED",
                "targetEntities": [],
                "thirdPartyDistributionChannels": [],
            },
            "lifecycleState": "PUBLISHED",
            "isReshareDisabledByAuthor": False,
        }

        if media_urn:
            payload["content"] = {"media": {"id": media_urn, "altText": media_alt_text}}
        elif article_url:
            article: dict[str, Any] = {"source": article_url}
            if article_title:
                article["title"] = article_title
            payload["content"] = {"article": article}

        status, headers, body = _request(
            "POST", f"{API_BASE}/rest/posts", token=self.token, json_body=payload
        )
        urn = headers.get("x-restli-id") or headers.get("X-RestLi-Id") or ""
        if not urn:
            # Some responses echo the id in the body instead of the header.
            try:
                urn = json.loads(body).get("id", "")
            except (ValueError, AttributeError):
                urn = ""
        if not urn:
            raise LinkedInError(status, f"no post id in response: {body!r}", f"{API_BASE}/rest/posts")
        return PostResult(urn)

    def upload_image(self, path: str | Path, *, owner: str | None = None) -> str:
        """Register and upload an image, returning its ``urn:li:image:...`` id."""
        path = Path(path)
        owner = owner or self.author

        _, _, body = _request(
            "POST",
            f"{API_BASE}/rest/images?action=initializeUpload",
            token=self.token,
            json_body={"initializeUploadRequest": {"owner": owner}},
        )
        value = json.loads(body)["value"]
        upload_url, image_urn = value["uploadUrl"], value["image"]

        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        _request(
            "PUT",
            upload_url,
            token=self.token,
            raw_body=path.read_bytes(),
            content_type=content_type,
        )
        return image_urn


    def administered_organizations(self) -> list[tuple[str, str]]:
        """Pages this token may act for, as ``(urn, name)``.

        Needs ``rw_organization_admin``, so it only works once LinkedIn has
        approved the app for the Community Management API.
        """
        url = (
            f"{API_BASE}/rest/organizationAcls"
            "?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED"
        )
        _, _, body = _request("GET", url, token=self.token)

        organizations: list[tuple[str, str]] = []
        for element in json.loads(body).get("elements", []):
            urn = element.get("organization", "")
            if urn:
                organizations.append((urn, self.organization_name(urn)))
        return organizations

    def organization_name(self, urn: str) -> str:
        """Display name for an organization URN, or "" if it cannot be read."""
        org_id = urn.rsplit(":", 1)[-1]
        try:
            _, _, body = _request(
                "GET", f"{API_BASE}/rest/organizations/{org_id}", token=self.token
            )
        except LinkedInError:
            return ""
        data = json.loads(body)
        return data.get("localizedName") or data.get("vanityName") or ""


def exchange_code_for_token(
    code: str, client_id: str, client_secret: str, redirect_uri: str
) -> dict[str, Any]:
    """Trade an OAuth authorization code for an access token."""
    data = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
        }
    ).encode()
    _, _, body = _request(
        "POST",
        "https://www.linkedin.com/oauth/v2/accessToken",
        raw_body=data,
        content_type="application/x-www-form-urlencoded",
    )
    return json.loads(body)
