# LinkedIn publishing

Posts to LinkedIn through their official REST API. Standard library only --
no `pip install` needed.

## Why it works this way

LinkedIn has no public API for reading your feed, your connections, or other
people's profiles, and their User Agreement prohibits automated browsing or
scraping. Writing, though, is supported: the `w_member_social` scope lets an
approved app publish on your behalf. That is what this does.

LinkedIn also has no scheduled-post endpoint -- posts publish the moment you
call the API. So "scheduling" here is a queue of markdown files plus a job
that publishes whatever is due. See `content/queue/README.md`.

## One-time setup

1. Create an app at <https://www.linkedin.com/developers/apps>, associated
   with a LinkedIn Page you administer.
2. On the **Products** tab, request:
   - *Sign In with LinkedIn using OpenID Connect* -- self-serve
   - *Share on LinkedIn* -- self-serve, gives `w_member_social`
   - *Community Management API* -- only if you need to post as the company
     page rather than as yourself. This one requires LinkedIn's review.
3. On the **Auth** tab, add `http://localhost:8765/callback` as an authorized
   redirect URL, and copy the client ID and secret.
4. `cp .env.example .env` and fill in the ID and secret.
5. `python -m linkedin.auth` -- this opens LinkedIn in your browser, catches
   the redirect, and prints an access token. Paste it into `.env`.
6. `python -m linkedin whoami` to confirm it works.

## Usage

```bash
python -m linkedin whoami                    # who the token belongs to
python -m linkedin post "Hello LinkedIn"     # publish right now
python -m linkedin post "Look" --image assets/launch.png --alt-text "A bottle"
python -m linkedin queue                     # what is scheduled
python -m linkedin publish --dry-run         # what would go out now
python -m linkedin publish                   # publish everything due
```

Posting as a company page: set `LINKEDIN_AUTHOR_URN=urn:li:organization:12345678`.
Your organization ID is in the URL when you view the page's admin view.

## Scheduling in CI

`.github/workflows/linkedin-publish.yml` runs `publish` hourly and commits
the archived files back. Add `LINKEDIN_ACCESS_TOKEN` as a repository secret
(Settings -> Secrets and variables -> Actions). Add `LINKEDIN_AUTHOR_URN` too
if posting as a page.

## Token expiry

Access tokens last about 60 days. When posting starts failing with a 401,
re-run `python -m linkedin.auth` and update `.env` and the repository secret.
Refresh tokens are only issued to apps LinkedIn has approved for them.

## API versioning

Requests send a `LinkedIn-Version` header (`202505` by default). LinkedIn
retires versions after about a year; a `426 Upgrade Required` means bump
`LINKEDIN_VERSION` to a current month.

## Tests

```bash
python -m unittest discover -s tests
```
