# #523 — shared extension chrome for popup and options

Date: 2026-09-01
Status: agreed
Issue: #523 (options page repeats the popup's two-typeface and contrast defects)

## Problem

The popup already corrected the browser default that rendered button labels in UA Arial while the
rest of the extension used the system font. The options page still declares its own unrelated
button, focus, colour, and typography rules, so the same defect survives there and the two extension
surfaces can drift again.

The options page also keeps the light palette in dark browser themes, gives Save and Test connection
the same visual rank, and uses the old amber fill (`#d9822b`) with white text. That pair is only
2.9:1 in the default state and 3.6:1 on hover, below WCAG AA for normal text.

## Design

Create `extension/src/shared/extension-ui.css` as the single visual foundation for extension-owned
pages. It owns:

- light and dark colour tokens;
- the system-font inheritance reset for interactive controls;
- visible `:focus-visible` treatment;
- primary and secondary button tiers, including hover, active, disabled, and reduced-motion states.

Both popup and options import that stylesheet. Popup-specific layout, ghost actions, icons, status,
and shop-list styles remain in `popup.css`; options-specific card, form, and responsive layout remain
in `options.css`. Host-page overlays do not import these tokens.

On the options page, Save is the primary action and Test connection is secondary. Existing IDs,
copy, event wiring, data flow, and information architecture remain unchanged. The generic local class
names `.row` and `.status` become `.actions` and `.options-status` so their meanings cannot collide
with the shared or popup styles.

## Visual rules

- Light primary actions use `#ab6217` with white text; dark mode uses brand amber `#d9822b` with a
  dark label.
- Keyboard focus uses a two-pixel, offset ring with at least 3:1 contrast against its background.
- Form controls and buttons inherit the page's system font.
- Options uses 26 px for its page title and 13 px for supporting labels/status, giving the detector's
  required 2:1 type hierarchy.
- At widths up to 420 px, action buttons stack and fill the card width.

## Deliberately not in scope

- No text, IDs, TypeScript behavior, permissions, or storage changes.
- No redesign of the popup or host-page overlays.
- No new dependency, component framework, icon, animation, or theme switch.

## Verification

- Run Impeccable's full detector on the options page and require zero findings.
- Render options at wide and narrow widths in Chromium under light and dark colour schemes; confirm
  the card does not overflow, buttons use the system font, focus is visible, and action hierarchy is
  clear.
- Render the popup in light and dark themes to confirm the extraction preserves its appearance.
- Run the full extension test suite, TypeScript typecheck, production build, and `git diff --check`.
