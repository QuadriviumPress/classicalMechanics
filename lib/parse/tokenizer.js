// parse/tokenizer.js — a chapter intro or section body → structured block list.
//
// Stage order is load-bearing:
//   0. RAW protection (before comment stripping): verbatim environments and
//      \includegraphics images are lifted out into asset slots. Raw content may
//      contain %, $, \ in any combination, so it must never see later stages.
//   1. Comments stripped line-by-line.
//   2. Math protection: $...$, $$...$$ and display math environments
//      (equation, align, alignat, gather, multline, displaymath) become
//      placeholders; nested $...$ (text-mode math inside \text{}) stays inside
//      the span verbatim — MathJax's textmacros extension parses it.
//   3. Block segmentation: the author's own environments (example, problem,
//      solution, detailedderivation, hideablesection), \capfig floats, text
//      environments, lists, tables and paragraphs.
//
// The author's macros come from the ClassicalMech.tex preamble:
//   \capfig{width}{file}{caption}      figure float with a caption
//   example  [3 args: skip, prompt, float]
//   problem  [1 arg: title]
//   solution / detailedderivation / hideablesection   [visibility switches]
import {
  stripLineComment,
  extractBraceGroup,
  extractBracketGroup,
  extractEnv,
  splitTopLevel,
  skipWs,
} from './tex-utils.js';
import { preprocessMathTex } from '../render/inline.js';

export const PH_OPEN = '\uE000';
export const PH_CLOSE = '\uE001';
export const ASSET_OPEN = '\uE002';
export const ASSET_CLOSE = '\uE003';

export const PH_RE = /\uE000(\d+)\uE001/g;
export const ASSET_RE = /\uE002(\d+)\uE003/g;

// Text environments handled as blocks in stage 3.
export const TEXT_ENVS = new Set([
  'figure',
  'figure*',
  'table',
  'table*',
  'center',
  'itemize',
  'enumerate',
  'description',
  'quote',
  'quotation',
  'flushleft',
  'flushright',
  'minipage',
  'tabular',
  'example',
  'problem',
  'solution',
  'detailedderivation',
  'hideablesection',
]);

const SIZE_GROUPS = new Set([
  'small',
  'footnotesize',
  'scriptsize',
  'tiny',
  'large',
  'Large',
  'normalsize',
]);

/**
 * @param {string} source raw TeX of one chapter intro / section body
 * @param {{name?: string}} opts
 */
export function tokenize(source, { name = 'section' } = {}) {
  const warnings = [];
  const notices = [];
  const assets = [];
  const mathSpans = [];

  const putAsset = asset => {
    assets.push(asset);
    return assets.length - 1;
  };

  const stage0 = protectRaw(source, { warnings, name, putAsset });
  const stripped = stripComments(stage0);
  const { text } = protectMath(stripped, mathSpans, warnings, name);
  const ctx = { warnings, notices, name, mathSpans, assets, putAsset };
  const blocks = parseBlocks(text, ctx);

  return { blocks, mathSpans, assets, warnings, notices };
}

// ---------------------------------------------------------------------------
// Stage 0 — raw extraction
// ---------------------------------------------------------------------------

const VERBATIM_ENVS = new Set(['Verbatim', 'Verbatim*', 'verbatim', 'verbatim*']);

function protectRaw(source, { warnings, name, putAsset }) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const begin = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(source.slice(i, i + 30));
    if (begin) {
      const env = begin[1];
      if (VERBATIM_ENVS.has(env)) {
        const span = extractVerbatimEnv(source, i, env);
        if (span) {
          out += wrapAsset(putAsset({ kind: 'verbatim', env, content: span.inner }));
          i = span.end;
          continue;
        }
        warnings.push(`${name}: unbalanced ${env}`);
      }
      out += source.slice(i, i + begin[0].length);
      i += begin[0].length;
      continue;
    }
    const inc = includegraphicsAt(source, i);
    if (inc) {
      out += wrapAsset(putAsset({ kind: 'image', file: inc.file }));
      i = inc.end;
      continue;
    }
    out += source.slice(i, i + 2);
    i += 2;
  }
  return out;
}

