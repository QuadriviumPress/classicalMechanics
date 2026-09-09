// model/content.js — single annotation pass in reading order.
//
// Numbering mirrors the print book exactly (report class + the master
// preamble's counters):
//   figures    N.k   (\thefigure   = \thechapter.\arabic{figure})
//   tables     N.k   (\thetable    = \thechapter.\arabic{table})
//   equations  N.k   (\theequation = \thechapter.\arabic{equation})
//   examples   N-k   (\theexample  = \thechapter-\arabic{example})
//   problems   N-k   (\theproblem  = \thechapter-\arabic{problem})
// All five counters reset at each \chapter.
//
// Anchors: labels → {url, id, number, kind}; \ref resolves against this map
// during rendering. Equation numbers are server-authoritative: the row TeX is
// rewritten with \tag{...} and MathJax runs with tags:'none'.
import { texToPlain } from '../render/inline.js';

const NUMBERED_EQ_ENVS = new Set(['equation', 'align', 'alignat', 'gather', 'multline']);
const MULTI_ROW_EQ_ENVS = new Set(['align', 'alignat', 'gather', 'flalign']);

export function annotateContent(pages, warnings) {
  const anchors = new Map();
  let chapterState = null;

  for (const page of pages) {
    if (!chapterState || chapterState.chapter !== page.chapter) {
      chapterState = newChapterState(page.chapter);
    }
    annotateBlocks(page.blocks, {
      page,
      anchors,
      warnings,
      st: chapterState,
      mathSpans: page.mathSpans,
    });
  }
  return anchors;
}

function newChapterState(chapter) {
  return {
    chapter,
    number: chapter && chapter.number ? chapter.number : null,
    figure: 0,
    table: 0,
    eq: 0,
    example: 0,
    problem: 0,
  };
}

function annotateBlocks(blocks, ctx) {
  for (const block of blocks) annotateBlock(block, ctx);
}

/**
 * \label{...} in flowing text resolves to the innermost enclosing numbered
 * thing (example, problem, figure/table float) — mirror that by threading
 * refNumber through the walk.
 */
function registerTextLabels(block, ctx) {
  if (typeof block.text !== 'string') return;
  for (const m of block.text.matchAll(/\\label\{([^}]+)\}/g)) {
    registerAnchor(
      ctx.anchors,
      m[1],
      ctx.page,
      m[1],
      ctx.refNumber ?? (ctx.page.section ? ctx.page.section.number : null),
      'text',
      ctx.warnings
    );
  }
}

function annotateBlock(block, ctx) {
  const { page, anchors, warnings, st } = ctx;
  const numbered = st.number !== null;

  switch (block.type) {
    case 'figure': {
      if (numbered) {
        st.figure += 1;
        block.number = `${st.number}.${st.figure}`;
      }
      if (block.label) {
        registerAnchor(anchors, block.label, page, block.label, block.number, 'figure', warnings);
        block.id = block.label;
      }
      annotateFigureParts(block.children, { ...ctx, refNumber: block.number ?? ctx.refNumber });
      break;
    }
    case 'tableFloat': {
      if (numbered) {
        st.table += 1;
        block.number = `${st.number}.${st.table}`;
      }
      if (block.label) {
        registerAnchor(anchors, block.label, page, block.label, block.number, 'table', warnings);
        block.id = block.label;
      }
      annotateBlocks(block.children, { ...ctx, refNumber: block.number ?? ctx.refNumber });
      break;
    }
    case 'example': {
      if (numbered) {
        st.example += 1;
        block.number = `${st.number}-${st.example}`;
      }
      if (block.label) {
        registerAnchor(anchors, block.label, page, block.label, block.number, 'example', warnings);
        block.id = block.label;
      }
      const inner = { ...ctx, refNumber: block.number ?? ctx.refNumber };
      annotateBlocks(block.float, inner);
      annotateBlocks(block.children, inner);
      break;
    }
    case 'problem': {
      if (numbered) {
        st.problem += 1;
        block.number = `${st.number}-${st.problem}`;
      }
      if (block.label) {
        registerAnchor(anchors, block.label, page, block.label, block.number, 'problem', warnings);
        block.id = block.label;
      }
      annotateBlocks(block.children, { ...ctx, refNumber: block.number ?? ctx.refNumber });
      break;
    }
    case 'p':
      registerTextLabels(block, ctx);
      break;
    case 'displayMath':
      annotateMathSpan(block.span, ctx);
      break;
    case 'center':
    case 'solution':
    case 'derivation':
    case 'quote':
    case 'flushleft':
    case 'flushright':
    case 'sizeGroup':
      annotateBlocks(block.children, ctx);
      break;
    case 'list':
      block.items.forEach((item, k) => {
        const itemNumber = block.ordered ? String((block.start ?? 1) + k) : null;
        annotateBlocks(item.children, { ...ctx, refNumber: itemNumber ?? ctx.refNumber });
      });
      break;
    case 'descList':
      for (const item of block.items) annotateBlocks(item.children, ctx);
      break;
    default:
      break;
  }
}

