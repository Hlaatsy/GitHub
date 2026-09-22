"""Sign-off before a video leaves the building.

Mostly about what must not work, because the value of an approval step is
entirely in what it refuses.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import approvals, auth, teams  # noqa: E402
from app.db import connect, now  # noqa: E402


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.owner_id = self.user("owner@co.za")
        self.org_id = teams.create_organisation(self.conn, self.owner_id, "Sandton Mutual")
        self.conn.execute(
            "UPDATE organisations SET plan = 'team5', require_approval = 1 WHERE id = ?",
            (self.org_id,))
        self.avatar_id = self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (?, 'Presenter', 'upload', ?)", (self.org_id, now()),
        ).lastrowid
        self.conn.commit()

    def user(self, email):
        return auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, email))

    def org(self):
        return self.conn.execute("SELECT * FROM organisations WHERE id = ?",
                                 (self.org_id,)).fetchone()

    def owner(self):
        return teams.membership(self.conn, self.owner_id)

    def colleague(self):
        token = teams.invite(self.conn, self.org(), self.owner(), "pr@co.za")
        user_id = self.user("pr@co.za")
        teams.accept(self.conn, token, user_id)
        return user_id, teams.membership(self.conn, user_id)

    def video(self, by=None, title="Premium change"):
        video_id = self.conn.execute(
            "INSERT INTO videos (org_id, avatar_id, created_by, title, script, seconds,"
            " status, approval, created_at)"
            " VALUES (?, ?, ?, ?, 's', 30, 'ready', ?, ?)",
            (self.org_id, self.avatar_id, by or self.owner_id, title,
             approvals.initial_state(self.org()), now()),
        ).lastrowid
        self.conn.commit()
        return self.conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()

    def reload(self, video):
        return self.conn.execute("SELECT * FROM videos WHERE id = ?",
                                 (video["id"],)).fetchone()

    # -- the gate ---------------------------------------------------------

    def test_a_new_video_waits_when_approval_is_required(self):
        self.assertEqual(self.video()["approval"], approvals.PENDING)

    def test_a_waiting_video_cannot_be_shared(self):
        """Finished is not the same as cleared to leave the building."""
        self.assertFalse(approvals.publishable(self.video()))

    def test_approval_releases_it(self):
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video, approvals.APPROVED)
        self.assertTrue(approvals.publishable(self.reload(video)))

    def test_organisations_without_approval_are_unaffected(self):
        self.conn.execute("UPDATE organisations SET require_approval = 0 WHERE id = ?",
                          (self.org_id,))
        self.conn.commit()
        video = self.video()
        self.assertEqual(video["approval"], approvals.NOT_REQUIRED)
        self.assertTrue(approvals.publishable(video))

    # -- who may decide ---------------------------------------------------

    def test_a_member_cannot_approve(self):
        _, member = self.colleague()
        with self.assertRaises(approvals.NotPermitted):
            approvals.decide(self.conn, self.org(), member, self.video(),
                             approvals.APPROVED)

    def test_an_owner_may_clear_their_own_work_by_default(self):
        """In a small team the writer is often the accountable person."""
        video = self.video(by=self.owner_id)
        approvals.decide(self.conn, self.org(), self.owner(), video, approvals.APPROVED)
        self.assertEqual(self.reload(video)["approval"], approvals.APPROVED)

    def test_four_eyes_stops_anyone_clearing_their_own_work(self):
        self.conn.execute("UPDATE organisations SET four_eyes = 1 WHERE id = ?",
                          (self.org_id,))
        self.conn.commit()
        video = self.video(by=self.owner_id)
        with self.assertRaises(approvals.NotPermitted):
            approvals.decide(self.conn, self.org(), self.owner(), video,
                             approvals.APPROVED)

    def test_four_eyes_still_allows_clearing_somebody_elses(self):
        self.conn.execute("UPDATE organisations SET four_eyes = 1 WHERE id = ?",
                          (self.org_id,))
        self.conn.commit()
        colleague_id, _ = self.colleague()
        video = self.video(by=colleague_id)
        approvals.decide(self.conn, self.org(), self.owner(), video, approvals.APPROVED)
        self.assertEqual(self.reload(video)["approval"], approvals.APPROVED)

    # -- rejection --------------------------------------------------------

    def test_a_rejection_needs_a_reason(self):
        """Rejecting without one sends somebody back to a blank page."""
        with self.assertRaises(approvals.NotPending):
            approvals.decide(self.conn, self.org(), self.owner(), self.video(),
                             approvals.REJECTED)

    def test_a_rejected_video_stays_unpublishable(self):
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video,
                         approvals.REJECTED, "The premium figure is wrong.")
        self.assertFalse(approvals.publishable(self.reload(video)))

    def test_a_rejected_video_can_go_back_in_the_queue(self):
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video,
                         approvals.REJECTED, "Wrong figure.")
        approvals.resubmit(self.conn, self.org(), self.reload(video))
        self.assertEqual(self.reload(video)["approval"], approvals.PENDING)

    def test_an_approved_video_cannot_be_resubmitted(self):
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video, approvals.APPROVED)
        with self.assertRaises(approvals.NotPending):
            approvals.resubmit(self.conn, self.org(), self.reload(video))

    def test_deciding_twice_is_refused(self):
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video, approvals.APPROVED)
        with self.assertRaises(approvals.NotPending):
            approvals.decide(self.conn, self.org(), self.owner(), self.reload(video),
                             approvals.REJECTED, "changed my mind")

    # -- the record -------------------------------------------------------

    def test_the_decision_names_the_person(self):
        """'Somebody approved it' is only an answer if it names them."""
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video, approvals.APPROVED)
        record = approvals.history(self.conn, video["id"])[0]
        self.assertEqual(record["decided_by"], self.owner_id)
        self.assertEqual(record["decision"], approvals.APPROVED)
        self.assertTrue(record["created_at"])

    def test_the_rejection_reason_is_kept(self):
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video,
                         approvals.REJECTED, "The premium figure is wrong.")
        self.assertIn("premium figure", approvals.history(self.conn, video["id"])[0]["note"])

    def test_history_survives_a_later_decision(self):
        """The record is append-only: a rejection is not erased by approval."""
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video,
                         approvals.REJECTED, "Wrong figure.")
        approvals.resubmit(self.conn, self.org(), self.reload(video))
        approvals.decide(self.conn, self.org(), self.owner(), self.reload(video),
                         approvals.APPROVED)
        decisions = [r["decision"] for r in approvals.history(self.conn, video["id"])]
        self.assertEqual(decisions, [approvals.APPROVED, approvals.REJECTED])

    def test_the_queue_is_oldest_first(self):
        first, second = self.video(title="First"), self.video(title="Second")
        titles = [v["title"] for v in approvals.waiting(self.conn, self.org_id)]
        self.assertEqual(titles, ["First", "Second"])

    def test_decided_videos_leave_the_queue(self):
        video = self.video()
        approvals.decide(self.conn, self.org(), self.owner(), video, approvals.APPROVED)
        self.assertEqual(approvals.waiting(self.conn, self.org_id), [])


if __name__ == "__main__":
    unittest.main()
