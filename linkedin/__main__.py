"""Command line entry point.

    python -m linkedin whoami
    python -m linkedin post "Text of the post" [--image path] [--visibility PUBLIC]
    python -m linkedin queue
    python -m linkedin publish [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .client import LinkedInClient, LinkedInError
from .queue import archive, due_posts, load_queue, post_kwargs, resolve_media

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path = REPO_ROOT / ".env") -> None:
    """Populate os.environ from a .env file, leaving real env vars untouched."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if sep:
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def cmd_whoami(_: argparse.Namespace) -> int:
    client = LinkedInClient()
    info = client.me()
    print(f"{info.get('name', '(no name)')} <{info.get('email', 'no email scope')}>")
    print(f"author URN: urn:li:person:{info['sub']}")
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    client = LinkedInClient()
    media_urn = None
    if args.image:
        media_urn = client.upload_image(args.image)
    result = client.create_post(
        args.text,
        visibility=args.visibility,
        media_urn=media_urn,
        media_alt_text=args.alt_text,
    )
    print(f"Published {result.urn}\n{result.url}")
    return 0


def cmd_queue(_: argparse.Namespace) -> int:
    posts = load_queue()
    if not posts:
        print("Queue is empty. Add a markdown file to content/queue/.")
        return 0
    for post in posts:
        when = post.publish_at.isoformat() if post.publish_at else "next run"
        marker = "DUE" if post.is_due() else "   "
        preview = post.body.splitlines()[0][:60]
        print(f"{marker}  {when:<28}  {post.path.name}  {preview}")
    return 0


def cmd_publish(args: argparse.Namespace) -> int:
    pending = due_posts()
    if not pending:
        print("Nothing due.")
        return 0

    if args.dry_run:
        for post in pending:
            print(f"[dry-run] would publish {post.path.name}")
        return 0

    client = LinkedInClient()
    failures = 0
    for post in pending:
        try:
            image_path, alt_text = resolve_media(post)
            media_urn = client.upload_image(image_path) if image_path else None
            result = client.create_post(
                post.body, media_urn=media_urn, media_alt_text=alt_text, **post_kwargs(post)
            )
        except (LinkedInError, FileNotFoundError) as exc:
            # Keep going: one bad post should not strand the rest of the queue.
            print(f"FAILED {post.path.name}: {exc}", file=sys.stderr)
            failures += 1
            continue
        archive(post, result.urn)
        print(f"Published {post.path.name} -> {result.url}")

    return 1 if failures else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="linkedin", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("whoami", help="show the account the token belongs to").set_defaults(
        func=cmd_whoami
    )

    post = sub.add_parser("post", help="publish a post immediately")
    post.add_argument("text")
    post.add_argument("--image", help="path to an image to attach")
    post.add_argument("--alt-text", default="", help="alt text for the image")
    post.add_argument("--visibility", default="PUBLIC", choices=["PUBLIC", "CONNECTIONS"])
    post.set_defaults(func=cmd_post)

    sub.add_parser("queue", help="list queued posts").set_defaults(func=cmd_queue)

    publish = sub.add_parser("publish", help="publish everything currently due")
    publish.add_argument("--dry-run", action="store_true", help="list without posting")
    publish.set_defaults(func=cmd_publish)

    return parser


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except LinkedInError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
