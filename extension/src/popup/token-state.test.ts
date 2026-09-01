import { describe, expect, it } from 'vitest';
import { applyTokenState, tokenStateView, type TokenStateNodes } from './token-state';

function fixture(): TokenStateNodes & { card: HTMLElement } {
  document.body.innerHTML = `
    <main class="card">
      <header class="head"><h1>Warsaw Beer Overlay</h1></header>
      <button id="syncCheckins" class="btn btn-primary" type="button"><span>Sync my check-ins</span></button>
      <p id="syncStatus" class="status"></p>
      <button id="refresh" class="btn btn-secondary" type="button"><span>Refresh this page</span></button>
      <p id="refreshStatus" class="status"></p>
      <details class="shops"><summary>Supported shops</summary></details>
      <section id="authBlock" class="auth" style="display:none">
        <p id="authNote" class="note"></p>
        <button id="getToken" class="btn btn-secondary" type="button"><span>Get a token</span></button>
      </section>
      <footer class="foot">
        <a id="guideLink" class="guide" style="display:none">Read the setup guide →</a>
        <button id="clearAll" class="btn btn-ghost" type="button"><span>Clear all cache</span></button>
        <p id="clearStatus" class="status status-foot"></p>
      </footer>
    </main>`;
  const q = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  return {
    // Not part of TokenStateNodes (the applier never reads it, #519/#522 review
    // finding 3) — kept here only for the test below that asserts the auth
    // block's position relative to the card itself.
    card: q('.card'),
    header: q('header.head'),
    authBlock: q('#authBlock'),
    syncBtn: q<HTMLButtonElement>('#syncCheckins'),
    syncStatus: q('#syncStatus'),
    getTokenBtn: q<HTMLButtonElement>('#getToken'),
    guideLink: q<HTMLAnchorElement>('#guideLink'),
    foot: q('footer.foot'),
  };
}

describe('tokenStateView', () => {
  it('without a token, the auth block leads and sync cannot be used', () => {
    expect(tokenStateView(false)).toEqual({
      authVisible: true,
      syncTier: 'btn-secondary',
      authTier: 'btn-primary',
      syncEnabled: false,
      syncCaption: 'Add a token to sync your check-ins.',
      guideHome: 'auth',
    });
  });

  it('with a token, sync is the primary action and the guide moves to the footer', () => {
    expect(tokenStateView(true)).toEqual({
      authVisible: false,
      syncTier: 'btn-primary',
      authTier: 'btn-secondary',
      syncEnabled: true,
      syncCaption: '',
      guideHome: 'foot',
    });
  });
});

describe('applyTokenState — no token', () => {
  it('puts the auth block directly after the header, never above it', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(false));
    expect(n.card.firstElementChild).toBe(n.header);
    expect(n.header.nextElementSibling).toBe(n.authBlock);
    expect(n.authBlock.style.display).toBe('');
  });

  it('moves the guide link next to Get a token and shows it', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(false));
    expect(n.authBlock.contains(n.guideLink)).toBe(true);
    expect(n.guideLink.style.display).toBe('');
    // Order, not just containment: `Get a token` is the primary CTA and must
    // stay the first focusable thing in the block — the guide link trails it.
    expect(n.getTokenBtn.nextElementSibling).toBe(n.guideLink);
  });

  it('disables sync, demotes it, and says what is missing', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(false));
    expect(n.syncBtn.disabled).toBe(true);
    expect(n.syncBtn.classList.contains('btn-secondary')).toBe(true);
    expect(n.syncBtn.classList.contains('btn-primary')).toBe(false);
    expect(n.syncStatus.textContent).toBe('Add a token to sync your check-ins.');
  });

  it('promotes Get a token to the primary tier', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(false));
    expect(n.getTokenBtn.classList.contains('btn-primary')).toBe(true);
    expect(n.getTokenBtn.classList.contains('btn-secondary')).toBe(false);
  });
});

describe('applyTokenState — token present', () => {
  it('hides the auth block and keeps the guide link visible in the footer', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(true));
    expect(n.authBlock.style.display).toBe('none');
    expect(n.foot.contains(n.guideLink)).toBe(true);
    expect(n.guideLink.style.display).toBe('');
    // Order, not just containment: the guide link must lead the footer so
    // `Clear all cache` — the destructive control — stays last in tab order.
    expect(n.foot.firstElementChild).toBe(n.guideLink);
  });

  it('leaves sync primary, enabled and uncaptioned', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(true));
    expect(n.syncBtn.disabled).toBe(false);
    expect(n.syncBtn.classList.contains('btn-primary')).toBe(true);
    expect(n.syncStatus.textContent).toBe('');
  });
});

describe('applyTokenState is reversible', () => {
  it('leaves no residue of the no-token state when re-applied with a token', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(false));
    applyTokenState(n, tokenStateView(true));
    expect(n.authBlock.style.display).toBe('none');
    expect(n.foot.contains(n.guideLink)).toBe(true);
    expect(n.guideLink.style.display).toBe('');
    expect(n.syncBtn.disabled).toBe(false);
    expect(n.syncBtn.classList.contains('btn-primary')).toBe(true);
    expect(n.syncBtn.classList.contains('btn-secondary')).toBe(false);
    expect(n.syncStatus.textContent).toBe('');
    expect(n.getTokenBtn.classList.contains('btn-secondary')).toBe(true);
  });

  it('leaves no residue of the token state when re-applied without one', () => {
    const n = fixture();
    applyTokenState(n, tokenStateView(true));
    applyTokenState(n, tokenStateView(false));
    expect(n.header.nextElementSibling).toBe(n.authBlock);
    expect(n.authBlock.contains(n.guideLink)).toBe(true);
    expect(n.syncBtn.disabled).toBe(true);
    expect(n.syncStatus.textContent).toBe('Add a token to sync your check-ins.');
  });
});
