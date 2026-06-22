import { buildBeerPageUrl } from '../../sources/untappd/beer-page';
import { escapeHtml } from './html';

/**
 * Render a beer's display name as Telegram HTML. When the beer is matched
 * (untappdId != null) the bold name is wrapped in an anchor to its Untappd
 * page; otherwise it is just bold. The display string is always HTML-escaped.
 */
export const beerNameHtml = (display: string, untappdId: number | null): string =>
  untappdId != null
    ? `<a href="${buildBeerPageUrl(untappdId)}"><b>${escapeHtml(display)}</b></a>`
    : `<b>${escapeHtml(display)}</b>`;