/** Recurse into figure innards but do not number nested floats twice. */
function annotateFigureParts(blocks, ctx) {
  for (const block of blocks) {
    switch (block.type) {
      case 'center':
      case 'sizeGroup':
        annotateBlocks(block.children, ctx);
        break;
      case 'displayMath':
        annotateMathSpan(block.span, ctx);
        break;
      case 'list':
        for (const item of block.items) annotateBlocks(item.children, ctx);
        break;
      default:
        break; // p / asset / etc. — no nested numbering inside figure bodies
    }
  }
}

/** Number one display-math span: split rows, collect labels, inject \tag. */
function annotateMathSpan(spanIdx, ctx) {
  const { page, anchors, warnings, st, mathSpans } = ctx;
  const span = mathSpans[spanIdx];
  if (!span || span.kind !== 'env') return;
  if (span.done) return; // idempotent across dev rebuilds
  if (!NUMBERED_EQ_ENVS.has(span.innerEnv)) {
    span.rendered = span.tex;
    span.done = true;
    return;
  }

  const numbered = st.number !== null;
  if (!numbered) {
    span.rendered = span.tex.replace(/\\label\{[^}]+\}/g, '');
    span.done = true;
    return;
  }

  const env = span.innerEnv;
  const open = `\\begin{${env}}`;
  const close = `\\end{${env}}`;
  const body = span.tex;
  const openMatch = body.startsWith(open) ? open : null;
  let inner = body;
  let cols = '';
  if (openMatch) {
    inner = body.slice(openMatch.length);
    const closeIdx = inner.lastIndexOf(close);
    inner = inner.slice(0, closeIdx === -1 ? undefined : closeIdx);
    // alignat keeps a {n} group right after \begin
    const colsM = env === 'alignat' ? inner.match(/^\s*\{(\d+)\}/) : null;
    if (colsM) {
      cols = colsM[0];
      inner = inner.slice(colsM[0].length);
    }
  }

  const rows = MULTI_ROW_EQ_ENVS.has(env) ? splitRows(inner) : [inner];
  const outRows = [];
  const blankLabelIds = [];
  for (const row of rows) {
    const labels = [...row.matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1]);
    const nonumber = /\\nonumber|\\notag/.test(row);
    let clean = row.replace(/\\label\{[^}]+\}/g, '').replace(/\\nonumber|\\notag/g, '');

    // 40 align bodies in this corpus end with a stray "\\" before \end{align}.
    // amsmath typesets that as an empty *numbered* line, so the counter must
    // still advance or every later equation in the chapter would be off by
    // one against the printed book — but the empty row itself is dropped
    // rather than shown as a lone number on a blank line.
    const blank = clean.trim() === '';
    let number = null;
    if (!nonumber) {
      st.eq += 1;
      number = `${st.number}.${st.eq}`;
      if (!blank) clean += `\\tag{${number}}`;
    }
    for (const label of labels) {
      registerAnchor(anchors, label, page, label, number, 'equation', warnings);
    }
    if (blank) {
      // Keep the anchor reachable even though the row is not rendered.
      if (labels.length > 0) blankLabelIds.push(...labels);
      continue;
    }
    outRows.push(labels.length > 0 ? { row: clean, id: labels[0] } : { row: clean });
  }

  // Rebuild: first row label (if any) becomes the div anchor id.
  span.firstLabelId = outRows.find(r => r.id)?.id ?? blankLabelIds[0] ?? null;
  span.allLabelIds = [...outRows.filter(r => r.id).map(r => r.id), ...blankLabelIds];
  span.rendered = openMatch
    ? open + cols + outRows.map(r => r.row).join('\\\\\n') + close
    : outRows.map(r => r.row).join('\\\\\n');
  span.done = true;
}

/**
 * Split alignment rows on \\ at brace depth 0 and outside nested environments.
 * A \begin{array} inside an align row carries its own \\ separators; splitting
 * on those would tag half an array as an equation of its own.
 */
function splitRows(text) {
  const rows = [];
  let start = 0;
  let depth = 0;
  let envDepth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      if (text.startsWith('\\begin{', i)) {
        envDepth++;
        i += 7;
        continue;
      }
      if (text.startsWith('\\end{', i)) {
        envDepth--;
        i += 5;
        continue;
      }
      if (text[i + 1] === '\\') {
        if (depth === 0 && envDepth === 0) {
          let after = i + 2;
          if (text[after] === '[') {
            const close = text.indexOf(']', after);
            if (close !== -1) after = close + 1;
          }
          if (text[after] === '*') after += 1;
          rows.push(text.slice(start, i));
          start = after;
          i = after;
          continue;
        }
        i += 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  rows.push(text.slice(start));
  return rows;
}

function registerAnchor(anchors, label, page, id, number, kind, warnings) {
  if (anchors.has(label)) {
    warnings.push(`duplicate label ${label} (${page.name})`);
    return;
  }
  anchors.set(label, { url: page.url, id, number, kind });
}

/** Plain-text projection for lists of blocks (used by the search indexer). */
export function blocksToPlain(blocks, mathSpans) {
  const parts = [];
  const walk = blocks => {
    for (const b of blocks) {
      if (b.type === 'p') parts.push(texToPlain(b.text, mathSpans));
      else if (b.children) walk(b.children);
      else if (b.items) for (const it of b.items) walk(it.children);
    }
  };
  walk(blocks);
  return parts.join(' ');
}
