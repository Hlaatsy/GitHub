# Post queue

One markdown file per post. `publish` picks up everything whose `publish_at`
has passed, publishes it, then moves the file to `content/published/`.

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

Use `article_url` (and optionally `article_title`) instead of `image` to share
a link with a preview card.
