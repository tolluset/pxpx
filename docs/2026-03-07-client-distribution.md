# Client Distribution Default

## Goal

Keep the default developer runtime predictable without requiring users to set `PIXEL_SERVER_URL` manually.

## Decision

- Hardcode the local websocket URL as the default client endpoint for development
- Keep `PIXEL_SERVER_URL` as an override for Cloudflare deployments or future migrations
- Add a Bun compile script so the client can be packaged as a runnable binary
- Add an install script that can install release binaries into a writable directory already on `PATH`
- Add a release packaging script that creates per-platform GitHub release assets

## Result

- Default endpoint: `ws://127.0.0.1:1234`
- Build command: `pnpm build:client`
- Release package command: `pnpm package:client:release`
- Installer entrypoint: `install.sh`
- Installed binary name: `pxboard`
- Runtime repo routing: `pxboard owner/repo`, `pxboard --repo owner/repo`, or `PIXEL_REPO=owner/repo pxboard`
- Local server override:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> pnpm dev:client
```
