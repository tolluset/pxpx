# Client Distribution Default

## Goal

Make the client runnable without requiring users to set `PIXEL_SERVER_URL` manually.

## Decision

- Hardcode the deployed Cloudflare websocket URL as the default client endpoint
- Keep `PIXEL_SERVER_URL` as an override for local development or future migrations
- Add a Bun compile script so the client can be packaged as a runnable binary

## Result

- Default endpoint: `wss://pixel-game-collab.dlqud19.workers.dev`
- Build command: `pnpm build:client`
- Local server override:

```bash
PIXEL_SERVER_URL=ws://localhost:1234 pnpm dev:client
```
