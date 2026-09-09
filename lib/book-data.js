// buildBook(): parse → tokenize → annotate → render orchestration.
//
//   parse/book.js        ClassicalMech.tex → chapters/sections
//   model/numbering.js   page URLs + print-style numbers
//   parse/tokenizer.js   each chapter intro / section body → blocks
//   model/content.js     figure/table/equation/example/problem numbers, anchors
//   render/transform.js  blocks → HTML
//
// A build report (warnings, unknown LaTeX constructs) is written to
// generated/build-report.json; verify-build.js fails CI on regressions.
import fs from 'node:fs';
import path from 'node:path';
import { parseBook } from './parse/book.js';
import { tokenize, protectMath } from './parse/tokenizer.js';
import { buildModel } from './model/numbering.js';
import { annotateContent } from './model/content.js';
import { renderBlocks, renderAssetImg } from './render/transform.js';
import { renderInline, escapeHtml, finalizeMathSpans } from './render/inline.js';
import { resolveFigureFile } from './figures.js';

const BOOK_TITLE = 'Essentials of Classical Mechanics';

function sectionListHtml(chapter) {
  if (chapter.sections.length === 0) return '';
  const items = chapter.sections
    .map(s => `<li><a href="${s.url}">${escapeHtml(s.displayTitle)}</a></li>`)
    .join('\n');
  return `<nav class="chapter-sections" aria-label="Sections">\n<ul>\n${items}\n</ul>\n</nav>`;
}

/** /print/<slug>/ page name and downloadable PDF name for a chapter. */
function printNames(chapter) {
  const key =
    chapter.mode === 'appendix'
      ? `appendix-${chapter.number.toLowerCase()}`
      : `chapter-${chapter.number}`;
  return { printSlug: key, pdfName: `mechanics-${key}.pdf` };
}

export function buildBook({ root }) {
  const structure = parseBook(root);
  const warnings = [...structure.warnings];
  const model = buildModel(structure);

  for (const page of model.pages) {
    const t = tokenize(page.tex, { name: page.name });
    page.blocks = t.blocks;
    page.mathSpans = t.mathSpans;
    page.assets = t.assets;
    warnings.push(...t.warnings);
  }

  const anchors = annotateContent(model.pages, warnings);
  finalizeMathSpans(model.pages, anchors, warnings);

  const missingFigures = new Set();
  const figureSrc = asset => {
    if (asset.kind !== 'image') return null;
    const resolved = resolveFigureFile(root, asset.file);
    if (!resolved) {
      missingFigures.add(asset.file);
      return null;
    }
    return `/figures/${resolved}`;
  };

  const unknownConstructs = new Map();
  const notices = [];

  for (const page of model.pages) {
    const ctx = {
      page,
      anchors,
      warnings,
      notices,
      footnotes: [],
      indexEntries: [],
      nextIndexId: () => 0,
      unknown: cmd => {
        if (!unknownConstructs.has(cmd)) unknownConstructs.set(cmd, new Set());
        unknownConstructs.get(cmd).add(page.name);
      },
      mathSpans: page.mathSpans,
      assets: page.assets,
      figureSrc,
      name: page.name,
      renderAsset: idx => renderAssetImg(idx, ctx, false),
    };

    const parts = [renderBlocks(page.blocks, ctx)];

    if (page.kind === 'chapter') {
      parts.push(sectionListHtml(page.chapter));
      const { pdfName } = printNames(page.chapter);
      if (fs.existsSync(path.join(root, 'assets', 'pdf', pdfName))) {
        parts.push(
          `<p class="chapter-pdf"><a href="/assets/pdf/${pdfName}" download>Download this chapter as PDF</a></p>`
        );
      }
    }

    if (ctx.footnotes.length > 0) {
      const items = ctx.footnotes
        .map(
          (fn, n) =>
            `<li id="fn-${n + 1}">${fn} <a href="#fnref-${n + 1}" class="footnote-back" aria-label="Back to reference">↩</a></li>`
        )
        .join('\n');
      parts.push(`<div class="footnotes"><hr />\n<ol>\n${items}\n</ol>\n</div>`);
    }

    page.htmlTitle =
      (page.kind === 'section' ? `${page.number} ` : `${page.number}. `) +
      renderTitle(page.title, ctx);
    page.html = `<article>\n${parts.join('\n')}\n</article>`;
  }

  for (const file of missingFigures) warnings.push(`figure file not found: ${file}`);

  // ---- build report -------------------------------------------------------
  const unknownReport = [...unknownConstructs.entries()].map(([cmd, where]) => ({
    command: cmd,
    where: [...where].sort(),
  }));
  const report = {
    pages: model.pages.length,
    warnings,
    notices,
    unknownConstructs: unknownReport,
  };
  fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generated', 'build-report.json'),
    JSON.stringify(report, null, 2)
  );

  console.log(`[book] ${model.pages.length} pages`);
  for (const w of warnings.slice(0, 40)) console.warn(`[book] WARNING: ${w}`);
  if (warnings.length > 40) console.warn(`[book] ...and ${warnings.length - 40} more warnings`);
  for (const u of unknownReport) {
    console.warn(`[book] UNKNOWN CONSTRUCT ${u.command} in ${u.where.join(', ')}`);
  }

  const summaryJson = JSON.stringify(
    {
      title: BOOK_TITLE,
      chapters: model.chapters.map(ch => ({
        number: ch.number,
        title: ch.plainTitle,
        url: ch.url,
        sections: ch.sections.map(s => ({ number: s.number, title: s.plainTitle, url: s.url })),
      })),
    },
    null,
    2
  );

  // Per-chapter concatenated print pages (/print/<slug>/) for PDF generation.
  const printManifest = [];
  for (const chapter of model.chapters) {
    const { printSlug, pdfName } = printNames(chapter);
    chapter.printSlug = printSlug;
    const chapterPages = model.pages.filter(p => p.chapter === chapter);
    // print.njk already prints the chapter title as the page <h1>; repeating it
    // as the landing page's own heading just duplicates it at the top of every
    // chapter PDF.
    chapter.printHtml = chapterPages
      .map(p =>
        p.kind === 'chapter'
          ? `<section class="print-section">\n${p.html}\n</section>`
          : `<section class="print-section">\n<h2>${p.htmlTitle}</h2>\n${p.html}\n</section>`
      )
      .join('\n');
    printManifest.push({
      printUrl: `/print/${printSlug}/`,
      pdfName,
      title: chapter.displayTitle,
    });
  }
  fs.writeFileSync(
    path.join(root, 'generated', 'print-manifest.json'),
    JSON.stringify(printManifest, null, 2)
  );

  return {
    pages: model.pages,
    chapters: model.chapters,
    summaryJson,
    warningCount: warnings.length,
  };
}

/** Render a raw TeX title (may contain math) for use in <h1>. */
function renderTitle(tex, ctx) {
  const spans = [];
  const { text } = protectMath(tex, spans, [], 'title');
  return renderInline(text, { ...ctx, mathSpans: spans, name: 'title' });
}
