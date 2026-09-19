"""Command line entry point.

    python -m linkedin whoami
    python -m linkedin pages
    python -m linkedin post "Text of the post" [--image path] [--visibility PUBLIC]
    python -m linkedin queue
    python -m linkedin publish [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys

from .client import (
    LinkedInClient,
    LinkedInError,
    configured_profiles,
    days_until_expiry,
    env_name,
    expiry_warning,
    load_dotenv,
    profile_env,
    review_due,
    review_notice,
)
from .queue import archive, author_urn, due_posts, load_queue, post_kwargs, profile, resolve_media


def cmd_whoami(args: argparse.Namespace) -> int:
    client = LinkedInClient(profile=args.profile)
    info = client.me()
    print(f"signed in as: {info.get('name', '(no name)')}")
    print(f"posts publish as: {client.author}")
    if args.profile:
        print(f"using the '{args.profile}' app's credentials")
    return 0


def cmd_token(args: argparse.Namespace) -> int:
    days = days_until_expiry(profile=args.profile)
    if days is None:
        print(
            f"Token lifetime unknown -- {env_name('TOKEN_EXPIRES_AT', args.profile)} "
            f"is not set. Re-run `python -m linkedin.auth"
            f"{' --profile ' + args.profile if args.profile else ''}` to record it."
        )
        return 0

    warning = expiry_warning(profile=args.profile)
    print(warning or f"Access token is healthy: {days} day(s) remaining.")

    notice = review_notice()
    if notice:
        print(notice)
    return 1 if days < 0 else 0


def cmd_pages(args: argparse.Namespace) -> int:
    client = LinkedInClient(profile=args.profile)
    organizations = client.administered_organizations()
    if not organizations:
        print(
            "No administered pages returned. Either the token lacks "
            "rw_organization_admin, or the app is not yet approved for the "
            "Community Management API."
        )
        return 1

    configured = profile_env("AUTHOR_URN", args.profile)
    for urn, name in organizations:
        marker = "*" if configured and urn.endswith(configured.rsplit(":", 1)[-1]) else " "
        print(f"{marker} {urn}  {name}")
    print(f"\n* = the page {env_name('AUTHOR_URN', args.profile)} currently points at")
    return 0


def cmd_profiles(_: argparse.Namespace) -> int:
    """What each brand's app is configured for, and what is still missing.

    Three separate apps means three tokens on three expiry clocks and three
    approval states. This answers "which of these can actually publish right
    now" without opening .env.
    """
    names = [""] + configured_profiles()
    queued: dict[str, list[str]] = {}
    for post in load_queue():
        queued.setdefault(profile(post), []).append(post.path.name)

    for name in names:
        label = name or "(default)"
        token = profile_env("ACCESS_TOKEN", name)
        page = profile_env("AUTHOR_URN", name)
        days = days_until_expiry(profile=name)

        print(f"{label}")
        print(f"  token    {'set' if token else 'MISSING -- ' + env_name('ACCESS_TOKEN', name)}")
        if page:
            print(f"  page     {page}")
        else:
            print("  page     not set -- posts would publish to the token holder's profile")
        if days is None:
            print("  expires  unknown")
        elif days < 0:
            print(f"  expires  EXPIRED {abs(days)} day(s) ago")
        else:
            print(f"  expires  in {days} day(s)")

        posts = queued.get(name, [])
        print(f"  queued   {len(posts)} post(s)" + (f": {', '.join(posts)}" if posts else ""))
        print()

    orphans = sorted(set(queued) - set(names))
    if orphans:
        print("Queued posts name profiles with no configuration at all:")
        for name in orphans:
            print(f"  {name}: {', '.join(queued[name])}")
        print("Those posts will fail until their LINKEDIN_<NAME>_* variables are set.")
        return 1
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    client = LinkedInClient(profile=args.profile)
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


def _target(post) -> str:
    """How a queued post's destination reads in CLI output."""
    name = profile(post)
    urn = author_urn(post) or profile_env("AUTHOR_URN", name)
    where = urn or "the token holder (no page set)"
    return f"{where}  [{name} app]" if name else where


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
        # The page is worth showing even when it is the default: a queue
        # serving two brands is one edited front-matter line away from
        # publishing to the wrong one.
        print(f"{'':5}{'':28}  -> {_target(post)}")
    return 0


def cmd_publish(args: argparse.Namespace) -> int:
    # Surfaced every run so an expiring token is noticed before posts start failing.
    for notice in (expiry_warning(), review_notice()):
        if notice:
            print(notice, file=sys.stderr)

    # A closed window pauses publishing rather than failing the job, so the
    # schedule goes quiet instead of turning the Actions log red every run.
    if review_due():
        print("Publishing paused: the run window has ended.")
        return 0

    pending = due_posts()
    if not pending:
        print("Nothing due.")
        return 0

    if args.dry_run:
        for post in pending:
            print(f"[dry-run] would publish {post.path.name} as {_target(post)}")
        return 0

    # One client per (profile, page): a queue can serve several brands, each
    # with its own LinkedIn app and token, and each post must be attributed to
    # the right page by a token allowed to post as it.
    clients: dict[tuple[str, str], LinkedInClient] = {}
    failures = 0
    for post in pending:
        try:
            # Keyed on both: a page and the app whose token may post as it.
            key = (profile(post), author_urn(post))
            if key not in clients:
                clients[key] = LinkedInClient(profile=key[0], author=key[1] or None)
            client = clients[key]
            image_path, alt_text = resolve_media(post)
            media_urn = client.upload_image(image_path) if image_path else None
            result = client.create_post(
                post.body, media_urn=media_urn, media_alt_text=alt_text, **post_kwargs(post)
            )
        except (LinkedInError, FileNotFoundError, ValueError) as exc:
            # Keep going: one bad post should not strand the rest of the queue.
            print(f"FAILED {post.path.name}: {exc}", file=sys.stderr)
            failures += 1
            continue
        archive(post, result.urn)
        print(f"Published {post.path.name} -> {result.url}")

    return 1 if failures else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="linkedin", description=__doc__)
    # A profile selects a separate LinkedIn app's credentials, so the same CLI
    # can act for more than one brand. Global, so it works before or after the
    # subcommand: `linkedin --profile storeburst pages`.
    parser.add_argument(
        "--profile",
        default="",
        help="credential set to use, e.g. storeburst (default: LINKEDIN_* vars)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("whoami", help="show the account the token belongs to").set_defaults(
        func=cmd_whoami
    )

    sub.add_parser("pages", help="list company pages this token can post for").set_defaults(
        func=cmd_pages
    )

    sub.add_parser("token", help="how many days the access token has left").set_defaults(
        func=cmd_token
    )

    post = sub.add_parser("post", help="publish a post immediately")
    post.add_argument("text")
    post.add_argument("--image", help="path to an image to attach")
    post.add_argument("--alt-text", default="", help="alt text for the image")
    post.add_argument("--visibility", default="PUBLIC", choices=["PUBLIC", "CONNECTIONS"])
    post.set_defaults(func=cmd_post)

    sub.add_parser("queue", help="list queued posts").set_defaults(func=cmd_queue)

    sub.add_parser(
        "profiles", help="show each brand's app: token, page, expiry, queued posts"
    ).set_defaults(func=cmd_profiles)

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
