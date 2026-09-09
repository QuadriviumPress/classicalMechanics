// MathJax configuration for the rendered book.
//
// `macros` mirrors the author's preamble in tex/ClassicalMech.tex — the two
// \newcommand definitions (\die, \lagd) plus anything the text uses that
// MathJax does not ship. MathJax only knows what is listed here: anything
// missing reaches the reader as red LaTeX source rather than math.
// scripts/check-math.js typesets the built HTML with this exact file and fails
// the build on any control sequence MathJax cannot resolve — so when the
// upstream preamble grows a macro, add it here too.

// MathJax resolves fonts against loader.paths.fonts, which defaults to the
// jsdelivr CDN. npm run update:vendor copies the newcm font next to the
// MathJax bundle, so point the loader there: a blocked or offline CDN
// otherwise aborts typesetting for the whole page and every equation on it
// falls back to raw LaTeX source. Derived from this script's own URL, since
// GitHub Pages serves the site under a path prefix and Vercel does not.
var MATHJAX_ASSETS = (function () {
  var self = typeof document !== 'undefined' && document.currentScript;
  return self ? new URL('.', self.src).href : '';
})();

MathJax = {
  loader: {
    load: ['[tex]/ams', '[tex]/textmacros'],
    paths: { fonts: MATHJAX_ASSETS + 'mathjax/fonts' },
  },
  options: {
    ignoreHtmlClass: 'mathjax-skip',
    enableMenu: true,
    menuOptions: {
      settings: {
        enrich: true,
        speech: true,
        braille: true,
        help: true,
        inTabOrder: true,
        assistiveMml: false,
      },
    },
    a11y: {
      subtitles: true,
      viewBraille: false,
      voicing: false,
    },
  },
  tex: {
    packages: { '[+]': ['ams', 'textmacros'] },
    inlineMath: [
      ['$', '$'],
      ['\\(', '\\)'],
    ],
    displayMath: [
      ['$$', '$$'],
      ['\\[', '\\]'],
    ],
    processEscapes: true,
    processEnvironments: true,
    tags: 'none',
    macros: {
      // --- ClassicalMech.tex preamble -------------------------------------
      die: ['\\frac{\\partial #1}{\\partial #2}', 2],
      lagd: '\\mathcal{L}',

      // --- package commands MathJax does not ship --------------------------
      bm: ['\\boldsymbol{#1}', 1], // bm
      thickspace: '\\;',
    },
  },
  chtml: {
    displayOverflow: 'overflow',
    scale: 1.0,
    minScale: 0.5,
  },
};
