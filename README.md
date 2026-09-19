# IDENTICAL

AI clone video maker. Own brand, own LinkedIn page, own app — separate from
KhutsoGRC and StoreBurst, which are separate projects with separate apps.

This directory is the whole project. Nothing here is shared with the other
brands except the publisher itself (`linkedin/`, at the repository root).

    projects/identical/
      project.conf    defaults for every post here (profile: identical)
      queue/          posts waiting to publish
      published/      posts after they have gone out, with their URNs
      assets/         artwork, and the prompts that generated it
      docs/           positioning and revenue model

## Status

Pre-launch. Six posts scheduled from 21 September, four offer posts held as
drafts pending confirmed pricing. Two things are unresolved and both are in
`queue/_campaign.md`: the app's Community Management API approval, and the
fact that a new page has no followers to publish to.

## The three apps

IDENTICAL publishes through its own LinkedIn app, selected by
`profile: identical` in `project.conf`. Credentials never fall back to
another brand's, so a missing token fails this project's posts and leaves
the other projects publishing normally.

    python -m linkedin profiles                      # all brands, what is missing
    python -m linkedin.auth --profile identical      # mint this app's token
    python -m linkedin --profile identical pages     # confirm page access

Setup is in `linkedin/README.md` under "Three separate apps".

## Working on this project

- **Posts** go in `queue/` as markdown with front matter. Format is in
  `content/queue/README.md`. A file starting with `_` is a draft and is never
  published — that is how the offer posts are held back.
- **The profile is set once** in `project.conf`, so a new post cannot publish
  as the wrong brand by forgetting a line.
- **Image paths resolve from the repository root**, not from here:
  `projects/identical/assets/whatever.png`. See `assets/README.md`.
- **Prices** are proposals until confirmed — see `docs/monetisation.md`. The
  offer drafts carry them in public copy and stay underscore-prefixed until
  the numbers are yours.

## Reading order

1. `queue/_campaign.md` — what is scheduled, what is blocking, what to do
   before the launch date.
2. `docs/positioning.md` — why the copy says what it says.
3. `docs/monetisation.md` — the revenue model behind the offer posts.

## If this outgrows the repo

It is a self-contained project sharing one publisher. If IDENTICAL ends up
with its own site, app releases or CI, move this directory into its own
repository and take `linkedin/` with it as a dependency — nothing here
reaches into the other projects, so the split is a `git mv` rather than an
untangling. Worth doing before that is true, not after.
