// model/numbering.js — chapters/sections → reading-order pages with URLs and
// print-style numbers. Section numbers are "N.M" (chapter.section); the report
// class numbers figures, tables and equations per chapter, and examples and
// problems as "N-k" (\thechapter-\arabic{...}, see the master preamble).
import { slugify } from './slugs.js';
import { texToPlain } from '../render/inline.js';

export function buildModel(structure) {
  const chapters = [];
  const pages = [];

  for (const ch of structure.chapters) {
    const chapter = {
      mode: ch.mode,
      number: ch.number,
      title: ch.title,
      plainTitle: texToPlain(ch.title),
      sections: [],
      file: ch.file,
    };
    chapter.slug = chapterSlug(chapter);
    chapter.url = `/${chapter.slug}/`;
    chapter.displayTitle =
      chapter.mode === 'appendix'
        ? `Appendix ${chapter.number}. ${chapter.plainTitle}`
        : `${chapter.number}. ${chapter.plainTitle}`;

    // Chapter landing page (intro text before the first section).
    pages.push({
      kind: 'chapter',
      permalink: `${chapter.url}index.html`,
      url: chapter.url,
      title: ch.title,
      displayTitle: chapter.displayTitle,
      number: chapter.number,
      chapter,
      tex: ch.introTex,
      name: ch.file,
    });

    // Section pages.
    ch.sections.forEach((sec, k) => {
      const number = `${chapter.number}.${k + 1}`;
      const plainTitle = texToPlain(sec.title);
      const slug = slugify(plainTitle);
      const url = `/${chapter.number.toLowerCase()}-${k + 1}-${slug}/`;
      const section = {
        number,
        index: k + 1,
        title: sec.title,
        plainTitle,
        displayTitle: `${number} ${plainTitle}`,
        url,
        chapter,
        tex: sec.tex,
        name: `${sec.file} §${number}`,
      };
      chapter.sections.push(section);
      pages.push({
        kind: 'section',
        permalink: `${url}index.html`,
        url,
        title: sec.title,
        displayTitle: section.displayTitle,
        number,
        chapter,
        section,
        tex: sec.tex,
        name: section.name,
      });
    });

    chapters.push(chapter);
  }

  return { chapters, pages };
}

function chapterSlug(chapter) {
  const base = slugify(chapter.plainTitle) || 'chapter';
  if (chapter.mode === 'appendix') return `appendix-${chapter.number.toLowerCase()}-${base}`;
  return `${chapter.number}-${base}`;
}
