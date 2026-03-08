# Cloudflare Collaboration Server

## Goal

Deploy the collaboration websocket server on Cloudflare while keeping the existing `y-websocket` client protocol unchanged.

## Decision

- Keep the current local development server: `pnpm dev:server`
- Add a deployable Cloudflare Worker entrypoint
- Use a Durable Object per room so all clients in the same room share one Yjs document
- Persist the Yjs document snapshot in Durable Object storage
- Persist authenticated GitHub user records in a dedicated Durable Object-backed registry
- Expose GitHub device-login bootstrap endpoints on the same Worker so the terminal client does not need a local OAuth client ID

## Implementation

- Worker entrypoint: `cloudflare/worker.ts`
- Durable Object classes:
  - `PixelRoom`
  - `GithubUserRegistry`
- GitHub auth endpoints:
  - `POST /auth/github/device`
  - `POST /auth/github/poll`
- Wrangler config: `wrangler.toml`
- Scripts:
  - `pnpm dev:server:cloudflare`
  - `pnpm deploy:server:cloudflare`

## Required Credentials

One of the following is needed for deployment:

- `wrangler login`
- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`

If you want the Worker to handle `pxboard login`, also set:

- `GITHUB_CLIENT_ID`
- `GITHUB_SESSION_SECRET`

If you want authenticated room reset support, also set:

- `ROOM_RESET_TOKEN`

## Client Configuration

After deployment, clients can use the worker directly because the client default is the deployed worker URL:

```bash
pnpm dev:client
```

Repository-based routing is supported at runtime:

```bash
pnpm dev:client -- owner/repo
pnpm dev:client -- --repo owner/repo
PIXEL_REPO=owner/repo pnpm dev:client
```

Manual room selection continues to work with `--room` or `PIXEL_ROOM`. The Worker preserves slash-separated room names such as `owner/repo`.

GitHub login uses the same Worker host by default:

```bash
pnpm dev:client -- login --server-url ws://127.0.0.1:8787
PIXEL_AUTH_SERVER_URL=wss://<worker-url> pxboard login
```

Room reset is available as an authenticated admin route:

```bash
curl -X POST \
  -H "Authorization: Bearer $ROOM_RESET_TOKEN" \
  https://<worker-url>/admin/rooms/pixel-game/reset
```

Repository rooms also expose owner-only access policy routes:

```bash
curl -H "Authorization: Bearer $WORKER_SESSION_TOKEN" \
  https://<worker-url>/admin/rooms/owner%2Frepo/access
```

For local-only development, keep using the local server with an explicit override:

```bash
pnpm dev:server
PIXEL_SERVER_URL=ws://127.0.0.1:1234 pnpm dev:client
```

## Current Default

The shared gameplay default is the deployed worker:

```bash
wss://pixel-game-collab.dlqud19.workers.dev
```

Guest sessions can paint without logging in, and successful worker-backed logins are recorded in the GitHub user registry Durable Object.
