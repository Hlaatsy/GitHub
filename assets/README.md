# Campaign assets

Images referenced by this project's posts live here. `linkedin/queue.py`
resolves an `image:` front-matter path from the **repository root**, not from
the project, so a post refers to
`projects/identical/assets/identical-hero.png` even though the file sits
right next to this README.

A post that names an image which is not on disk raises `FileNotFoundError`
and stops the run, so the IDENTICAL posts in `content/queue/` ship with their
`image:` and `alt_text:` lines commented out. Generate the artwork, drop the
file in here, and uncomment both lines to attach it. Alt text is not optional
when you do — screen readers need it, and LinkedIn surfaces it.

## IDENTICAL — generation prompts

Source prompts for the launch artwork, kept here so a re-render matches the
set already published.

### `identical-hero.png` — hero / store screenshot

> Identical colourful 3D Pixar cartoon twin boys, perfectly identical faces,
> big joyful smiles, curly brown hair, blue eyes, wearing vibrant matching
> rainbow hoodies with orange overalls and colorful sneakers, standing
> together arm around shoulder, hyper realistic Pixar style, colorful paint
> splash background with comic pop art elements, balloons and art supplies,
> ultra vibrant, alive, energetic, premium app store hero image
> `--ar 9:16 --style raw`

The 9:16 ratio suits the App Store listing and Stories. For the LinkedIn feed,
re-render or crop to 1200x627 (link-preview ratio) or 1080x1080 — a tall image
gets cropped hard in-feed.

### App icon

> Two identical cartoon faces, Pixar style, colorful, cheerful twins icon,
> modern iOS app icon, white background, clean minimal

### Positioning line

> IDENTICAL app — your cartoon twin clone that talks, dances and creates
> videos for you — colorful, fun, premium

## Licensing note

Check the licence terms of whichever generator produces these before they go
out on a company page. Commercial use is a paid-tier right on most services,
and a LinkedIn company post is commercial use.
