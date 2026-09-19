"""Tests for front-matter parsing and scheduling logic.

Run with: python -m unittest discover tests
"""

from __future__ import annotations

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from linkedin.queue import (  # noqa: E402
    QueuedPost,
    archive,
    author_urn,
    project_defaults,
    queue_dirs,
    due_posts,
    is_ignored,
    load_queue,
    parse_front_matter,
    parse_timestamp,
    post_kwargs,
)

UTC = dt.timezone.utc


class ParseFrontMatterTests(unittest.TestCase):
    def test_extracts_fields_and_body(self):
        meta, body = parse_front_matter(
            "---\npublish_at: 2026-01-01T09:00:00Z\nvisibility: PUBLIC\n---\nHello world\n"
        )
        self.assertEqual(meta["publish_at"], "2026-01-01T09:00:00Z")
        self.assertEqual(meta["visibility"], "PUBLIC")
        self.assertEqual(body, "Hello world")

    def test_file_without_front_matter_is_all_body(self):
        meta, body = parse_front_matter("Just a post.\n")
        self.assertEqual(meta, {})
        self.assertEqual(body, "Just a post.")

    def test_unterminated_front_matter_is_not_swallowed(self):
        meta, body = parse_front_matter("---\npublish_at: 2026-01-01\nstill going")
        self.assertEqual(meta, {})
        self.assertIn("still going", body)

    def test_body_colons_survive(self):
        _, body = parse_front_matter("---\nvisibility: PUBLIC\n---\nLaunch: the new range\n")
        self.assertEqual(body, "Launch: the new range")

    def test_quotes_are_stripped_from_values(self):
        meta, _ = parse_front_matter('---\nalt_text: "A bottle"\n---\nBody\n')
        self.assertEqual(meta["alt_text"], "A bottle")


class TimestampTests(unittest.TestCase):
    def test_z_suffix_is_utc(self):
        self.assertEqual(
            parse_timestamp("2026-01-01T09:00:00Z"), dt.datetime(2026, 1, 1, 9, tzinfo=UTC)
        )

    def test_naive_timestamp_assumed_utc(self):
        self.assertEqual(
            parse_timestamp("2026-01-01T09:00:00"), dt.datetime(2026, 1, 1, 9, tzinfo=UTC)
        )

    def test_explicit_offset_is_respected(self):
        self.assertEqual(
            parse_timestamp("2026-01-01T11:00:00+02:00"),
            dt.datetime(2026, 1, 1, 9, tzinfo=UTC),
        )


class DueTests(unittest.TestCase):
    def _post(self, publish_at: str | None) -> QueuedPost:
        meta = {"publish_at": publish_at} if publish_at else {}
        return QueuedPost(path=Path("x.md"), body="body", meta=meta)

    def test_past_timestamp_is_due(self):
        now = dt.datetime(2026, 6, 1, tzinfo=UTC)
        self.assertTrue(self._post("2026-01-01T00:00:00Z").is_due(now))

    def test_future_timestamp_is_not_due(self):
        now = dt.datetime(2026, 6, 1, tzinfo=UTC)
        self.assertFalse(self._post("2027-01-01T00:00:00Z").is_due(now))

    def test_missing_timestamp_is_due_immediately(self):
        self.assertTrue(self._post(None).is_due(dt.datetime(2026, 6, 1, tzinfo=UTC)))


class QueueDirectoryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def write(self, name: str, text: str) -> Path:
        path = self.dir / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_readme_and_drafts_are_skipped(self):
        self.write("README.md", "Docs for the queue")
        self.write("_draft.md", "Not ready")
        self.write("real.md", "---\npublish_at: 2026-01-01T00:00:00Z\n---\nShip it")

        loaded = load_queue(self.dir)
        self.assertEqual([p.path.name for p in loaded], ["real.md"])

    def test_ignored_helper(self):
        self.assertTrue(is_ignored(Path("README.md")))
        self.assertTrue(is_ignored(Path("_wip.md")))
        self.assertFalse(is_ignored(Path("launch.md")))

    def test_sorted_by_schedule_with_unscheduled_last(self):
        self.write("b.md", "---\npublish_at: 2026-03-01T00:00:00Z\n---\nSecond")
        self.write("a.md", "---\npublish_at: 2026-01-01T00:00:00Z\n---\nFirst")
        self.write("c.md", "No timestamp")

        self.assertEqual([p.body for p in load_queue(self.dir)], ["First", "Second", "No timestamp"])

    def test_due_posts_filters_by_time(self):
        self.write("past.md", "---\npublish_at: 2026-01-01T00:00:00Z\n---\nPast")
        self.write("future.md", "---\npublish_at: 2099-01-01T00:00:00Z\n---\nFuture")

        due = due_posts(dt.datetime(2026, 6, 1, tzinfo=UTC), self.dir)
        self.assertEqual([p.body for p in due], ["Past"])

    def test_empty_body_is_not_queued(self):
        self.write("blank.md", "---\npublish_at: 2026-01-01T00:00:00Z\n---\n\n")
        self.assertEqual(load_queue(self.dir), [])

    def test_archive_moves_file_and_records_urn(self):
        path = self.write("done.md", "---\npublish_at: 2026-01-01T00:00:00Z\n---\nPosted")
        post = load_queue(self.dir)[0]
        published = self.dir / "published"

        destination = archive(post, "urn:li:share:123", published)

        self.assertFalse(path.exists())
        self.assertTrue(destination.exists())
        self.assertIn("urn:li:share:123", destination.read_text())

    def test_archive_does_not_clobber_same_day_duplicates(self):
        published = self.dir / "published"
        for _ in range(2):
            self.write("same.md", "---\npublish_at: 2026-01-01T00:00:00Z\n---\nBody")
            archive(load_queue(self.dir)[0], "urn:li:share:1", published)

        self.assertEqual(len(list(published.glob("*.md"))), 2)


