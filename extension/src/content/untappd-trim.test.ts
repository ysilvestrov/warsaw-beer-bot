import { describe, it, expect } from 'vitest';
import { trimSearchHtml } from './untappd-trim';

const raw = `<!doctype html><html><head><style>.x{}</style></head>
<body>
  <nav>huge nav</nav>
  <div class="results-container">
    <div class="beer-item"><p class="name"><a href="/b/x/5001">Beer A</a></p></div>
    <script>tracking()</script>
  </div>
  <footer>huge footer</footer>
  <script>more()</script>
</body></html>`;

describe('trimSearchHtml', () => {
  it('keeps only the results container and drops scripts/styles', () => {
    const out = trimSearchHtml(raw);
    expect(out).toContain('/b/x/5001');
    expect(out).toContain('Beer A');
    expect(out).not.toContain('huge nav');
    expect(out).not.toContain('huge footer');
    expect(out).not.toContain('tracking()');
    expect(out).not.toContain('.x{}');
    expect(out.length).toBeLessThan(raw.length);
  });

  it('falls back to the body (sans scripts/styles) when no results container is present', () => {
    const out = trimSearchHtml('<html><body><div class="beer-item">x</div><script>y()</script></body></html>');
    expect(out).toContain('beer-item');
    expect(out).not.toContain('y()');
  });
});
