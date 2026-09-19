"""A file-backed scheduling queue.

LinkedIn's Posts API publishes immediately -- it has no scheduled-post
endpoint. So scheduling here means: keep queued posts as markdown files with
a ``publish_at`` timestamp, and have a periodic job publish whatever is due.

A queued post looks like:

    ---
    publish_at: 2026-09-20T09:00:00Z
    visibility: PUBLIC
    author_urn: urn:li:organization:123456
    image: assets/launch.png
    alt_text: The new bottle on a white background
    ---
    Body text becomes the post commentary.

``author_urn`` is optional and overrides ``LINKEDIN_AUTHOR_URN`` for that one
post, so a single queue can publish to more than one company page. Omitting
it means the post goes out as whatever the environment points at -- which is
why a post for a different brand should always name its page explicitly
rather than relying on the default being right.
"""

from __future__ import annotations

import datetime as dt
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

# The original single-project layout. Still KhutsoGRC's own queue.
QUEUE_DIR = REPO_ROOT / "content" / "queue"
PUBLISHED_DIR = REPO_ROOT / "content" / "published"

# Separate brands live as separate projects: projects/<name>/queue/ and
# projects/<name>/published/, each with its own assets, docs and defaults.
# One publisher serves them all, but nothing else is shared.
PROJECTS_DIR = REPO_ROOT / "projects"

#: Filename holding a project's front-matter defaults (e.g. its profile).
PROJECT_CONF = "project.conf"


@dataclass
class QueuedPost:
    path: Path
    body: str
    meta: dict[str, str] = field(default_factory=dict)

    @property
    def publish_at(self) -> dt.datetime | None:
        raw = self.meta.get("publish_at")
        return parse_timestamp(raw) if raw else None

    def is_due(self, now: dt.datetime | None = None) -> bool:
        """Due when it has no timestamp (post on next run) or the time has passed."""
        when = self.publish_at
        if when is None:
            return True
        return when <= (now or dt.datetime.now(dt.timezone.utc))


def parse_timestamp(raw: str) -> dt.datetime:
    """Parse an ISO 8601 timestamp, treating a bare or Z-suffixed value as UTC."""
    text = raw.strip().replace("Z", "+00:00")
    parsed = dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    """Split ``---`` delimited ``key: value`` front matter from the body.

    Deliberately not YAML: the fields here are flat strings, and keeping it
    stdlib-only means no pip install to publish a post.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text.strip()

    meta: dict[str, str] = {}
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return meta, "\n".join(lines[index + 1 :]).strip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip().strip("\"'")

    # Unterminated front matter -- treat the whole file as body.
    return {}, text.strip()


def is_ignored(path: Path) -> bool:
    """Docs and drafts live alongside queued posts without being published."""
    return path.stem.upper() == "README" or path.name.startswith(("_", "."))


def queue_dirs(projects_dir: Path = PROJECTS_DIR) -> list[Path]:
    """Every queue this repo publishes from, oldest layout first.

    ``content/queue`` plus one per project directory. A project is any
    directory under ``projects/`` that has a ``queue/`` in it, so adding a
    brand means adding a folder, not editing this file.
    """
    dirs = [QUEUE_DIR] if QUEUE_DIR.is_dir() else []
    if projects_dir.is_dir():
        dirs.extend(sorted(p / "queue" for p in projects_dir.iterdir() if (p / "queue").is_dir()))
    return dirs


def project_defaults(queue_dir: Path) -> dict[str, str]:
    """Front-matter defaults for a project, from ``project.conf`` beside its queue.

    Lets a project set its ``profile`` and ``visibility`` once instead of on
    every post. A post's own front matter always wins.
    """
    conf = queue_dir.parent / PROJECT_CONF
    if not conf.is_file():
        return {}
    meta, _ = parse_front_matter("---\n" + conf.read_text(encoding="utf-8") + "\n---\n")
    return meta


def load_queue(queue_dir: Path | None = None) -> list[QueuedPost]:
    """Read every queued markdown file, oldest scheduled first.

    With no argument, reads every project's queue. Passing one reads only
    that directory, which is what the tests do.
    """
    posts: list[QueuedPost] = []
    for directory in [queue_dir] if queue_dir is not None else queue_dirs():
        defaults = project_defaults(directory)
        for path in sorted(directory.glob("*.md")):
            if is_ignored(path):
                continue
            meta, body = parse_front_matter(path.read_text(encoding="utf-8"))
            if not body:
                continue
            posts.append(QueuedPost(path=path, body=body, meta={**defaults, **meta}))

    far_future = dt.datetime.max.replace(tzinfo=dt.timezone.utc)
    return sorted(posts, key=lambda p: p.publish_at or far_future)


def due_posts(now: dt.datetime | None = None, queue_dir: Path | None = None) -> list[QueuedPost]:
    return [post for post in load_queue(queue_dir) if post.is_due(now)]


def archive(post: QueuedPost, urn: str, published_dir: Path | None = None) -> Path:
    """Move a published post out of the queue, recording the URN it became.

    Files into the ``published/`` beside the post's own queue, so each
    project keeps its own archive rather than pooling them.
    """
    if published_dir is None:
        published_dir = post.path.parent.parent / "published"
    published_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
    destination = published_dir / f"{stamp}-{post.path.name}"

    counter = 2
    while destination.exists():
        destination = published_dir / f"{stamp}-{post.path.stem}-{counter}{post.path.suffix}"
        counter += 1

    shutil.move(str(post.path), str(destination))
    with destination.open("a", encoding="utf-8") as handle:
        handle.write(f"\n\n<!-- published {stamp} as {urn} -->\n")
    return destination


def resolve_media(post: QueuedPost) -> tuple[Path | None, str]:
    """Return the image path referenced by a queued post, if any."""
    reference = post.meta.get("image")
    if not reference:
        return None, ""
    path = Path(reference)
    if not path.is_absolute():
        path = REPO_ROOT / path
    if not path.exists():
        raise FileNotFoundError(f"{post.path.name} references a missing image: {reference}")
    return path, post.meta.get("alt_text", "")


def profile(post: QueuedPost) -> str:
    """The credential set this post publishes with, or "" for the default.

    A profile names a separate LinkedIn app: its own client ID, secret and
    token. ``profile: storeburst`` reads LINKEDIN_STOREBURST_ACCESS_TOKEN and
    LINKEDIN_STOREBURST_AUTHOR_URN. Brands that are separate apps should use
    this rather than ``author_urn`` alone, because a page ID without a token
    that administers the page only fails at the API.
    """
    return post.meta.get("profile", "").strip()


def author_urn(post: QueuedPost) -> str:
    """The page this post publishes as, or "" to use the configured default.

    Returned unvalidated: ``LinkedInClient`` normalizes it, and a value it
    cannot read raises rather than quietly falling back to the default page.
    Publishing a brand's post to the wrong company page is not an error worth
    recovering from silently.
    """
    return post.meta.get("author_urn", "").strip()


def post_kwargs(post: QueuedPost) -> dict[str, Any]:
    """Map front-matter fields onto LinkedInClient.create_post arguments."""
    kwargs: dict[str, Any] = {"visibility": post.meta.get("visibility", "PUBLIC")}
    if post.meta.get("article_url"):
        kwargs["article_url"] = post.meta["article_url"]
        if post.meta.get("article_title"):
            kwargs["article_title"] = post.meta["article_title"]
    return kwargs
