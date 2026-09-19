"""A file-backed scheduling queue.

LinkedIn's Posts API publishes immediately -- it has no scheduled-post
endpoint. So scheduling here means: keep queued posts as markdown files with
a ``publish_at`` timestamp, and have a periodic job publish whatever is due.

A queued post looks like:

    ---
    publish_at: 2026-09-20T09:00:00Z
    visibility: PUBLIC
    image: assets/launch.png
    alt_text: The new bottle on a white background
    ---
    Body text becomes the post commentary.
"""

from __future__ import annotations

import datetime as dt
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
QUEUE_DIR = REPO_ROOT / "content" / "queue"
PUBLISHED_DIR = REPO_ROOT / "content" / "published"


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


def load_queue(queue_dir: Path = QUEUE_DIR) -> list[QueuedPost]:
    """Read every queued markdown file, oldest scheduled first."""
    posts: list[QueuedPost] = []
    for path in sorted(queue_dir.glob("*.md")):
        if is_ignored(path):
            continue
        meta, body = parse_front_matter(path.read_text(encoding="utf-8"))
        if not body:
            continue
        posts.append(QueuedPost(path=path, body=body, meta=meta))

    far_future = dt.datetime.max.replace(tzinfo=dt.timezone.utc)
    return sorted(posts, key=lambda p: p.publish_at or far_future)


def due_posts(now: dt.datetime | None = None, queue_dir: Path = QUEUE_DIR) -> list[QueuedPost]:
    return [post for post in load_queue(queue_dir) if post.is_due(now)]


def archive(post: QueuedPost, urn: str, published_dir: Path = PUBLISHED_DIR) -> Path:
    """Move a published post out of the queue, recording the URN it became."""
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


def post_kwargs(post: QueuedPost) -> dict[str, Any]:
    """Map front-matter fields onto LinkedInClient.create_post arguments."""
    kwargs: dict[str, Any] = {"visibility": post.meta.get("visibility", "PUBLIC")}
    if post.meta.get("article_url"):
        kwargs["article_url"] = post.meta["article_url"]
        if post.meta.get("article_title"):
            kwargs["article_title"] = post.meta["article_title"]
    return kwargs
