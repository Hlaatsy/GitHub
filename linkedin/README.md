# LinkedIn publishing

Posts to LinkedIn through their official REST API. Standard library only --
no `pip install` needed.

## Why it works this way

LinkedIn has no public API for reading your feed, your connections, or other
people's profiles, and their User Agreement prohibits automated browsing or
scraping. Writing, though, is supported: an approved app can publish on
behalf of a member (`w_member_social`) or a company page it administers
(`w_organization_social`). That is what this does.

LinkedIn also has no scheduled-post endpoint -- posts publish the moment you
call the API. So "scheduling" here is a queue of markdown files plus a job
that publishes whatever is due. See `content/queue/README.md`.

## One publisher, several projects

Each brand is a project with its own queue, archive, assets and defaults:

    content/queue/                  KhutsoGRC (the original layout)
    projects/identical/             IDENTICAL

`publish` reads every project's queue. A project names its LinkedIn app once
in `project.conf`, so a post cannot publish as the wrong brand by omitting a
line, and each project archives into its own `published/`.

Adding a brand is adding a directory with a `queue/` in it -- no code change.
`projects/identical/README.md` is the worked example.

## Where this fits in TaxSorted

The site's **Social Post Generator** (`#social` in `index.html`) writes
captions in the browser and hands them to you on the clipboard. This package
is the other half: it takes caption text and actually publishes it.

