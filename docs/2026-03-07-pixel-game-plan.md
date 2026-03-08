# Pixel Game Implementation Plan

## Source

- Requirement document: `PRD.md`
- Actual file found in repository: `PRD.md`
- Requested filename in chat: `PRD.json` (not present)

## Requirement Interpretation

- Initial implementation interpreted the original text as "one pixel per minute".
- A follow-up product change removed the placement timeout, so clients can now paint without a cooldown.

## Scope

1. Create a pnpm-based terminal app with OpenTUI.
2. Sync the pixel board across multiple clients with Yjs and y-websocket.
3. Support color selection.
4. Keep placement immediate with no cooldown timer.
5. Allow repository-based room routing with `owner/repo` slugs.
6. Restrict painting to GitHub-authenticated users while keeping guest viewers read-only.
7. Show a live paint activity log in the TUI.

## Delivery Shape

- `pnpm dev:server`: starts a local collaboration websocket server.
- `pnpm dev:client`: starts the OpenTUI client.
- README updates with usage and assumptions.

## Result

- Implemented the OpenTUI client in `src/client.tsx`.
- Added a package manifest and TypeScript configuration.
- Verified `pnpm typecheck`.
- Verified runtime launch for both server and client.
- Verified websocket sync connection against `ws://localhost:1234`.
- Verified Yjs propagation by syncing a pixel update between two websocket clients in the same room.
- Updated the client to remove the placement timeout limit.
- Added runtime repo routing via `pxboard owner/repo`, `--repo owner/repo`, and `PIXEL_REPO=owner/repo`.
- Added automatic fallback room detection from the current checkout's GitHub `origin` remote.
- Added worker-verified GitHub edit gating so guests can watch but not paint.
- Added a synced paint activity log rendered in the right panel.
- Added owner-managed repository protected mode with invited-editor allowlists and read-only fallback for unauthorized users.

## Engagement Follow-Up

- Kept the default room on zero cooldown because a global 10-second input lock would slow the board too much.
- Added live presence cues instead: remote player name labels, player-color cursor tinting, and a short recent-paint glow.
- This keeps the fast collaborative rhythm while making other players more visible.
