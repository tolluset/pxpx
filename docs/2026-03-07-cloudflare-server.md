# Cloudflare Collaboration Server

## Goal

Deploy the collaboration websocket server on Cloudflare while keeping the existing `y-websocket` client protocol unchanged.

## Decision

- Keep the current local development server: `pnpm dev:server`
- Add a deployable Cloudflare Worker entrypoint
- Use a Durable Object per room so all clients in the same room share one Yjs document
- Persist the Yjs document snapshot in Durable Object storage
- Expose GitHub device-login bootstrap endpoints on the same Worker so the terminal client does not need a local OAuth client ID

## Implementation

- Worker entrypoint: `cloudflare/worker.ts`
- Durable Object class: `PixelRoom`
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

## Client Configuration

After deployment, clients should connect with an explicit override because the developer default remains local:

```bash
PIXEL_SERVER_URL=wss://<worker-url> pnpm dev:client
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

## Current Default

The shared gameplay default stays local so `pnpm dev:server` plus `pnpm dev:client` works without guesswork:

```bash
ws://127.0.0.1:1234
```

Remote gameplay still works by setting `PIXEL_SERVER_URL`.
