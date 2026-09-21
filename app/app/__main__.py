"""Run the app: ``python -m app`` from ``projects/identical/app``."""

from __future__ import annotations

import argparse

from .db import connect
from .health import cohorts, for_all
from .server import serve


def cmd_health(args: argparse.Namespace) -> int:
    """Who is about to leave, and who should be moved up a plan."""
    conn = connect(args.db)
    accounts = for_all(conn)
    if not accounts:
        print("No organisations yet.")
        return 0

    width = max(len(a.name) for a in accounts)
    print(f"{'ACCOUNT':<{width}}  {'PLAN':<8} {'TOKENS':>8} {'SEATS':>7} "
          f"{'LAST':>6}  VERDICT")
    for a in accounts:
        last = "never" if a.days_since_video is None else f"{a.days_since_video}d"
        print(f"{a.name:<{width}}  {a.plan:<8} "
              f"{a.tokens_used:>3}/{a.tokens_included:<4} "
              f"{a.seats_active:>3}/{a.seats_paid:<3} {last:>6}  {a.verdict}")
        for line in a.risks:
            print(f"{'':<{width}}    - {line}")
        for line in a.opportunities:
            print(f"{'':<{width}}    + {line}")

    print("\nRETENTION BY COHORT")
    for cohort in cohorts(conn):
        print(f"  {cohort.month}  {cohort.signed_up:>3} signed up  "
              f"{cohort.still_paying:>3} still paying  {cohort.retained:>6.0%}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="app", description="The IDENTICAL app.")
    parser.add_argument("--db", default=None, help="SQLite path (default: identical.db)")
    sub = parser.add_subparsers(dest="command")

    run = sub.add_parser("serve", help="run the web app (the default)")
    run.add_argument("--port", type=int, default=8000)
    run.set_defaults(func=lambda a: serve(port=a.port, db_path=a.db) or 0)

    sub.add_parser("health", help="account health and retention").set_defaults(
        func=cmd_health
    )

    args = parser.parse_args()
    if args.command is None:
        # Bare `python -m app` still starts the server.
        serve(port=8000, db_path=args.db)
        return 0
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
