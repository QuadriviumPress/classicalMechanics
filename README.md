# Essentials of Classical Mechanics — Web Edition

Eleventy build of **Essentials of Classical Mechanics** by Ryan D. Martin
(Queen's University), rendering the original LaTeX source to a searchable,
offline-capable web textbook.

- **Repository:** https://github.com/QuadriviumPress/ClassicalMechanics
- **Upstream source:** https://github.com/OSTP/ClassicalMechanics
- **License:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

## How it works

The author's LaTeX lives in [`tex/`](tex/) — **it is ground truth and is never
modified**. Everything else is build tooling:

```
tex/                    LaTeX source (ClassicalMech.tex + 17 chapter files + 58 figures)
lib/parse/              ClassicalMech.tex tokenizer (math protected first)
lib/model/              chapter/section/figure/equation numbering
lib/render/             blocks → HTML; math passes through to MathJax
_data/book.js           exposes the rendered book to Eleventy
pages.njk               paginates every section to its own page
scripts/                search index, verify-build integrity checks,
                        chapter PDF generation (Playwright)
assets/                 viewer JS, CSS, self-hosted MathJax v4 + MiniSearch
```

There is no figure-conversion step: every diagram in this book is a raster the
author committed next to the LaTeX, so `tex/figures/` is passed straight
through to `/figures/`.

## Developing

Requires Node ≥ 22. No TeX toolchain is needed to build the site.

```sh
npm ci
npm run update:vendor   # populate self-hosted MathJax + MiniSearch (once)
npm run build           # Eleventy → search index
npm run verify          # integrity checks over _site
npm run serve           # dev server at http://localhost:4000/ClassicalMechanics/
```

`npm run verify` is the gate: it fails on any build warning, any LaTeX
construct the renderer does not know, any unresolved cross-reference, any
broken internal link or dead fragment, any missing figure, and — via
`scripts/check-math.js` — on any control sequence MathJax cannot resolve or any
backslash command that leaked into prose.

## What the build reproduces

The master file drives the book. `\include{Chapter_X}` starts a chapter;
`\include{Chapter_X_Problems}` has no `\chapter` of its own, so (as in LaTeX)
its `\section{Problems}` belongs to the chapter before it. That gives 9
chapters and 59 pages.

Numbering mirrors the print book exactly — the `report` class plus the two
counters the master preamble defines:

| Thing | Format | Reset at |
|---|---|---|
| sections | `N.M` | chapter |
| figures, tables, equations | `N.k` | chapter |
| examples, problems | `N-k` (`\thechapter-\arabic{...}`) | chapter |

This is checked against the author's own `tex/ClassicalMech.pdf`: all **54
figure numbers**, **43 example numbers**, **63 problem numbers** and **373
equation numbers** agree with the printed text.

The 40 remaining printed equation numbers are the artefact of an align body
ending in a stray `\\`, which amsmath typesets as an empty *numbered* line. The
counter still advances here — otherwise every later equation in the chapter
would drift against the PDF — but the empty row is not rendered, so a web
reader sees a number skipped rather than a lone `(8.8)` on a blank line.

The author's `example` environment carries its prompt in argument 2 and a
figure float in argument 3; both are rendered inside the example box, ahead of
the worked solution. `solution` bodies are hidden in the printed book
(`\showproblemsolutions` is `false`) and are collapsed here behind a
Show/Hide control rather than dropped.

Two source files are not part of the book because the master does not
`\include` them: `tex/Summary.tex` (a standalone summary document) and
`tex/Appendix_DiffEqn.tex` (commented out in `ClassicalMech.tex`). They are
left untouched in the source tree.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`: build → verify →
chapter PDFs (Playwright) → rebuild with PDF download links → GitHub Pages.
Pull requests run the same build + verify via `ci.yml`.

## Attribution

Content © Ryan D. Martin, licensed under the Creative Commons
Attribution-ShareAlike 4.0 International license.

<a rel="license" href="http://creativecommons.org/licenses/by-sa/4.0/"><img alt="Creative Commons License" style="border-width:0" src="https://i.creativecommons.org/l/by-sa/4.0/88x31.png" /></a><br /><span xmlns:dct="http://purl.org/dc/terms/" href="http://purl.org/dc/dcmitype/Text" property="dct:title" rel="dct:type">Physics: The Art of Modelling</span> by <span xmlns:cc="http://creativecommons.org/ns#" property="cc:attributionName">Ryan D. Martin</span> is licensed under a <a rel="license" href="http://creativecommons.org/licenses/by-sa/4.0/">Creative Commons Attribution-ShareAlike 4.0 International License</a>.<br />Based on a work at <a xmlns:dct="http://purl.org/dc/terms/" href="https://github.com/OSTP/ClassicalMechanics" rel="dct:source">https://github.com/OSTP/ClassicalMechanics</a>.
