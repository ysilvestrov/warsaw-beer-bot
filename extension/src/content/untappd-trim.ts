// Untappd's search page is ~500 KB of boilerplate; the results list is tiny. Parse the
// raw HTML in a detached document (scripts never execute), strip <script>/<style>, and
// keep just the results container so we relay ~10–30 KB to the server's parseSearchPage.
const RESULTS_SELECTORS = ['.results-container', '#results-container', '.search-results'];

export function trimSearchHtml(rawHtml: string): string {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  doc.querySelectorAll('script, style, noscript, link, svg').forEach((n) => n.remove());
  const container =
    RESULTS_SELECTORS.map((sel) => doc.querySelector(sel)).find((n) => n) ?? doc.body;
  return container ? container.outerHTML : rawHtml;
}
