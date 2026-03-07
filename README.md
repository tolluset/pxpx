# Pixel Game

Terminal pixel board built with OpenTUI and Yjs.

## What Was Implemented

- Shared 16x16 pixel board synced through `y-websocket`
- Unlimited pixel placement without a cooldown
- Keyboard and mouse painting
- Color palette selection
- Cloudflare Durable Object websocket server for deployment

## Commands

```bash
pnpm install
pnpm dev:server
pnpm dev:client
```

Open multiple terminals and run `pnpm dev:client` in each one to verify collaboration.

## Cloudflare Deployment

The repository includes a Cloudflare Worker + Durable Object server that is compatible with the existing `WebsocketProvider` client.

```bash
pnpm install
pnpm deploy:server:cloudflare
```

For local Worker testing:

```bash
pnpm dev:server:cloudflare
```

After deployment, connect clients to the worker URL:

```bash
PIXEL_SERVER_URL=wss://pixel-game-collab.<your-subdomain>.workers.dev pnpm dev:client
```

## Environment Variables

- `PIXEL_SERVER_URL`: defaults to `ws://localhost:1234`
- `PIXEL_ROOM`: defaults to `pixel-game`
- `PIXEL_NAME`: defaults to a random `player-xxxx` name
- `CLOUDFLARE_API_TOKEN`: optional if using token-based Wrangler auth
- `CLOUDFLARE_ACCOUNT_ID`: required with token-based Wrangler auth

## Controls

- `Arrow keys`, `WASD`, or `HJKL`: move cursor
- `Enter` or `Space`: place pixel
- `1-8`: select color
- `Mouse`: move cursor and place pixel
- `Esc` or `Q`: quit

## Note

- `pnpm dev:server` keeps the original local Bun-based websocket server for fast local testing.
- `wrangler.toml` configures the deployable Cloudflare collaboration server.
- Durable Object storage persists the board state between worker restarts.
- The repository does not contain `PRD.json`. Implementation was based on `PRD.md`, then updated to remove the placement timeout limit.
