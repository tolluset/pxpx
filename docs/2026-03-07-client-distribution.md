# Client Distribution Default

## Goal

Keep the default runtime usable for end users without requiring them to start a local server or set `PIXEL_SERVER_URL` manually.

## Decision

- Hardcode the deployed Cloudflare Worker URL as the default client endpoint
- Keep `PIXEL_SERVER_URL` as an override for local development or future migrations
- Add a Bun compile script so the client can be packaged as a runnable binary
- Add an install script that can install release binaries into a writable directory already on `PATH`
- Add a release packaging script that creates per-platform GitHub release assets

## Result

- Default endpoint: `wss://pixel-game-collab.dlqud19.workers.dev`
- Build command: `pnpm build:client`
- Release package command: `pnpm package:client:release`
- Installer entrypoint: `install.sh`
- Installed binary name: `pxboard`
- Runtime repo routing: `pxboard owner/repo`, `pxboard --repo owner/repo`, or `PIXEL_REPO=owner/repo pxboard`
- Local server override:

```bash
PIXEL_SERVER_URL=ws://127.0.0.1:1234 pnpm dev:client
```
