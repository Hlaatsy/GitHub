# Post queue

One markdown file per post. `publish` picks up everything whose `publish_at`
has passed, publishes it, then moves the file to the `published/` directory
beside its queue.

This queue is **KhutsoGRC's**. Other brands are separate projects with their
own queues, archives and defaults:

    content/queue/                  KhutsoGRC
    projects/identical/queue/       IDENTICAL

`publish` reads all of them. A project sets its LinkedIn app once in
`project.conf` beside its queue, and a post's own front matter overrides it.
The format below is the same wherever the file lives.

```markdown
---
publish_at: 2026-09-20T09:00:00Z
visibility: PUBLIC
image: assets/launch.png
alt_text: Describe the image for screen readers
---
Everything below the front matter becomes the post text.
```

All fields are optional. A file with no `publish_at` goes out on the next run.
Times are UTC unless you give an explicit offset.

Add `author_urn: urn:li:organization:123456` to publish that post as a
specific company page instead of the one `LINKEDIN_AUTHOR_URN` points at --
that is how one queue serves several brands. The token must administer the
page, and a value that cannot be read fails the post rather than quietly
using the default. Front matter has no inline comments, so keep the value
alone on its line.

Use `article_url` (and optionally `article_title`) instead of `image` to share
a link with a preview card.
