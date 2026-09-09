// parse/book.js — ClassicalMech.tex → chapter/section structure.
//
// The master drives everything via \include{}. Two kinds of included file
// exist and the split is load-bearing:
//
//   Chapter_X.tex           opens with \chapter{...} — starts a new chapter
//   Chapter_X_Problems.tex  opens with \section{Problems} — LaTeX's \include
//                           only forces a page break, so this file's sections
//                           belong to the chapter that came before it
//
// Title page and TOC machinery in the master are print-only and skipped.
import fs from 'node:fs';
import { bookFile, srcFile } from '../paths.js';
import { stripLineComment, extractBraceGroup, extractBracketGroup } from './tex-utils.js';

/**
 * @returns {{
 *   chapters: Array<{
 *     mode: 'main'|'appendix',
 *     number: string|null,           // '1'..'9' for main chapters
 *     title: string,                 // raw TeX display title
 *     file: string,                  // source file base name (diagnostics)
 *     introTex: string,              // chapter body before the first \section
 *     sections: Array<{title: string, tex: string, file: string}>,
 *   }>,
 *   warnings: string[],
 * }}
 */
export function parseBook(root) {
  const warnings = [];
  const master = fs.readFileSync(bookFile(root), 'utf8');
  const body = sliceDocumentBody(master);

  // Ordered include list from the master, with the mode active at that point.
  const includes = [];
  let mode = 'main';
  for (const line of body.split('\n')) {
    const clean = stripLineComment(line);
    if (/^\\appendix\b/.test(clean.trim())) mode = 'appendix';
    const inc = clean.match(/\\include\{([^}]+)\}/);
    if (inc) includes.push({ name: inc[1], mode });
  }
  if (includes.length === 0) warnings.push('ClassicalMech.tex: no \\include{} files found');

  const chapters = [];
  let mainCounter = 0;
  let appendixCounter = 0;
  for (const { name, mode: chapterMode } of includes) {
    let source;
    try {
      source = fs.readFileSync(srcFile(root, name), 'utf8');
    } catch {
      warnings.push(`missing include file: ${name}.tex`);
      continue;
    }
    const parsed = parseIncludeFile(source, name, warnings);

    if (!parsed.title) {
      // A continuation file (\section{Problems} and nothing above it).
      const previous = chapters[chapters.length - 1];
      if (!previous) {
        warnings.push(`${name}: continuation file with no preceding chapter`);
        continue;
      }
      if (parsed.introTex.trim()) {
        warnings.push(`${name}: text before the first \\section is dropped`);
      }
      previous.sections.push(...parsed.sections);
      continue;
    }

    const chapter = {
      mode: chapterMode,
      number: null,
      title: parsed.title,
      file: name,
      introTex: parsed.introTex,
      sections: parsed.sections,
    };
    if (chapterMode === 'appendix') {
      chapter.number = String.fromCharCode(65 + appendixCounter++);
    } else {
      chapter.number = String(++mainCounter);
    }
    chapters.push(chapter);
  }

  return { chapters, warnings };
}

function sliceDocumentBody(master) {
  const start = master.indexOf('\\begin{document}');
  const end = master.indexOf('\\end{document}');
  if (start === -1 || end === -1) {
    throw new Error('ClassicalMech.tex: missing \\begin{document}/\\end{document}');
  }
  return master.slice(start + '\\begin{document}'.length, end);
}

/**
 * Split one included file at its (optional) \chapter heading and then at
 * \section{}. Returns `title: null` for a continuation file.
 */
function parseIncludeFile(source, name, warnings) {
  const stripped = source
    .split('\n')
    .filter(line => !line.trimStart().startsWith('%'))
    .map(stripLineComment)
    .join('\n');

  let title = null;
  let headingEnd = 0;
  const chapIdx = stripped.search(/\\chapter\s*\*?\s*[[{]/);
  if (chapIdx !== -1) {
    const pos = chapIdx + stripped.slice(chapIdx).match(/^\\chapter\s*\*?\s*/)[0].length;
    const opt = extractBracketGroup(stripped, pos);
    const group = extractBraceGroup(stripped, opt ? opt.end : pos);
    if (!group) {
      warnings.push(`${name}: unbalanced \\chapter title`);
      title = name;
      headingEnd = stripped.length;
    } else {
      title = group.value.trim();
      headingEnd = group.end;
    }
  }

  // Split at \section{} — NOT \section*{}, which stays in-flow as a heading.
  const marks = [];
  let searchFrom = headingEnd;
  for (;;) {
    const idx = stripped.indexOf('\\section{', searchFrom);
    if (idx === -1) break;
    const group = extractBraceGroup(stripped, idx + '\\section'.length);
    if (!group) {
      warnings.push(`${name}: unbalanced \\section title`);
      break;
    }
    marks.push({ title: group.value.trim(), end: group.end, start: idx });
    searchFrom = group.end;
  }

  const introTex = stripped
    .slice(headingEnd, marks.length ? marks[0].start : stripped.length)
    .trim();
  const sections = marks.map((mark, k) => ({
    title: mark.title,
    file: name,
    tex: stripped
      .slice(mark.end, k + 1 < marks.length ? marks[k + 1].start : stripped.length)
      .trim(),
  }));

  return { title, introTex, sections };
}
