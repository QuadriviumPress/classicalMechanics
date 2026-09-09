// render/transform.js — annotated blocks → HTML.
//
// Rendering rules follow the print book's visual language:
//   example  → rule-bounded "EXAMPLE N-k" box: prompt, optional float, then
//              the worked solution (set small and italic in print)
//   problem  → "Problem N-k: title" heading plus the statement
//   solution → hidden in print (\showproblemsolutions is false); collapsed
//              behind the viewer's Show/Hide toggle here rather than dropped
//   capfig / figure → numbered figure floats at the author's relative width
import { renderInline, escapeHtml, mathSpanHtml, texToPlain } from './inline.js';

/**
 * @param {Array} blocks  annotated blocks of one page
 * @param {object} ctx    { page, anchors, warnings, footnotes, unknown,
 *                          mathSpans, assets, figureSrc(asset), name }
 */
export function renderBlocks(blocks, ctx) {
  const out = [];
  for (const block of blocks) out.push(renderBlock(block, ctx));
  return out.filter(Boolean).join('\n');
}

function renderBlock(block, ctx) {
  switch (block.type) {
    case 'p': {
      // A paragraph that was nothing but layout commands (\renewcommand
      // {\arraystretch}{1.5} ahead of a tabular) renders to nothing; do not
      // emit an empty <p> for it.
      const html = renderInline(block.text, ctx);
      return html.trim() ? `<p>${html}</p>` : '';
    }

    case 'displayMath': {
      const span = ctx.mathSpans[block.span];
      if (!(span.rendered ?? span.tex).trim()) return '';
      const id = span.firstLabelId ? ` id="${escapeHtml(span.firstLabelId)}"` : '';
      const extra = (span.allLabelIds ?? [])
        .filter(l => l !== span.firstLabelId)
        .map(l => `<span id="${escapeHtml(l)}" class="visually-hidden"></span>`)
        .join('');
      return `<div class="equation-block"${id}>${extra}${mathSpanHtml(span)}</div>`;
    }

    case 'figure':
      return renderFigure(block, ctx);

    case 'tableFloat':
      return renderTableFloat(block, ctx);

    case 'tabular':
      return renderTabular(block, ctx);

    case 'center':
      return `<div class="center">\n${renderBlocks(block.children, ctx)}\n</div>`;

    case 'centerline':
      return `<div class="centerline">${renderInline(block.text, ctx)}</div>`;

    case 'subheading': {
      const tag = `h${Math.min(block.level, 6)}`;
      return `<${tag} class="subheading">${renderInline(block.title, ctx)}</${tag}>`;
    }

    case 'example':
      return renderExample(block, ctx);

    case 'problem':
      return renderProblem(block, ctx);

    case 'solution':
      // book-viewer.js turns any .solution into a Show/Hide toggle and defers
      // its MathJax typesetting until it is opened — emit the plain container
      // it expects rather than a <details> it would have to unpick.
      return `<div class="solution">\n${renderBlocks(block.children, ctx)}\n</div>`;

    case 'derivation':
      return `<div class="derivation">\n${renderBlocks(block.children, ctx)}\n</div>`;

    case 'list':
      return renderList(block, ctx);

    case 'descList': {
      const items = block.items
        .map(
          it =>
            `<div class="desc-item"><dt>${renderInline(it.label ?? '', ctx)}</dt>` +
            `<dd>${renderBlocks(it.children, ctx)}</dd></div>`
        )
        .join('\n');
      return `<dl class="desc-list">\n${items}\n</dl>`;
    }

    case 'sizeGroup':
      return `<div class="size-${escapeHtml(block.size)}">\n${renderBlocks(block.children, ctx)}\n</div>`;

    case 'quote':
      return `<blockquote>\n${renderBlocks(block.children, ctx)}\n</blockquote>`;

    case 'flushleft':
      return `<div class="flushleft">\n${renderBlocks(block.children, ctx)}\n</div>`;

    case 'flushright':
      return `<div class="flushright">\n${renderBlocks(block.children, ctx)}\n</div>`;

    case 'asset':
      return renderAssetImg(block.idx, ctx, block.scaled);

    default:
      ctx.warnings.push(`${ctx.name}: renderer missing for block type ${block.type}`);
      return '';
  }
}

function renderExample(block, ctx) {
  const head = block.number
    ? `<p class="example-title">Example ${escapeHtml(block.number)}</p>`
    : '';
  const prompt = block.prompt
    ? `<div class="example-prompt">${renderInline(block.prompt, ctx)}</div>`
    : '';
  const float = block.float.length ? renderBlocks(block.float, ctx) : '';
  const id = block.id ? ` id="${escapeHtml(block.id)}"` : '';
  return (
    `<div class="example"${id}>\n${head}${prompt}${float}\n` +
    `<div class="example-body">\n${renderBlocks(block.children, ctx)}\n</div>\n</div>`
  );
}