class PostKwargsTests(unittest.TestCase):
    def test_defaults_to_public(self):
        post = QueuedPost(path=Path("x.md"), body="b", meta={})
        self.assertEqual(post_kwargs(post), {"visibility": "PUBLIC"})

    def test_article_fields_pass_through(self):
        post = QueuedPost(
            path=Path("x.md"),
            body="b",
            meta={"article_url": "https://example.com", "article_title": "Hello"},
        )
        self.assertEqual(
            post_kwargs(post),
            {"visibility": "PUBLIC", "article_url": "https://example.com", "article_title": "Hello"},
        )


class AuthorUrnTests(unittest.TestCase):
    def test_absent_means_use_the_configured_default(self):
        post = QueuedPost(path=Path("x.md"), body="b", meta={})
        self.assertEqual(author_urn(post), "")

    def test_front_matter_overrides_the_default(self):
        post = QueuedPost(
            path=Path("x.md"), body="b", meta={"author_urn": "urn:li:organization:999"}
        )
        self.assertEqual(author_urn(post), "urn:li:organization:999")

    def test_surrounding_whitespace_is_ignored(self):
        post = QueuedPost(
            path=Path("x.md"), body="b", meta={"author_urn": "  urn:li:organization:999  "}
        )
        self.assertEqual(author_urn(post), "urn:li:organization:999")

    def test_parsed_from_a_file(self):
        text = (
            "---\n"
            "publish_at: 2026-09-21T07:00:00Z\n"
            "author_urn: urn:li:organization:42\n"
            "---\n"
            "Body"
        )
        meta, body = parse_front_matter(text)
        self.assertEqual(author_urn(QueuedPost(path=Path("x.md"), body=body, meta=meta)),
                         "urn:li:organization:42")

    def test_not_passed_to_create_post_as_a_kwarg(self):
        """It selects the client, so it must not leak into create_post()."""
        post = QueuedPost(
            path=Path("x.md"), body="b", meta={"author_urn": "urn:li:organization:999"}
        )
        self.assertNotIn("author_urn", post_kwargs(post))


class ProjectLayoutTests(unittest.TestCase):
    """Each brand is a project directory with its own queue, archive and defaults."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _project(self, name: str, conf: str | None = None) -> Path:
        queue = self.root / "projects" / name / "queue"
        queue.mkdir(parents=True)
        if conf is not None:
            (queue.parent / "project.conf").write_text(conf, encoding="utf-8")
        return queue

    def test_discovers_a_directory_with_a_queue(self):
        self._project("identical")
        found = queue_dirs(self.root / "projects")
        self.assertIn(self.root / "projects" / "identical" / "queue", found)

    def test_ignores_a_project_directory_with_no_queue(self):
        (self.root / "projects" / "notes").mkdir(parents=True)
        self.assertEqual(
            [d for d in queue_dirs(self.root / "projects") if "notes" in str(d)], []
        )

    def test_missing_projects_directory_is_not_an_error(self):
        queue_dirs(self.root / "nope")

    def test_conf_supplies_defaults(self):
        queue = self._project("identical", "profile: identical\nvisibility: PUBLIC\n")
        self.assertEqual(
            project_defaults(queue), {"profile": "identical", "visibility": "PUBLIC"}
        )

    def test_no_conf_means_no_defaults(self):
        self.assertEqual(project_defaults(self._project("bare")), {})

    def test_a_post_overrides_the_project_default(self):
        queue = self._project("identical", "profile: identical\n")
        (queue / "post.md").write_text(
            "---\nprofile: storeburst\n---\nBody", encoding="utf-8"
        )
        post = load_queue(queue)[0]
        self.assertEqual(post.meta["profile"], "storeburst")

    def test_a_post_inherits_the_project_default(self):
        queue = self._project("identical", "profile: identical\n")
        (queue / "post.md").write_text("---\nvisibility: PUBLIC\n---\nBody", encoding="utf-8")
        self.assertEqual(load_queue(queue)[0].meta["profile"], "identical")

    def test_archive_files_into_the_projects_own_published_dir(self):
        queue = self._project("identical")
        path = queue / "post.md"
        path.write_text("Body", encoding="utf-8")
        destination = archive(QueuedPost(path=path, body="Body", meta={}), "urn:li:share:1")
        self.assertEqual(destination.parent, queue.parent / "published")


if __name__ == "__main__":
    unittest.main()
