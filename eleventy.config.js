// GitHub Pages serves this project site under /classicalMechanics/. Vercel
// serves it at a domain root, so it must build with no path prefix — detected
// via the VERCEL env var that Vercel sets automatically.
const PATH_PREFIX = process.env.VERCEL ? '/' : '/classicalMechanics/';

export default function (eleventyConfig) {
  eleventyConfig.setUseGitIgnore(false);

  eleventyConfig.addWatchTarget('./tex/');
  eleventyConfig.addWatchTarget('./lib/');

  eleventyConfig.addTransform('pathPrefix', function (content) {
    const out = this.page && this.page.outputPath;
    if (typeof out !== 'string' || !out.endsWith('.html')) return content;
    const prefix = PATH_PREFIX.replace(/\/+$/, '');
    if (!prefix) return content;
    return content.replace(
      /(\s(?:href|src)=)"(\/(?!\/)[^"]*)"/g,
      (_, pre, url) => `${pre}"${prefix}${url}"`
    );
  });

  eleventyConfig.addFilter('trimSlash', v => String(v).replace(/\/+$/, ''));

  eleventyConfig.addPassthroughCopy({ assets: 'assets' });
  // Every figure in this book is a raster the author committed next to the
  // LaTeX; there is nothing to compile, so serve tex/figures/ as /figures/.
  eleventyConfig.addPassthroughCopy({ 'tex/figures': 'figures' });
  eleventyConfig.addPassthroughCopy({ 'assets/pwa/offline.html': 'offline.html' });

  eleventyConfig.setServerPassthroughCopyBehavior('passthrough');

  return {
    dir: {
      input: '.',
      includes: '_includes',
      layouts: '_includes/layouts',
      data: '_data',
    },
    templateFormats: ['njk'],
    htmlTemplateEngine: 'njk',
    pathPrefix: PATH_PREFIX,
  };
};
