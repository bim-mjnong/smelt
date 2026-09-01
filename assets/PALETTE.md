# smelt — palette and marks

Every colour and every mark in this repo comes from one place: a **forge**. Charcoal
ground, iron mass, an ember mouth, a white-hot core. The Norse reading is _material_,
not typographic — there are no runic glyphs anywhere in these files, and there will not
be: sowilo (ᛋ) is doubled in the SS insignia and the valknut has been adopted by
white-supremacist groups. A shape built from material and geometry also ages better
than a glyph.

## Palette

| Token           | Hex       | What it is for                                                                  |
| --------------- | --------- | ------------------------------------------------------------------------------- |
| `charcoal`      | `#131417` | Ground. Dark surfaces, the icon plate, terminal-side backgrounds.               |
| `charcoal-lift` | `#1B1D22` | The lit corner of a charcoal gradient. Never used flat.                         |
| `iron`          | `#3F444C` | The mark's mass. Hearth bars, dividers on dark.                                 |
| `iron-dark`     | `#2A2E34` | The unlit bottom of iron. Gradient stop, hairline rules.                        |
| `iron-light`    | `#6E7783` | Keylines around iron, wordmark letters, muted text on either ground.            |
| `slag`          | `#9AA1AC` | Secondary prose on dark.                                                        |
| `ember`         | `#E4602F` | **The accent.** One accent, used as heat: the mouth, the flue, the bloom.       |
| `forge`         | `#F5893A` | Ember's lit edge. Gradient stop and hover state only — never a fill on its own. |
| `white-hot`     | `#FFF1D9` | The hottest 5% of any composition. Highlights, the core of the mouth.           |
| `ash`           | `#EFEBE5` | Type on charcoal; light-mode ground.                                            |

Two rules keep this from drifting:

1. **Ember is the only accent.** `forge` and `white-hot` are stops on the way to it, not
   alternatives to it. A second hue means the palette is being negotiated rather than
   used.
2. **White-hot is scarce.** It reads as heat because there is very little of it. Give it
   a large area and the whole thing turns into a candle.

Deliberately **not** RepoSkein's teal-and-amber (`#2DD4BF` / `#F2B84B`) — these are
sibling projects, and a reader should be able to tell two tabs apart at a glance. Ember
is red-orange; amber is yellow-orange. They do not collide.

## Files

| File                                       | Use                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `smelt-mark.svg`                           | The mark alone, 64×64, transparent. Works on light and dark grounds.                          |
| `smelt-wordmark.svg`                       | Mark + `SMELT` stencil letterforms, 380×120. Mid-tone letters so one file suits both themes.  |
| `smelt-icon.svg`                           | 512×512 square with a charcoal plate. The GitHub avatar.                                      |
| `smelt-social.svg`                         | 1280×640 social preview.                                                                      |
| `smelt-icon-512.png`, `smelt-icon-256.png` | Rasterised avatar, for the places GitHub wants a bitmap.                                      |
| `smelt-mark-128.png`                       | Small inline raster.                                                                          |
| `smelt-social-1280x640.png`                | **Upload this one** as the repository's social preview (Settings → General → Social preview). |

Everything is hand-authored SVG — no icon library, no tracing, no generator. The
letterforms in the wordmark are polygons rather than `<text>`, so they need no font
installed and render identically everywhere. The two prose lines in `smelt-social.svg`
_are_ `<text>` with a system font stack, which is exactly why the committed PNG is the
canonical artefact for that one.

The mark's geometry is duplicated in `smelt-mark.svg`, `smelt-wordmark.svg`,
`smelt-icon.svg` and `smelt-social.svg`, because each has to stand alone as a single
file. Change the furnace and you change four files. That is the trade for
self-containment; the alternative is a build step for four static images.

## Regenerating the PNGs

```sh
cd assets
rsvg-convert -w 512 -h 512 smelt-icon.svg   -o smelt-icon-512.png
rsvg-convert -w 256 -h 256 smelt-icon.svg   -o smelt-icon-256.png
rsvg-convert -w 128 -h 128 smelt-mark.svg   -o smelt-mark-128.png
rsvg-convert -w 1280 -h 640 smelt-social.svg -o smelt-social-1280x640.png
```

`rsvg-convert` comes from `librsvg` (`brew install librsvg`). Any renderer will do; the
sizes are what matter.
