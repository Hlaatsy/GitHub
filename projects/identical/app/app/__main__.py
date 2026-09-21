"""Run the app: ``python -m app`` from ``projects/identical/app``."""

from __future__ import annotations

import argparse

from .server import serve


def main() -> int:
    parser = argparse.ArgumentParser(prog="app", description="Run the IDENTICAL web app.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default=None, help="SQLite path (default: identical.db)")
    args = parser.parse_args()
    serve(port=args.port, db_path=args.db)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