The handoff is manual by design. TaxSorted is a static site, so the generator
runs entirely in the visitor's browser -- it cannot call the LinkedIn API
itself. An access token in client-side JavaScript would be readable by anyone
who opened the page, and LinkedIn's API rejects browser-origin calls anyway.
Publishing therefore happens server-side, from GitHub Actions:

    generator -> caption text -> content/queue/*.md -> Actions -> LinkedIn

So the site stays a static site with no secrets in it, and the token lives
only in repository secrets.

## Target page

Posts publish to the **KhutsoGRC** company page:

    https://www.linkedin.com/company/145207663/admin/
    -> urn:li:organization:145207663

That numeric ID in the admin URL is the organization ID, and it is already
set as `LINKEDIN_AUTHOR_URN` in `.env.example`. Confirm it against LinkedIn
with `python -m linkedin pages` once you have a token. Leaving the variable
unset posts as *you personally* instead of the page -- so do not unset it by
accident.

## Three separate apps

KhutsoGRC, StoreBurst and IDENTICAL are three different LinkedIn apps, not
one app posting to three pages. LinkedIn ties an app to one associated page:
verification is done by an admin of *that* page, and Community Management API
approval is granted to *that* app. So each brand needs its own app, and each
app carries its own approval, its own token and its own 60-day expiry clock.

That separation is the point. One brand's token being revoked, expiring or
failing review does not touch the other two.

| Brand | Profile | Variables |
| --- | --- | --- |
| KhutsoGRC | *(default)* | `LINKEDIN_*` |
| StoreBurst | `storeburst` | `LINKEDIN_STOREBURST_*` |
| IDENTICAL | `identical` | `LINKEDIN_IDENTICAL_*` |

KhutsoGRC stays the unnamed default so the existing `.env` and repository
secrets keep working unchanged.

### Setting up an app

Run this once per brand, for StoreBurst and IDENTICAL:

1. Create an app at <https://www.linkedin.com/developers/apps>, associated
   with **that brand's** page.
2. Verify it -- an admin of that page opens the verification URL.
3. Request the **Community Management API** on the Products tab. This is the
   long pole: a review, not a checkbox, granted per app. A new app starts it
   from zero.
4. Add `http://localhost:8765/callback` as an authorized redirect URL.
5. Fill that brand's block in `.env`.
6. `python -m linkedin.auth --profile <name>`
7. `python -m linkedin --profile <name> pages` -- the brand's page should be
   listed.

Add each brand's `ACCESS_TOKEN`, `AUTHOR_URN` and `TOKEN_EXPIRES_AT` as
repository secrets; the workflow already passes all three sets.

### Checking all three

    python -m linkedin profiles

Prints every configured brand with its token state, page, days to expiry and
how many queued posts belong to it -- then lists any post naming a profile
that has no configuration at all. Run it before a launch date. Three apps
means three ways to be almost ready.

### While approval is pending

Steps 1-2 and 4-6 work immediately; only page-posting waits on review. Set
that brand's `SCOPES` to `openid profile w_member_social` and leave its
`AUTHOR_URN` empty to post as yourself while testing.

If approval will not land before a scheduled post, move the dates rather
than publishing from another brand's app. The separation is worth more than
the date.

### How a post picks an app

`profile: <name>` in front matter. It reads that app's credentials and
**never falls back** to another profile's token -- a missing
`LINKEDIN_<NAME>_ACCESS_TOKEN` fails those posts, names the variable, and
leaves the rest of the queue publishing normally. `author_urn` overrides the
page within a profile, for an app that administers several pages.

Each brand's token expires on its own clock:

    python -m linkedin token                        # KhutsoGRC
    python -m linkedin --profile storeburst token
    python -m linkedin --profile identical token

### Publishing to more than one page

`LINKEDIN_AUTHOR_URN` is the default, not the only option. A queued post can
name its own page in front matter:

    author_urn: urn:li:organization:123456

The IDENTICAL campaign in `content/queue/` uses this: it launches under
**StoreBurst**, not KhutsoGRC, so every one of its posts names the StoreBurst
page explicitly rather than inheriting the default.

Two things follow from that, and both matter:

- **The token must be allowed to post as that page.** A page ID alone is not
  access. The app has to be associated with the StoreBurst page and the
  authorising account must administer it, or the post fails with a 403.
  `python -m linkedin pages` lists which pages the current token may act for
  -- check StoreBurst appears there before the first scheduled post.
- **An unreadable `author_urn` fails the post rather than falling back.**
  That is deliberate. Silently publishing a brand's launch to a different
  company page is worse than a red build.

`python -m linkedin queue` prints the destination page under every queued
post, and `publish --dry-run` does the same, so a misrouted post is visible
before it publishes rather than after.

## One-time setup

Posting as a company page is a higher bar than posting as yourself. Steps 3
and 4 are the ones that can hold you up.

1. Create an app at <https://www.linkedin.com/developers/apps>. On the
   **Settings** tab, associate it with the KhutsoGRC page (ID 145207663) --
   it must be this page, not a different one.
2. **Verify the app.** LinkedIn generates a verification URL on the Settings
   tab; a page admin of KhutsoGRC opens it and confirms. Nothing works until
   this is done.
3. On the **Products** tab, request the **Community Management API**. This
   grants `w_organization_social` (post as the page) and
   `rw_organization_admin` (read which pages you administer). It is a review
   by LinkedIn, not a checkbox -- allow time, and expect questions about what
   the app does.
4. On the **Auth** tab, add `http://localhost:8765/callback` as an authorized
   redirect URL, and copy the client ID and secret.
5. `cp .env.example .env` and fill in the ID and secret.
6. `python -m linkedin.auth` -- authorize in the browser, paste the printed
   token into `.env`.
7. `python -m linkedin pages` -- KhutsoGRC should be listed and starred.
   `python -m linkedin whoami` confirms what posts will publish as.

### Before approval comes through

Steps 1-2 and 4-6 work immediately; only the page-posting scope waits on
review. To test the pipeline meanwhile, switch `.env` to the member-only
line (`LINKEDIN_SCOPES=openid profile w_member_social`), comment out
`LINKEDIN_AUTHOR_URN`, and re-run `python -m linkedin.auth`. Posts then go
to your own profile -- useful for checking formatting and the queue, not for
anything you want on the page.

If approval is refused or takes too long, page admins can schedule posts
natively from the KhutsoGRC page composer at no cost and with no API.

## Usage

```bash
python -m linkedin whoami                    # who the token belongs to
python -m linkedin post "Hello LinkedIn"     # publish right now
python -m linkedin post "Look" --image assets/launch.png --alt-text "A bottle"
python -m linkedin queue                     # what is scheduled
python -m linkedin publish --dry-run         # what would go out now
python -m linkedin publish                   # publish everything due
```

`post` and `publish` both publish as whatever `LINKEDIN_AUTHOR_URN` points
at -- the KhutsoGRC page by default. `python -m linkedin pages` shows which
pages the token may act for.

## Scheduling in CI

`.github/workflows/linkedin-publish.yml` runs `publish` hourly and commits
the archived files back. Add both `LINKEDIN_ACCESS_TOKEN` and
`LINKEDIN_AUTHOR_URN` (`urn:li:organization:145207663`) as repository secrets
under Settings -> Secrets and variables -> Actions. Without the URN secret the
CI job would publish to a personal profile rather than the page.

## Run window

The schedule is set to run for 60 days, to 2026-11-18 -- roughly one token
lifetime -- and then pause for review rather than continuing unattended.

    LINKEDIN_SCHEDULE_ENDS_AT=2026-11-18T00:00:00Z

Past that date `publish` prints a notice and exits cleanly without posting,
so the Actions log goes quiet instead of red. `python -m linkedin token`
shows how much of the window is left. To carry on, move the date forward or
delete the line; in CI it is a repository *variable*, not a secret, so it can
be edited without re-entering the token.

## Token expiry

Access tokens last about 60 days, so the schedule runs only as long as the
current token does. `python -m linkedin.auth` prints a
`LINKEDIN_TOKEN_EXPIRES_AT` line alongside the token -- keep both in `.env`
(and as repository secrets) and the tooling can warn you before posts start
failing rather than after.

    python -m linkedin token     # days remaining

`publish` prints the same warning inside the notice window, so it shows up in
the Actions log too. To renew, re-run `python -m linkedin.auth` and update
both values. Refresh tokens are only issued to apps LinkedIn has approved
for them.

## API versioning

Requests send a `LinkedIn-Version` header (`202505` by default). LinkedIn
retires versions after about a year; a `426 Upgrade Required` means bump
`LINKEDIN_VERSION` to a current month.

## Tests

```bash
python -m unittest discover -s tests
```
