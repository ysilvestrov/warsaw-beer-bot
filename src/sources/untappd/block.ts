export function isBlockStatus(status: number): boolean {
  return status === 403 || status === 429;
}

// Narrow, Cloudflare-specific markers with near-zero overlap with normal
// Untappd content, so a genuine zero-result search page is NOT a block.
const BLOCK_MARKERS = [
  'just a moment',
  'cf-browser-verification',
  'cf-challenge',
  'attention required',
  'enable javascript and cookies to continue',
];

export function isBlockPage(html: string): boolean {
  const h = html.toLowerCase();
  return BLOCK_MARKERS.some((m) => h.includes(m));
}
