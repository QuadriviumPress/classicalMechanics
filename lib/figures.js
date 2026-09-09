// figures.js — the figure-asset registry.
//
// Every figure in this book is a raster image the author committed alongside
// the LaTeX (tex/figures/*.png), reached through \capfig or \includegraphics.
// There is no TikZ, no gnuplot, and nothing to compile: eleventy.config.js
// passes tex/figures through to /figures/ and the renderer points <img> at the
// resolved file name.
import fs from 'node:fs';
import path from 'node:path';
import { parseBook } from './parse/book.js';
import { buildModel } from './model/numbering.js';
import { tokenize } from './parse/tokenizer.js';
import { figuresSrcDir } from './paths.js';

// graphicx picks the extension when the source omits it (one \capfig does).
const EXTENSIONS = ['', '.png', '.jpg', '.jpeg', '.pdf', '.eps'];

/**
 * Resolve an asset's `file` (e.g. "figures/BeadOnHoop.png", or the same
 * without an extension) to a file name inside tex/figures.
 * @returns {string|null} the base name, or null when nothing matches.
 */
export function resolveFigureFile(root, file) {
  const base = String(file).replace(/^.*\//, '');
  const dir = figuresSrcDir(root);
  for (const ext of EXTENSIONS) {
    if (ext === '' && !path.extname(base)) continue;
    if (fs.existsSync(path.join(dir, base + ext))) return base + ext;
  }
  return null;
}

/**
 * Parse the book and collect every image asset (deduped by file name) plus
 * per-page warnings.
 */
export function collectBookAssets(root) {
  const structure = parseBook(root);
  const model = buildModel(structure);
  const warnings = [...structure.warnings];
  const byFile = new Map();

  for (const page of model.pages) {
    const t = tokenize(page.tex, { name: page.name });
    warnings.push(...t.warnings);
    page.blocks = t.blocks;
    page.mathSpans = t.mathSpans;
    page.assets = t.assets;
    for (const asset of page.assets) {
      if (asset.kind !== 'image') continue;
      const resolved = resolveFigureFile(root, asset.file);
      asset.resolved = resolved;
      if (!resolved) {
        warnings.push(`${page.name}: figure file not found: ${asset.file}`);
        continue;
      }
      if (!byFile.has(resolved)) byFile.set(resolved, { file: resolved, usedIn: [] });
      byFile.get(resolved).usedIn.push(page.name);
    }
  }

  return { structure, model, assets: [...byFile.values()], warnings };
}
