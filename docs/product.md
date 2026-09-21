# IDENTICAL — product requirements for African markets

Internal. What the product must do to work across Sub-Saharan Africa rather
than being a Western tool with local prices bolted on.

Each item below says what depends on us and what depends on the underlying
platform. That distinction matters: if IDENTICAL sits on a third-party video
provider, several of these are **requests to that provider**, not sprints we
can schedule. Verify before any of them reach a marketing claim.

## 1. Code-mixing and slang comprehension

Most African speakers switch between English or French and an indigenous
language mid-sentence — Nigerian and Ghanaian Pidgin, Sheng in Kenya,
Tsotsitaal and everyday English-isiZulu mixing in South Africa.

The failure is specific and easy to reproduce: a sentence in one language
with words embedded from another. The engine hits the foreign word, either
mispronounces it with the wrong phoneme set or pauses before it, and the
whole clip sounds machine-made. That single artifact undoes the realism the
product is sold on.

**What to build:** a test set of real mixed sentences per market, recorded
from how people actually speak rather than written formally. Run it on every
voice and every engine change. Where the engine gets a word wrong
consistently, fix it with a pronunciation lexicon or SSML phoneme overrides
rather than waiting for the model.

**Dependency:** whether mixed-language input is handled at all is the
provider's, not ours. Establish what the platform supports today before
promising it. "Trained on mixed-language phrasing" is a claim that a single
bad clip disproves in public.

**Priority: high, and unglamorous.** This is the difference between an avatar
that sounds like the customer and one that sounds like a foreign call centre.

## 2. Regional visual avatars

Ethnically accurate presets with natural hair textures — 4C, braids, locs,
fades, head wraps — and clothing that reflects the room the viewer is in:
modern African corporate and casual, plus traditional dress where it fits
(Ankara, Kente, Dashiki, shweshwe).

A library of generic Western corporate wear tells every African user this
product was not made for them, before they have evaluated anything else.

**What to build:** commission presets per region rather than filtering an
existing library, which will not contain them. Photo-to-avatar (Avatar 4)
sidesteps the problem for anyone using their own face, so presets matter most
for users who do not want to appear themselves — which is a large share of
business use.

**Get consent right.** Every preset built from a real person needs a model
release covering synthetic reuse. This is the same likeness question the
compliance pillar sells, applied to our own library. Getting it wrong in our
own product while selling consent expertise would be indefensible.

## 3. WhatsApp and audio-first pipeline

Record a voice note, send it to a number, get a finished avatar video back.

This is the highest-leverage item on the list. In most of these markets
WhatsApp is not one channel among several — it is where business is
conducted. A pipeline that never requires opening an app, learning an
interface or having storage free for a download reaches people no web
onboarding will.

    voice note in -> transcribe -> script -> render -> video out, in thread

**What to build:** WhatsApp Business Platform (Cloud API) via Meta or a
provider such as Twilio or a local BSP. Budget per-conversation messaging
fees into the unit economics — this channel has a marginal cost per user
that the web app does not.

**Hard constraint that shapes everything downstream:** WhatsApp caps media at
**16MB** on most clients. A video that exceeds it does not get sent. That,
not aesthetics, is where the 10-15MB target in section 4 comes from.

**Also decide:** how a user pays inside a WhatsApp flow when they have no
card. See the payment rails section in `monetisation.md` — mobile money is
the answer, and it has to work without leaving the thread.

## 4. Bandwidth-optimised rendering

Target under 10-15MB per clip so a video sends instantly on mobile data and
does not cost the recipient a meaningful share of a bundle to receive.

**Decided: H.264, not HEVC or WebM.** The original brief suggested H.265 or
WebM presets. In practice:

- **WhatsApp re-encodes video on send anyway**, so an exotic codec buys
  nothing and risks a file the app refuses or mangles.
- **WebM/VP9 is not reliably playable** on iOS or inside WhatsApp. It is a
  web codec, not a sharing codec.
- **H.265 support varies** by device and carries licensing considerations.

**The sharing default is H.264 (main profile) + AAC, 720p, capped around
1.5-2 Mbps**, which lands near 10-15MB per minute and plays everywhere with
no exceptions. 1080p is a paid-tier export for users posting to
desktop-viewed platforms; the default stays 720p.

Note how this interacts with pricing: a 2-minute cap at this bitrate is
roughly 20-30MB at source, which needs to come down to under 16MB to pass
through WhatsApp. Budget for a second, smaller encode of every video
specifically for sharing, rather than assuming one file serves both.

The goal is a file that sends first time on a weak connection. Universality
beats compression efficiency at these file sizes.

## 5. Automated multilingual subtitles

Auto-synced captions, because social video is watched muted.

**Decided: burned in by default.** TikTok, Instagram and WhatsApp do not read
a sidecar `.srt` file, so a separate subtitle track is invisible exactly where
it is needed. Captions render into the frame; the `.srt` is an extra download
for platforms that do use it, such as YouTube.

Generate in the spoken language and in English or French, since a mixed
audience reads one or the other. Caption quality on mixed-language speech
depends on the same engine as section 1, so the two succeed or fail together
— budget them as one piece of work, not two.

## Build order

South Africa is the first and only market until this list is substantially
done — that is a decision, recorded in `../queue/_campaign.md`. The items
below are what turn the other markets from intention into something you can
invoice, so treat the sequence as the market-entry plan, not a wishlist.

Sequenced by what unlocks revenue rather than what is most interesting:

1. **Bandwidth-optimised rendering.** Cheapest, unblocks everything that
   involves sharing, and is entirely within our control.
2. **Burned-in subtitles.** Small, high perceived value, no dependency.
3. **WhatsApp pipeline, with mobile money inside it.** The distribution
   unlock, and the thing that makes Kenya and Ghana reachable at all. Start
   it early: the Business Platform has an approval process, like every other
   approval on this project, and the payment integration behind it is its
   own piece of work.
4. **Regional avatar presets.** Commissioned work, so it runs in parallel
   rather than blocking.
5. **Code-mixing quality.** Continuous, and gated on what the platform
   supports. Begin the test set now regardless — it costs nothing and tells
   you what you can honestly claim.

## What not to claim yet

Nothing in this document should appear in a LinkedIn post until it works on
the actual device of the actual market. Sections 1 and 2 in particular are
easy to write and hard to deliver, and both fail publicly and instantly: an
avatar that mispronounces a common word, or a library with no hair texture
that matches the user.

The campaign copy in `../queue/` currently claims local language quality on
that basis and no more. Keep it there until the test set says otherwise.