function wrapAsset(idx) {
  return ASSET_OPEN + idx + ASSET_CLOSE;
}

function includegraphicsAt(source, i) {
  const m = /^\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/.exec(source.slice(i));
  if (!m) return null;
  return { file: m[1].trim(), end: i + m[0].length };
}

function extractVerbatimEnv(source, start, env) {
  const open = `\\begin{${env}}`;
  const close = `\\end{${env}}`;
  const openEnd = start + open.length;
  const end = source.indexOf(close, openEnd);
  if (end === -1) return null;
  return { inner: source.slice(openEnd, end), end: end + close.length };
}

function stripComments(source) {
  const out = [];
  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('%')) continue;
    out.push(stripLineComment(line));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Stage 2 — math protection
// ---------------------------------------------------------------------------

/** Register a math span and return the text that replaces it. */
function placeSpan(span, mathSpans) {
  mathSpans.push(span);
  return PH_OPEN + (mathSpans.length - 1) + PH_CLOSE;
}

export function protectMath(text, mathSpans, warnings, name) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      if (text[i + 1] === '[') {
        // \[ ... \] display math
        const end = text.indexOf('\\]', i + 2);
        if (end === -1) {
          warnings.push(`${name}: unterminated \\[ display math`);
          out += '\\[';
          i += 2;
          continue;
        }
        out += placeSpan(
          { kind: 'display', tex: preprocessMathTex(text.slice(i + 2, end)) },
          mathSpans
        );
        i = end + 2;
        continue;
      }
      const begin =
        /^\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|displaymath|split)\}/.exec(
          text.slice(i, i + 30)
        );
      if (begin) {
        const env = begin[1];
        const span = extractMathEnv(text, i, env, warnings, name);
        if (span) {
          out += placeSpan(span.span, mathSpans);
          i = span.end;
          continue;
        }
      }
      out += text.slice(i, i + 2); // escaped char (\$ etc.) stays verbatim
      i += 2;
      continue;
    }
    if (ch === '$') {
      const isDisplay = text[i + 1] === '$';
      const delimLen = isDisplay ? 2 : 1;
      let j = i + delimLen;
      let found = -1;
      // Depth matters: \text{if $n \ne -1$} nests text-mode math inside the
      // span, and its inner $ must not be read as the closing delimiter.
      let depth = 0;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        else if (depth === 0 && text[j] === '$' && (!isDisplay || text[j + 1] === '$')) {
          found = j;
          break;
        }
        j++;
      }
      if (found === -1) {
        warnings.push(`${name}: unterminated ${isDisplay ? '$$' : '$'} math`);
        out += ch;
        i++;
        continue;
      }
      out += placeSpan(
        {
          kind: isDisplay ? 'display' : 'inline',
          tex: preprocessMathTex(text.slice(i + delimLen, found)),
        },
        mathSpans
      );
      i = found + delimLen;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, mathSpans };
}

