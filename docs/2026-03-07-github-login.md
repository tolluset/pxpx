# GitHub Login Integration

## Goal

Add GitHub login to the terminal client without requiring end users to manage a local OAuth client ID.

## Decision

- Use GitHub device login because the client runs in a terminal
- Reuse the existing Cloudflare Worker as the auth bootstrap service
- Store only the resolved GitHub identity plus a worker-signed edit token locally, not the GitHub access token
- Upsert authenticated GitHub user profiles into a server-side Durable Object-backed registry
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
- Added server-side GitHub user persistence in the worker-backed registry
- Added worker-signed GitHub session tokens that can be resolved during websocket room joins
- Connected stored GitHub identity to the runtime player name and presence labels in `src/client.tsx`
- Added owner-managed repository access commands that reuse the worker-signed session token

## Result

- A logged-in user now defaults to their GitHub login as the player name
- If the player overrides their name, other users see `name (@github)` in presence labels
- Open rooms still allow guest editing, but repository rooms can be switched into owner-only plus invited-editor protected mode
- The TUI shows whether the current session is using a stored GitHub identity or a guest profile
- Worker-backed logins persist the authenticated GitHub user profile on the server without storing the GitHub access token
- Self-hosted Cloudflare deployments can enable worker-backed login by setting `GITHUB_CLIENT_ID` and `GITHUB_SESSION_SECRET` on the Worker
