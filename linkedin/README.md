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