function renderProblem(block, ctx) {
  const label = block.number ? `Problem ${escapeHtml(block.number)}` : 'Problem';
  const heading = block.heading ? `: ${renderInline(block.heading, ctx)}` : '';
  const id = block.id ? ` id="${escapeHtml(block.id)}"` : '';
  return (
    `<div class="problem"${id}>\n<p class="problem-title">${label}${heading}</p>\n` +
    renderBlocks(block.children, ctx) +
    '\n</div>'
  );
}

function renderList(block, ctx) {
  const tag = block.ordered ? 'ol' : 'ul';
  const attrs = [];
  if (block.ordered) {
    if (block.style && block.style !== 'decimal') attrs.push(`class="list-${block.style}"`);
    if (block.start && block.start > 1) attrs.push(`start="${block.start}"`);
  }
  const items = block.items
    .map(it => {
      const label = it.label ? `<span class="item-label">${renderInline(it.label, ctx)}</span> ` : '';
      return `<li>${label}${renderBlocks(it.children, ctx)}</li>`;
    })
    .join('\n');
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>\n${items}\n</${tag}>`;
}

function renderFigure(block, ctx) {
  const cap =
    block.number || block.caption
      ? `<figcaption>${
          block.number ? `<span class="figure-number">Figure ${escapeHtml(block.number)}</span>` : ''
        }${block.caption ? renderInline(block.caption, ctx) : ''}</figcaption>`
      : '';
  const id = block.id ? ` id="${escapeHtml(block.id)}"` : '';
  // The author sizes every diagram as a fraction of \textwidth; keep that
  // ratio as a max-width so small schematics stay small on wide screens.
  const style = block.width ? ` style="--fig-width:${Math.round(block.width * 100)}%"` : '';
  return (
    `<figure class="figure-float"${id}${style}>\n${renderBlocks(block.children, ctx)}\n${cap}\n</figure>`
  );
}

function renderTableFloat(block, ctx) {
  const id = block.id ? ` id="${escapeHtml(block.id)}"` : '';
  const cap =
    block.number || block.caption
      ? `<figcaption><span class="table-number">Table ${escapeHtml(block.number ?? '')}</span>` +
        `${block.caption ? renderInline(block.caption, ctx) : ''}</figcaption>`
      : '';
  return `<figure class="table-float"${id}>\n${renderBlocks(block.children, ctx)}\n${cap}\n</figure>`;
}

function renderTabular(block, ctx) {
  let col = 0;
  const align = (i, override) => `align-${override ?? block.columns[i] ?? 'left'}`;
  const rows = block.rows
    .map(row => {
      const cells = row.cells
        .map((cell, i) => {
          const cls = align(col, cell.align);
          const span = cell.span > 1 ? ` colspan="${cell.span}"` : '';
          col += cell.span;
          return `<td class="${cls}"${span}>${renderInline(cell.content, ctx)}</td>`;
        })
        .join('');
      col = 0;
      return `<tr${row.topline ? ' class="topline"' : ''}>${cells}</tr>`;
    })
    .join('\n');
  return (
    `<div class="tabular-wrap"><table class="tabular${block.bottomline ? ' bottomline' : ''}">\n` +
    `<tbody>\n${rows}\n</tbody>\n</table>\n</div>`
  );
}

/** An asset placeholder inside inline content (image or verbatim listing). */
export function renderAssetImg(idx, ctx, scaled) {
  const asset = ctx.assets[idx];
  if (!asset) return '';

  if (asset.kind === 'verbatim') {
    return `<pre class="code"><code>${escapeHtml(asset.content.replace(/^\n+|\n+$/g, ''))}</code></pre>`;
  }

  const src = ctx.figureSrc(asset);
  if (!src) {
    return `<div class="figure-missing" data-asset="${escapeHtml(asset.file ?? asset.kind)}"></div>`;
  }
  const cls = scaled ? 'figure-asset scaled' : 'figure-asset';
  return (
    `<img class="${cls}" src="${escapeHtml(src)}" ` +
    `alt="${escapeHtml(asset.alt ?? altFromAsset(asset))}" loading="lazy" />`
  );
}

function altFromAsset(asset) {
  if (!asset.file) return 'figure';
  // figures/BeadOnHoop.png → "Bead On Hoop"
  const base = asset.file.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');
  return base.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || 'figure';
}
