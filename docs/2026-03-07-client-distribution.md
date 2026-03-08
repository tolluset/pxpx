# Client Distribution Default

## Goal

Keep a fresh source checkout usable without depending on a maintainer-run shared server.

## Decision

- Default the source checkout to the local `y-websocket` server at `ws://127.0.0.1:1234`
- Keep `PIXEL_SERVER_URL` as an explicit override for self-hosted Cloudflare Workers or other remote servers
- Add a Bun compile script so the client can be packaged as a runnable binary
- Add an install script that can install release binaries into a writable directory already on `PATH`
- Add a release packaging script that creates per-platform GitHub release assets

## Result

- Default endpoint for a source checkout: `ws://127.0.0.1:1234`
- Build command: `pnpm build:client`
- Release package command: `pnpm package:client:release`
- Installer entrypoint: `install.sh`
- Installed binary name: `pxboard`
- Runtime repo routing: `pxboard owner/repo`, `pxboard --repo owner/repo`, or `PIXEL_REPO=owner/repo pxboard`
- Remote Worker override:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> pnpm dev:client
```
