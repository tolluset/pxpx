# Cloudflare Collaboration Server

## Goal

Deploy the collaboration websocket server on Cloudflare while keeping the existing `y-websocket` client protocol unchanged.

## Decision

- Keep the current local development server: `pnpm dev:server`
- Add a deployable Cloudflare Worker entrypoint
- Use a Durable Object per room so all clients in the same room share one Yjs document
- Persist the Yjs document snapshot in Durable Object storage

## Implementation

- Worker entrypoint: `cloudflare/worker.ts`
- Durable Object class: `PixelRoom`
- Wrangler config: `wrangler.toml`
- Scripts:
  - `pnpm dev:server:cloudflare`
  - `pnpm deploy:server:cloudflare`

## Required Credentials

One of the following is needed for deployment:

- `wrangler login`
- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`

## Client Configuration

After deployment, clients should connect with:

```bash
PIXEL_SERVER_URL=wss://<worker-url> pnpm dev:client
```

The room name continues to be controlled by `PIXEL_ROOM`.

## Current Default

The client default was updated to the deployed worker URL so a built client can connect without extra environment setup:

```bash
wss://pixel-game-collab.dlqud19.workers.dev
```
