# GitHub Login Integration

## Goal

Add GitHub login to the terminal client without requiring end users to manage a local OAuth client ID.

## Decision

- Use GitHub device login because the client runs in a terminal
- Reuse the existing Cloudflare Worker as the auth bootstrap service
- Store only the resolved GitHub identity plus a worker-signed edit token locally, not the GitHub access token
- Fall back to direct GitHub device flow only when a local `GITHUB_CLIENT_ID` or `PIXEL_GITHUB_CLIENT_ID` is present for development

## Implementation

- Added local session helpers in `src/github-auth.ts`
- Added CLI commands:
  - `pxboard login`
  - `pxboard whoami`
  - `pxboard logout`
- Added Worker endpoints:
  - `POST /auth/github/device`
  - `POST /auth/github/poll`
- Added worker-signed GitHub session tokens that can be resolved during websocket room joins
- Connected stored GitHub identity to the runtime player name and presence labels in `src/client.tsx`

## Result

- A logged-in user now defaults to their GitHub login as the player name
- If the player overrides their name, other users see `name (@github)` in presence labels
- Guests and logged-in users can both paint
- The TUI shows whether the current session is using a stored GitHub identity or a guest profile
- Self-hosted Cloudflare deployments can enable worker-backed login by setting `GITHUB_CLIENT_ID` and `GITHUB_SESSION_SECRET` on the Worker
