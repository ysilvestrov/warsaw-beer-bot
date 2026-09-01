// #519/#522: the popup's hierarchy is a function of one fact — whether a token
// exists. Without one, `Sync my check-ins` cannot succeed (the background finds
// no token, stores outcome:'error' and the popup prints a connection error),
// and it would first raise a host-permission prompt for untappd.com on the way
// there. So in that state it is demoted, disabled and captioned, while the two
// controls that CAN help — `Get a token` and the setup guide — lead the card.

export interface TokenStateView {
  /** The auth block is shown, directly after the header. Only ever true without a token. */
  authVisible: boolean;
  syncTier: 'btn-primary' | 'btn-secondary';
  authTier: 'btn-primary' | 'btn-secondary';
  syncEnabled: boolean;
  /** Empty when the sync button is enabled — the caption belongs to whoever last clicked. */
  syncCaption: string;
  /** Where the setup-guide link lives. It is visible in both states (#522). */
  guideHome: 'auth' | 'foot';
}

export interface TokenStateNodes {
  header: HTMLElement;
  authBlock: HTMLElement;
  syncBtn: HTMLButtonElement;
  syncStatus: HTMLElement;
  getTokenBtn: HTMLButtonElement;
  guideLink: HTMLAnchorElement;
  foot: HTMLElement;
}

export function tokenStateView(hasToken: boolean): TokenStateView {
  return hasToken
    ? {
        authVisible: false,
        syncTier: 'btn-primary',
        authTier: 'btn-secondary',
        syncEnabled: true,
        syncCaption: '',
        guideHome: 'foot',
      }
    : {
        authVisible: true,
        syncTier: 'btn-secondary',
        authTier: 'btn-primary',
        syncEnabled: false,
        syncCaption: 'Add a token to sync your check-ins.',
        guideHome: 'auth',
      };
}

function setTier(btn: HTMLElement, tier: 'btn-primary' | 'btn-secondary'): void {
  btn.classList.remove('btn-primary', 'btn-secondary');
  btn.classList.add(tier);
}

/** The only code that writes a TokenStateView into the DOM. It never reads state back out. */
export function applyTokenState(nodes: TokenStateNodes, view: TokenStateView): void {
  // The guide link moves before the block does, so it travels with the block.
  const guideHost = view.guideHome === 'auth' ? nodes.authBlock : nodes.foot;
  if (view.guideHome === 'foot') guideHost.prepend(nodes.guideLink);
  else guideHost.append(nodes.guideLink);
  nodes.guideLink.style.display = '';

  if (view.authVisible) {
    nodes.header.after(nodes.authBlock);
    nodes.authBlock.style.display = '';
  } else {
    nodes.authBlock.style.display = 'none';
  }

  setTier(nodes.syncBtn, view.syncTier);
  setTier(nodes.getTokenBtn, view.authTier);
  nodes.syncBtn.disabled = !view.syncEnabled;
  nodes.syncStatus.textContent = view.syncCaption;
}
