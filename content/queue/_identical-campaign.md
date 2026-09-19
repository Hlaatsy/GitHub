# IDENTICAL launch campaign

A draft note, not a post: `linkedin/queue.py` skips files starting with `_`.

Six posts for the KhutsoGRC page introducing IDENTICAL, the AI clone video
maker. Spaced across weekday mornings so the launch reads as a sequence rather
than a single burst, all at 07:00 UTC (09:00 SAST) inside the workflow's
05:00-15:00 UTC cron window.

| Date | File | Angle |
| --- | --- | --- |
| Mon 21 Sep | `identical-01-launch.md` | Launch announcement, who it is for |
| Wed 23 Sep | `identical-02-how-it-works.md` | The four-step workflow |
| Fri 25 Sep | `identical-03-ios-2.md` | iOS 2.0: Shortcuts and Video Agent |
| Tue 29 Sep | `identical-04-avatar-4.md` | Avatar 4, and the three ways to build a twin |
| Thu 01 Oct | `identical-05-translation.md` | Translation, highlights, repurposing |
| Tue 06 Oct | `identical-06-who-its-for.md` | Use cases and closing call to action |

Every date falls inside the run window that ends 2026-11-18, so the schedule
covers the campaign without needing to be extended.

## Before these go live

- **Add the store link.** Each file carries a commented-out `article_url`
  line. Fill it in on at least the first and last post once the App Store
  listing is public — a launch post with nowhere to click is a wasted one.
  `article_url` and `image` are mutually exclusive: a post gets a link preview
  card or an image, not both.
- **Attach artwork.** See `assets/README.md`. Uncomment `image` and `alt_text`
  together, only once the file is actually on disk.
- **Terms and privacy.** The listing points at <https://www.heygen.com/terms>
  and <https://www.heygen.com/policy>. If IDENTICAL is published under a
  different entity than the one making these claims on the page, say so in the
  post copy rather than leaving it implied.
- **Check the claims.** "100+ languages", "thousands of pre-made avatars" and
  the Avatar 4 description are taken from the store listing. If the listing
  changes, these posts should change with it.

## Dry run

    python -m linkedin queue              # confirms order and dates
    python -m linkedin publish --dry-run  # confirms nothing is due yet
