# Shared Extension Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the options page the popup's accessible typography, themes, focus treatment, and action hierarchy while extracting one shared extension-owned design-token layer.

**Architecture:** A new CSS file owns cross-surface tokens and button primitives. Popup and options keep only their surface-specific layout and import the shared foundation, so no JavaScript contract or host-page styling boundary changes.

**Tech Stack:** HTML, CSS, Vite, Vitest, Playwright/Chromium, Impeccable detector.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-01-523-options-design-tokens-design.md`

## Global Constraints

- Preserve all existing options and popup copy, IDs, event wiring, and data behavior.
- Keep host-page overlays isolated from extension-owned page styles.
- Introduce no dependency or frontend framework.
- Update `spec.md`, `extension/CHANGELOG.md`, and `docs/extension-install-uk.md` in the same change.
- Validate light, dark, narrow, keyboard-focus, and popup-regression states in a real browser.

---

### Task 1: Extract the shared visual foundation

**Files:**
- Create: `extension/src/shared/extension-ui.css`
- Modify: `extension/src/popup/popup.css`

**Interfaces:**
- Consumes: the popup's existing colour tokens, focus rule, font reset, and `.btn` tiers.
- Produces: shared CSS custom properties plus `.btn`, `.btn-primary`, and `.btn-secondary` primitives imported by both extension pages.

- [x] **Step 1: Capture the popup baseline**

Render `extension/src/popup/popup.html` in Chromium in light and dark colour schemes. Record the
computed body/button fonts, primary button colours, focus outline, and card width.

- [x] **Step 2: Add the shared stylesheet**

Move the popup's light/dark tokens, control font inheritance, selection, focus-visible, button tiers,
disabled treatment, and reduced-motion button rule to `extension/src/shared/extension-ui.css`.

- [x] **Step 3: Import shared CSS and remove duplicates**

Add this first line to `popup.css`:

```css
@import "../shared/extension-ui.css";
```

Keep only popup layout, full-width placement, icon, ghost-action, status, auth, and shops styles in
that file.

- [x] **Step 4: Verify popup parity**

Render the popup again in both colour schemes and compare the recorded computed styles and layout.
Expected: font, primary/secondary button presentation, card width, and focus treatment are unchanged.

### Task 2: Restyle options with the shared system

**Files:**
- Modify: `extension/src/options/options.html`
- Modify: `extension/src/options/options.css`

**Interfaces:**
- Consumes: shared tokens and button classes from `extension-ui.css`.
- Produces: Save as `.btn.btn-primary`, Test connection as `.btn.btn-secondary`, responsive `.actions`, and isolated `.options-status` styling.

- [x] **Step 1: Capture the failing visual state**

Render options in Chromium and verify the current failure: the page stays light in dark mode, buttons
use UA Arial, both actions have the same tier, and the light primary contrast is below AA.

- [x] **Step 2: Apply the shared classes without changing behavior**

Keep IDs `save`, `test`, and `status`. Rename only the styling hooks and add the shared button tiers:

```html
<div class="actions">
  <button id="save" class="btn btn-primary" type="button">Save</button>
  <button id="test" class="btn btn-secondary" type="button">Test connection</button>
</div>
<p id="status" class="options-status" aria-live="polite"></p>
```

- [x] **Step 3: Add options-specific responsive form layout**

Import the shared stylesheet, use theme tokens for the page/card/inputs, establish the 26/14/13 px
type hierarchy, and stack actions below 420 px.

- [x] **Step 4: Run detector and browser validation**

Run Impeccable against `options.html`; expected: zero findings. Render 900 px light/dark and 360 px
narrow cases in Chromium; expected: no horizontal overflow, coherent themes, visible focus, system
font controls, and full-width stacked narrow actions.

### Task 3: Document and verify the change

**Files:**
- Modify: `extension/CHANGELOG.md`
- Modify: `docs/extension-install-uk.md`
- Modify: `spec.md`

**Interfaces:**
- Consumes: the approved #523 design and completed UI behavior.
- Produces: user-facing release/install notes and the OpenSpec source-of-truth statement.

- [x] **Step 1: Update documentation**

Describe the shared visual foundation, action ranking, theme support, font consistency, focus, and
contrast. Do not claim any options behavior or copy change.

- [x] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 38 test files and 601 tests pass; typecheck, build, and diff check exit 0. No new CSS-only
source assertion is added because it would couple tests to class names rather than user behavior;
the detector and Chromium renders cover this visual-only change.

- [x] **Step 3: Review scope**

Confirm the diff contains only shared/popup/options styles and markup plus the required changelog,
install guide, spec, design, and plan documentation.
