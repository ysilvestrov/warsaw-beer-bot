# Release Notes - Warsaw Beer Overlay v0.22.0

**Release Date:** October 28, 2026  
**Version:** 0.22.0  

## Summary of Changes

### 1. Direct & Secure Untappd Login (Zero-Credential Policy)
- **Eliminated all password fields:** Single Sign-On (SSO) directly through your existing, active browser session on `untappd.com`.
- **Zero credential risk:** The extension never asks for, captures, transmits, or stores user passwords or credentials.
- **Direct Login Shortcut:** Dedicated button to open official `https://untappd.com/login` in a new browser tab for safe authentication on Untappd's own origin (with CAPTCHA, 2FA, and full domain security).
- **Profile Display:** Displays full user profile card upon login: avatar, display name, handle (`@username`), total check-ins, and unique beers count.

### 2. Complete Removal of Third-Party Servers (100% Serverless Extension)
- Fully eliminated dependencies on third-party backend proxies and servers (`beer-api.ysilvestrov-ai.uk`).
- The extension now interacts **strictly and exclusively** with `untappd.com` and Untappd's official Algolia search index.
- Absolute privacy: no intermediate server stores or sees your personal check-ins, tokens, or credentials.

### 3. Local Browser Database (IndexedDB)
- Implemented a complete client-side database subsystem using `IndexedDB` (`wbb_local_db`):
  - `user_had`: Stores all personal tried beers, user ratings, and check-in counts.
  - `beers_catalog`: Local catalog of known Untappd beers, styles, global ratings, and ABVs.
  - `card_matches`: Fast key-value index matching online store beer titles to Untappd beer IDs (`bid`).
- Matching logic runs entirely locally in the browser: instant badge display without unnecessary network hops, minimizing Untappd API usage and avoiding rate limits.

### 4. Direct In-Browser Check-in & Distinct Beers Synchronization
- Background synchronizer directly syncing your Untappd profile distinct beers and check-in history into your local IndexedDB storage.
- Synchronizes full distinct history via `/user/<username>/beers` and `/profile/more_beer/<username>/<offset>`, bypassing Untappd's free tier activity feed truncation limit (~2,255 checkins) and ensuring 100% of all unique beers (e.g. all 2,809) are loaded into your local DB.
- Real-time progress indicators in the extension popup with resume and cancellation support.

### 5. Verification & Testing
- 100% test coverage across all components: 44 test suites, 782 automated tests passing.