/** Whole display env → span. */
function extractMathEnv(text, start, env, warnings, name) {
  const span = extractEnv(text, start, env);
  if (!span) {
    warnings.push(`${name}: unbalanced \\begin{${env}}`);
    return null;
  }
  const whole = text.slice(start, span.end);
  return {
    end: span.end,
    span: { kind: 'env', env, innerEnv: env, boxed: false, tex: preprocessMathTex(whole) },
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — block segmentation
// ---------------------------------------------------------------------------

function parseBlocks(text, ctx) {
  const blocks = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) blocks.push(...paragraphBlocks(buf, ctx));
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '{' && bufCommandsOnly(buf)) {
      // Block-level {group}: {\small ...} wrappers. A preceding run of layout
      // commands (\vspace{5mm}\noindent...) does not prevent it starting one.
      const group = extractBraceGroup(text, i);
      if (group) {
        const styleMatch = group.value.match(/^\\([a-zA-Z]+)\s*/);
        if (styleMatch && SIZE_GROUPS.has(styleMatch[1])) {
          flush();
          blocks.push({
            type: 'sizeGroup',
            size: styleMatch[1],
            children: parseBlocks(group.value.slice(styleMatch[0].length), ctx),
          });
          i = group.end;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }

    if (ch === '\\') {
      // \par ends a paragraph.
      if (text.startsWith('\\par', i) && !/[a-zA-Z]/.test(text[i + 4] ?? '')) {
        flush();
        i += 4;
        continue;
      }

      const begin = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(text.slice(i, i + 30));
      if (begin && TEXT_ENVS.has(begin[1])) {
        flush();
        const env = begin[1];
        const span = extractEnv(text, i, env);
        if (!span) {
          ctx.warnings.push(`${ctx.name}: unbalanced \\begin{${env}}`);
          i += begin[0].length;
          continue;
        }
        blocks.push(...envBlocks(env, span.inner, ctx));
        i = span.end;
        continue;
      }

      const macro = blockMacroAt(text.slice(i), ctx);
      if (macro) {
        flush();
        blocks.push(...macro.blocks);
        i += macro.end;
        continue;
      }

      const strayEnd = /^\\end\{([a-zA-Z]+\*?)\}/.exec(text.slice(i, i + 30));
      if (strayEnd) {
        if (TEXT_ENVS.has(strayEnd[1])) {
          ctx.warnings.push(`${ctx.name}: unbalanced \\end{${strayEnd[1]}}`);
        }
        i += strayEnd[0].length;
        continue;
      }

      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return blocks;
}

/** True when a paragraph buffer holds only layout commands and whitespace. */
function bufCommandsOnly(buf) {
  return buf.replace(/\\[a-zA-Z]+\s*(\[[^\]]*\])?\s*(\{[^{}]*\})?/g, '').trim() === '';
}

/** In-flow headings below \section, which drives page splitting. */
const HEADING_LEVELS = {
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

/**
 * Commands that begin a block. `text` starts at the backslash; returned `end`
 * is relative to that position.
 */
function blockMacroAt(text, ctx) {
  // \capfig{width}{file}{caption} — the author's captioned-figure shorthand,
  // expanding to a centred \includegraphics inside a figure float.
  if (text.startsWith('\\capfig')) {
    const widthG = extractBraceGroup(text, skipWs(text, '\\capfig'.length));
    const fileG = widthG && extractBraceGroup(text, skipWs(text, widthG.end));
    const capG = fileG && extractBraceGroup(text, skipWs(text, fileG.end));
    if (!capG) {
      ctx.warnings.push(`${ctx.name}: malformed \\capfig`);
      return { blocks: [], end: '\\capfig'.length };
    }
    return {
      blocks: [makeCapfig(widthG.value, fileG.value, capG.value, ctx)],
      end: capG.end,
    };
  }

  // Headings that stay in-flow: \section* and everything below \section.
  const headM = /^\\(section\*|subsection\*?|subsubsection\*?|paragraph\*?|subparagraph\*?)\s*\{/.exec(
    text
  );
  if (headM) {
    const g = extractBraceGroup(text, headM[0].length - 1);
    if (g) {
      const kind = headM[1].replace('*', '');
      return {
        blocks: [{ type: 'subheading', level: HEADING_LEVELS[kind], title: g.value.trim() }],
        end: g.end,
      };
    }
  }

  if (text.startsWith('\\centerline')) {
    const g = extractBraceGroup(text, '\\centerline'.length);
    if (g) return { blocks: [{ type: 'centerline', text: g.value.trim() }], end: g.end };
  }

  return null;
}

/**
 * One \capfig — a figure float holding a single image asset. The width is
 * given as a fraction of \textwidth; carry it through so the web edition keeps
 * the author's relative sizing instead of blowing every diagram up to full
 * column width.
 */
function makeCapfig(width, file, caption, ctx) {
  const idx = ctx.putAsset({ kind: 'image', file: file.trim() });
  const frac = width.match(/^\s*([0-9.]+)\s*\\(?:textwidth|linewidth|columnwidth)\s*$/);
  // The author puts \label inside the caption argument, where it attaches to
  // the figure counter — lift it out so it anchors the float, not the text.
  const { label, text } = takeLabel(caption);
  return {
    type: 'figure',
    panels: [],
    caption: text.trim(),
    label,
    width: frac ? Math.min(1, Number(frac[1])) : null,
    children: [{ type: 'asset', idx, scaled: false }],
  };
}

// ---------------------------------------------------------------------------
// Environments → blocks
// ---------------------------------------------------------------------------

/** Read `count` required {...} arguments off the front of an environment body. */
function envArgs(inner, count, ctx, env) {
  const args = [];
  let pos = 0;
  for (let k = 0; k < count; k++) {
    const g = extractBraceGroup(inner, skipWs(inner, pos));
    if (!g) {
      ctx.warnings.push(`${ctx.name}: ${env} environment missing argument ${k + 1}`);
      return { args, body: inner.slice(pos) };
    }
    args.push(g.value);
    pos = g.end;
  }
  return { args, body: inner.slice(pos) };
}

function envBlocks(env, inner, ctx) {
  switch (env) {
    case 'figure':
    case 'figure*':
      return [parseFigure(skipPlacementArg(inner), ctx)];
    case 'table':
    case 'table*':
      return [parseTableFloat(skipPlacementArg(inner), ctx)];
    case 'center':
      return [{ type: 'center', children: parseBlocks(inner, ctx) }];
    case 'example': {
      // \begin{example}{vertical skip}{prompt}{float}
      const { args, body } = envArgs(inner, 3, ctx, 'example');
      const label = takeLabel(body);
      return [
        {
          type: 'example',
          label: label.label,
          prompt: (args[1] ?? '').trim(),
          float: parseBlocks((args[2] ?? '').trim(), ctx),
          children: parseBlocks(label.text, ctx),
        },
      ];
    }
    case 'problem': {
      // \begin{problem}{title}
      const { args, body } = envArgs(inner, 1, ctx, 'problem');
      const label = takeLabel(body);
      return [
        {
          type: 'problem',
          label: label.label,
          heading: (args[0] ?? '').trim(),
          children: parseBlocks(label.text, ctx),
        },
      ];
    }
    case 'solution':
      // Hidden in the printed book (\showproblemsolutions is false); the web
      // edition keeps it, folded away behind a disclosure control.
      return [{ type: 'solution', children: parseBlocks(inner, ctx) }];
    case 'detailedderivation':
      return [{ type: 'derivation', children: parseBlocks(inner, ctx) }];
    case 'hideablesection':
      return parseBlocks(inner, ctx);
    case 'minipage': {
      let pos = skipWs(inner, 0);
      const opt = extractBracketGroup(inner, pos);
      if (opt) pos = opt.end;
      const widthG = extractBraceGroup(inner, pos);
      const body = widthG ? inner.slice(widthG.end) : inner;
      return parseBlocks(body, ctx);
    }
    case 'tabular':
      return [parseTabular(inner, ctx)];
    case 'itemize':
      return [{ type: 'list', ordered: false, items: parseListItems(inner, ctx) }];
    case 'enumerate':
      return parseEnumerate(inner, ctx);
    case 'description':
      return [{ type: 'descList', items: parseDescriptionItems(inner, ctx) }];
    case 'quote':
    case 'quotation':
      return [{ type: 'quote', children: parseBlocks(inner, ctx) }];
    case 'flushleft':
      return [{ type: 'flushleft', children: parseBlocks(inner, ctx) }];
    case 'flushright':
      return [{ type: 'flushright', children: parseBlocks(inner, ctx) }];
    default:
      ctx.warnings.push(`${ctx.name}: unhandled environment ${env}`);
      return [{ type: 'p', text: inner }];
  }
}

/**
 * Pull a top-level \label out of an example/problem body. The author puts it
 * on the last line, after the content, where it would otherwise render as a
 * stray anchor at the end of the box.
 */
function takeLabel(body) {
  const m = body.match(/\\label\{([^}]+)\}/);
  if (!m) return { label: null, text: body };
  return { label: m[1], text: body.slice(0, m.index) + body.slice(m.index + m[0].length) };
}

function skipPlacementArg(inner) {
  const pos = skipWs(inner, 0);
  if (inner[pos] !== '[') return inner;
  const end = inner.indexOf(']', pos);
  if (end === -1) return inner;
  return inner.slice(end + 1);
}

/** A figure float: an image asset (usually inside \center) plus \caption. */
function parseFigure(inner, ctx) {
  let caption = null;
  let label = null;

  const capIdx = inner.search(/\\caption\s*[[{]/);
  let rest = inner;
  if (capIdx !== -1) {
    const opt = extractBracketGroup(inner, capIdx + '\\caption'.length);
    const g = extractBraceGroup(inner, opt ? opt.end : capIdx + '\\caption'.length);
    if (g) {
      let cap = g.value;
      const labM = cap.match(/\\label\{([^}]+)\}/);
      if (labM) {
        label = labM[1];
        cap = cap.replace(labM[0], '');
      }
      caption = cap.trim();
      rest = inner.slice(0, capIdx) + inner.slice(g.end);
    }
  }
  const labM = rest.match(/\\label\{([^}]+)\}/);
  if (labM && !label) {
    label = labM[1];
    rest = rest.replace(labM[0], '');
  }

  const children = parseBlocks(rest.replace(/\\centering|\\center\b/g, ''), ctx);
  if (!caption) ctx.notices.push(`${ctx.name}: figure without a caption`);
  return { type: 'figure', panels: [], caption, label, width: null, children };
}

function parseTableFloat(inner, ctx) {
  let caption = null;
  let label = null;
  let rest = inner;
  const capIdx = inner.search(/\\caption\s*[[{]/);
  if (capIdx !== -1) {
    const opt = extractBracketGroup(inner, capIdx + '\\caption'.length);
    const g = extractBraceGroup(inner, opt ? opt.end : capIdx + '\\caption'.length);
    if (g) {
      let cap = g.value;
      const labM = cap.match(/\\label\{([^}]+)\}/);
      if (labM) {
        label = labM[1];
        cap = cap.replace(labM[0], '');
      }
      caption = cap.trim();
      rest = inner.slice(0, capIdx) + inner.slice(g.end);
    }
  }
  const children = parseBlocks(rest.replace(/\\centering|\\center\b/g, ''), ctx);
  return { type: 'tableFloat', caption, label, children };
}

/**
 * enumerate with an optional [style] label spec (paralist). \suspend/\resume
 * chunks keep numbering running across interstitial text.
 */
function parseEnumerate(inner, ctx) {
  let pos = skipWs(inner, 0);
  let style = null;
  const styleOpt = extractBracketGroup(inner, pos);
  if (styleOpt && styleOpt.from === pos) {
    style = listStyle(styleOpt.value);
    pos = styleOpt.end;
  }
  const body = inner.slice(pos);

  const parts = [];
  const suspRe = /\\suspend\{([a-zA-Z*]+)\}/g;
  let match;
  let last = 0;
  while ((match = suspRe.exec(body))) {
    parts.push({ kind: 'seg', text: body.slice(last, match.index) });
    const resumeRe = new RegExp(`\\\\resume\\{${match[1]}\\}`);
    const resumeMatch = resumeRe.exec(body.slice(suspRe.lastIndex));
    if (resumeMatch) {
      parts.push({
        kind: 'between',
        text: body.slice(suspRe.lastIndex, suspRe.lastIndex + resumeMatch.index),
      });
      let after = suspRe.lastIndex + resumeMatch.index + resumeMatch[0].length;
      const opt = extractBracketGroup(body, after);
      if (opt && opt.from === after) {
        style = listStyle(opt.value.replace(/^\{|\}$/g, ''));
        after = opt.end;
      }
      last = after;
      suspRe.lastIndex = after;
    } else {
      parts.push({ kind: 'between', text: '' });
      last = suspRe.lastIndex;
    }
  }
  parts.push({ kind: 'seg', text: body.slice(last) });

  const blocks = [];
  let count = 0;
  for (const part of parts) {
    if (part.kind === 'between') {
      if (part.text.trim()) blocks.push(...parseBlocks(part.text, ctx));
      continue;
    }
    const { items, prefix } = collectItems(part.text, ctx);
    if (prefix.trim()) blocks.push(...parseBlocks(prefix, ctx));
    if (items.length === 0) continue;
    count += items.length;
    blocks.push({ type: 'list', ordered: true, style, start: count - items.length + 1, items });
  }
  if (blocks.length === 0) blocks.push({ type: 'list', ordered: true, style, start: 1, items: [] });
  return blocks;
}

const LIST_ENVS = new Set(['enumerate', 'itemize', 'description', 'compactenum', 'compactitem']);
// Layout wrappers that may span \item boundaries inside a list; transparent to
// item splitting.
const TRANSPARENT_ENVS = new Set(['center']);

/** Parse \item entries of one list segment. */
function collectItems(segment, ctx) {
  let masked = '';
  let current = null;
  const raw = [];
  let listDepth = 0;
  let firstItemAt = -1;
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === '\\') {
      const bm = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(segment.slice(i, i + 30));
      if (bm) {
        const env = bm[1];
        if (TRANSPARENT_ENVS.has(env)) {
          masked += ' '.repeat(bm[0].length);
          i += bm[0].length;
          continue;
        }
        if (LIST_ENVS.has(env)) listDepth++;
        masked += bm[0];
        i += bm[0].length;
        continue;
      }
      const em = /^\\end\{([a-zA-Z]+\*?)\}/.exec(segment.slice(i, i + 30));
      if (em) {
        const env = em[1];
        if (TRANSPARENT_ENVS.has(env)) {
          masked += ' '.repeat(em[0].length);
          i += em[0].length;
          continue;
        }
        if (LIST_ENVS.has(env)) listDepth = Math.max(0, listDepth - 1);
        masked += em[0];
        i += em[0].length;
        continue;
      }
      if (
        listDepth === 0 &&
        segment.startsWith('\\item', i) &&
        !/[a-zA-Z]/.test(segment[i + 5] ?? '')
      ) {
        if (current) current.end = i;
        let pos = i + 5;
        let label = null;
        const br = extractBracketGroup(segment, pos);
        if (br && br.from === skipWs(segment, pos)) {
          label = br.value;
          pos = br.end;
        }
        current = { label, start: pos, end: segment.length };
        raw.push(current);
        if (firstItemAt === -1) firstItemAt = i;
        masked += ' '.repeat(pos - i); // keep masked length == segment length
        i = pos;
        continue;
      }
      masked += segment.slice(i, i + 2);
      i += 2;
      continue;
    }
    masked += segment[i];
    i++;
  }
  if (current) current.end = segment.length;

  const prefix = firstItemAt === -1 ? masked : masked.slice(0, firstItemAt);

  return {
    prefix,
    items: raw.map(item => ({
      label: item.label,
      children: parseBlocks(masked.slice(item.start, item.end), ctx),
    })),
  };
}

/** Map paralist optional label syntax to a CSS list-style token. */
function listStyle(raw) {
  if (!raw) return null;
  const s = raw.replace(/\\[a-zA-Z]+|\s|\{|\}/g, '');
  if (/^\(?[a-z][).]?$/.test(s)) return 'lower-alpha';
  if (/^\(?[A-Z][).]?$/.test(s)) return 'upper-alpha';
  if (/^\(?[ivx]+[).]?$/.test(s)) return 'lower-roman';
  if (/^\(?[IVX]+[).]?$/.test(s)) return 'upper-roman';
  return 'decimal';
}

function parseListItems(inner, ctx) {
  const { items } = collectItems(inner, ctx);
  if (items.length === 0) ctx.warnings.push(`${ctx.name}: list without \\item`);
  return items;
}

function parseDescriptionItems(inner, ctx) {
  const items = [];
  let current = null;
  let depth = 0;
  let i = 0;
  const push = end => {
    if (current) {
      items.push({
        label: current.label,
        children: parseBlocks(inner.slice(current.bodyStart, end), ctx),
      });
    }
  };
  while (i < inner.length) {
    if (inner[i] === '\\') {
      if (depth === 0 && inner.startsWith('\\item', i) && !/[a-zA-Z]/.test(inner[i + 5] ?? '')) {
        push(i);
        let bodyStart = i + 5;
        let label = null;
        const br = extractBracketGroup(inner, bodyStart);
        if (br && br.from === skipWs(inner, bodyStart)) {
          label = br.value;
          bodyStart = br.end;
        }
        current = { label, bodyStart };
        i = bodyStart;
        continue;
      }
      if (/^\\begin\{/.test(inner.slice(i, i + 8))) depth++;
      if (/^\\end\{/.test(inner.slice(i, i + 6))) depth--;
      i += 2;
      continue;
    }
    i++;
  }
  push(inner.length);
  return items;
}

// ---------------------------------------------------------------------------
// Tabular
// ---------------------------------------------------------------------------

function parseTabular(inner, ctx) {
  const pos = skipWs(inner, 0);
  const specG = extractBraceGroup(inner, pos);
  if (!specG) {
    ctx.warnings.push(`${ctx.name}: tabular without column spec`);
    return { type: 'p', text: inner };
  }
  // Column spec: letters l/c/r/p{..}, with | rules and !{..} separators.
  const columns = [];
  for (const part of splitTopLevel(specG.value, '!')) {
    const noBrace = part.replace(/\{[^{}]*\}/g, '');
    for (const ch of noBrace) {
      if (ch === 'l' || ch === 'p') columns.push('left');
      else if (ch === 'c') columns.push('center');
      else if (ch === 'r') columns.push('right');
    }
  }

  const body = inner.slice(specG.end);
  const rows = [];
  let start = 0;
  let hlineForNext = 0;
  const pushRow = end => {
    let text = body.slice(start, end);
    let hlines = hlineForNext;
    hlineForNext = 0;
    let m;
    while ((m = text.match(/^\s*\\hline/))) {
      hlines++;
      text = text.slice(m[0].length);
    }
    const trailing = text.match(/(\\hline\s*)+$/);
    if (trailing) {
      hlineForNext = (trailing[0].match(/\\hline/g) || []).length;
      text = text.slice(0, trailing.index);
    }
    if (text.trim() === '') {
      hlineForNext = Math.max(hlineForNext, hlines);
      return;
    }
    const cells = splitTopLevel(text, '&').map(c => parseCell(c.trim()));
    rows.push({ cells, topline: hlines > 0 });
  };
  let i = 0;
  let depth = 0;
  while (i < body.length) {
    if (body[i] === '\\') {
      if (body[i + 1] === '\\' && depth === 0) {
        let after = i + 2;
        const br = extractBracketGroup(body, after);
        if (br && br.from === after) after = br.end;
        pushRow(i);
        start = after;
        i = after;
        continue;
      }
      if (/^\\begin\{/.test(body.slice(i, i + 8))) depth++;
      if (/^\\end\{/.test(body.slice(i, i + 6))) depth--;
      i += 2;
      continue;
    }
    if (body[i] === '{') depth++;
    if (body[i] === '}') depth--;
    i++;
  }
  pushRow(body.length);
  return { type: 'tabular', columns, rows, bottomline: hlineForNext > 0 };
}

/** One tabular cell: detects \multicolumn{span}{spec}{content}. */
function parseCell(cell) {
  const m = /^\\multicolumn\{(\d+)\}\{[^{}]*([lcr])[^{}]*\}\s*\{/.exec(cell);
  if (!m) return { content: cell, span: 1, align: null };
  const g = extractBraceGroup(cell, m[0].length - 1);
  if (!g) return { content: cell, span: 1, align: null };
  const align = { l: 'left', c: 'center', r: 'right' }[m[2]];
  return { content: g.value, span: Number(m[1]), align };
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

function paragraphBlocks(buf, ctx) {
  const blocks = [];
  for (const para of buf.split(/\n\s*\n/)) {
    let last = 0;
    const pieces = [];
    PH_RE.lastIndex = 0;
    let m;
    while ((m = PH_RE.exec(para))) {
      const span = ctx.mathSpans[Number(m[1])];
      if (span.kind === 'inline') continue;
      pieces.push({ text: para.slice(last, m.index) });
      pieces.push({ math: Number(m[1]) });
      last = m.index + m[0].length;
    }
    pieces.push({ text: para.slice(last) });
    for (const piece of pieces) {
      if (piece.math !== undefined) {
        blocks.push({ type: 'displayMath', span: piece.math });
      } else if (piece.text && piece.text.trim() !== '') {
        blocks.push({ type: 'p', text: piece.text.trim() });
      }
    }
  }
  return blocks;
}
