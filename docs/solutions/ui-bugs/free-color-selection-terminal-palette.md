---
module: Pixel Game
date: 2026-03-08
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Users could only paint with 8 fixed palette colors (keys 1-8)."
  - "No way to enter arbitrary HEX colors for painting."
  - "UI/README controls did not describe any custom color workflow."
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [terminal-ui, color-selection, yjs, input-validation, backward-compatibility]
---

# Free Color Selection for Terminal Palette

## Context
A user requested free color selection because the client only supported fixed palette colors. The feature was implemented and verified with type checks.

## Problem
The terminal client stored pixel color values as palette IDs only (e.g., `rose`, `amber`) and exposed only numeric hotkeys (`1-8`) for selection. This blocked custom color workflows.

## Symptoms
- Painting was limited to predefined palette entries.
- `ColorPalette` UI had no custom input mode.
- Controls text (`README` and in-app sidebar) only documented palette hotkeys.

## Investigation Summary
### What was inspected
- Palette model and selection state in `src/client.tsx`
- Paint write path (`attemptPlacement`) and paint log rendering
- Keyboard event handling (`useKeyboard` + `handleKeyInput`)
- Controls documentation in `README.md`

### Key finding
Color handling was tightly coupled to palette IDs, and there was no input-mode state machine for text-like color entry.

## Root Cause
Selection and rendering logic assumed palette IDs as the only valid color values. The UI lacked an input mode for custom values and lacked HEX validation/normalization.

## Working Solution
### 1. Add HEX normalization and hybrid color resolution
- Added `normalizeHexColor` to validate `#RRGGBB`
- Updated color rendering/labeling helpers to support both:
  - Legacy palette IDs
  - Direct HEX values

### 2. Introduce custom color input mode
- Added state:
  - `selectedColorValue` (palette ID or HEX)
  - `customColorDraft`
  - `isCustomColorInputActive`
- Added key workflow:
  - `C` to enter custom input mode
  - `Enter` to apply valid HEX
  - `Esc` to cancel
  - `Backspace/Delete` for editing

### 3. Keep compatibility and update paint/log paths
- Paint writes now use `selectedColorValue`
- Paint log label/text color rendering supports HEX values
- Presence tint logic normalizes remote HEX values before blending

### 4. Update user-facing guidance
- In-app controls now mention custom input mode
- `README` controls updated with `C` usage and HEX format

## Code References
- `src/client.tsx`:
  - `normalizeHexColor`, `getColorHex`, `getColorLabel`
  - `beginCustomColorInput`, `applyCustomColor`, `appendCustomColorInputCharacter`
  - `handleKeyInput` custom-input branch
  - Sidebar `Custom color` UI block
- `README.md` controls section
- Commit: `4aafde7`

## Verification
- Ran: `pnpm typecheck`
- Result: pass (`typecheck:client`, `typecheck:worker` both succeeded)

## Prevention Strategies
- Treat user color input as modeful state (editing vs normal command mode).
- Keep a single validator/normalizer for all color entry points.
- Preserve backward compatibility by resolving legacy IDs and new HEX formats in shared helpers.
- Update controls/docs in the same change whenever keyboard behavior changes.

## Suggested Regression Checks
1. Palette hotkeys (`1-8`) still select and paint correctly.
2. Valid custom HEX (e.g., `#12abef`) paints and syncs.
3. Invalid input is rejected with user feedback.
4. `Esc` in custom mode cancels without changing selected color.
5. Existing rooms with legacy palette IDs still render correctly.

## Related Links
- Plan: `docs/plans/2026-03-08-feat-free-color-selection-plan.md`
- Commit: `4aafde7`
