# Pixel Game

Terminal-native collaborative pixel board built with OpenTUI, React, and Yjs. The client runs in the terminal and can connect either to a local `y-websocket` server or the Cloudflare Worker in this repository.

## What It Supports

- Local-first multiplayer with one websocket server and multiple terminal clients
- Room routing by explicit room name or GitHub `owner/repo` slug
- Live cursors, recent paint activity, short-lived paint highlights, and board growth on the south/east frontier
- Optional GitHub device login for remote sessions, mainly for identity labels
- Standalone binary builds and GitHub release packaging

## Prerequisites

- `pnpm`
- `bun`
- A Cloudflare account only if you want to run your own worker

If `pnpm` is not installed yet:

```bash
corepack enable
corepack prepare pnpm@10.13.1 --activate
```

## Quick Start

Install dependencies:

```bash
pnpm install
```

Start the default local collaboration server:

```bash
pnpm dev:server
```

In another terminal, start the client:

```bash
pnpm dev:client
```

By default the client connects to `ws://127.0.0.1:1234` and joins room `pixel-game`.

Useful local variations:

```bash
pnpm dev:client -- facebook/react
PIXEL_NAME=alice pnpm dev:client
PIXEL_ROOM=design-review pnpm dev:client
```

Run a second client in another terminal to verify real-time sync.

## Install Options

Run directly from a checkout:

```bash
pnpm install
pnpm dev:server
pnpm dev:client
```

Install a local binary from this checkout:

```bash
./install.sh
```

`install.sh` uses `dist/pxboard` if it already exists, otherwise it builds a local binary from source when the checkout has `pnpm`, `bun`, and dependencies available.

Install from GitHub release assets:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | PIXEL_GAME_REPO=<owner>/<repo> sh
```

Release downloads currently require `PIXEL_GAME_REPO` or `--repo` because `install.sh` does not ship with a default repository slug.

## Common Commands

The installed binary is `pxboard`. From a source checkout, the equivalent pattern is `pnpm dev:client -- <args>`.

| Task | Installed binary | From source |
| --- | --- | --- |
| Play the default room | `pxboard` | `pnpm dev:client` |
| Join a repository room | `pxboard facebook/react` | `pnpm dev:client -- facebook/react` |
| Join a named room | `pxboard --room design-review` | `pnpm dev:client -- --room design-review` |
| Override player name | `pxboard --name alice` | `pnpm dev:client -- --name alice` |
| Start GitHub login | `pxboard login` | `pnpm dev:client -- login` |
| Show stored identity | `pxboard whoami` | `pnpm dev:client -- whoami` |
| Clear stored identity | `pxboard logout` | `pnpm dev:client -- logout` |

Other project scripts:

```bash
pnpm build:client
pnpm package:client:release
pnpm dev:server:cloudflare
pnpm deploy:server:cloudflare
pnpm typecheck
```

## Build And Package

Build a standalone binary for the current OS and architecture:

```bash
pnpm build:client
./dist/pxboard facebook/react
```

Package the current platform binary as a GitHub release asset:

```bash
pnpm package:client:release
```

This creates:

- `dist/pxboard`
- `artifacts/pxboard-<os>-<arch>.tar.gz`
- `artifacts/pxboard-<os>-<arch>.tar.gz.sha256`

## GitHub Login

Login is optional for both local and remote sessions. Guests can paint immediately, and logging in mainly affects how your identity is shown to other players.

```bash
pxboard login
pxboard whoami
pxboard logout
```

To use your own auth worker:

```bash
pxboard login --server-url wss://<your-worker-url>
PIXEL_AUTH_SERVER_URL=wss://<your-worker-url> pxboard login
```

If the worker login flow is unavailable, `pxboard login` can fall back to GitHub's device flow when `PIXEL_GITHUB_CLIENT_ID` or `GITHUB_CLIENT_ID` is set locally.

## Cloudflare Worker

This repository includes a Durable Object-backed Yjs collaboration worker in `cloudflare/worker.ts`.

Run the worker locally with Wrangler:

```bash
pnpm dev:server:cloudflare
```

Then point the client at the local worker URL printed by Wrangler. A typical local URL is:

```bash
PIXEL_SERVER_URL=ws://127.0.0.1:8787 pnpm dev:client
```

Deploy your own worker:

```bash
pnpm deploy:server:cloudflare
```

Authenticate Wrangler with either `pnpm exec wrangler login` or `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`.

To enable worker-backed GitHub login on your worker:

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_SESSION_SECRET
```

Then connect clients to the deployed worker:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> pnpm dev:client
PIXEL_SERVER_URL=wss://<your-worker-url> pxboard facebook/react
```

## Environment Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PIXEL_SERVER_URL` | Gameplay websocket server URL | `ws://127.0.0.1:1234` |
| `PIXEL_AUTH_SERVER_URL` | GitHub login worker URL | `wss://pixel-game-collab.dlqud19.workers.dev` |
| `PIXEL_ROOM` | Explicit room name | `pixel-game` |
| `PIXEL_REPO` | Repository slug alias for the room | none |
| `PIXEL_NAME` | Player label override | stored GitHub login or random `player-xxxx` |
| `PIXEL_GITHUB_CLIENT_ID` | Direct GitHub device-login fallback | none |
| `GITHUB_CLIENT_ID` | Same fallback, alternate name | none |
| `GITHUB_SESSION_SECRET` | Worker-side HMAC secret for signed GitHub sessions | none |

Room selection precedence:

1. `--room`
2. Positional `owner/repo`
3. `--repo`
4. `PIXEL_ROOM`
5. `PIXEL_REPO`
6. `pixel-game`

## Controls

- `Arrow keys`, `WASD`, or `HJKL`: move the cursor
- `Enter`, `Space`, or left click: paint when editing is allowed
- `1-8`: select a color
- `Esc` or `Q`: quit

Painting or pushing beyond the south or east edge grows the shared board by `8` cells in that direction.

## Related Docs

- [Client distribution notes](docs/2026-03-07-client-distribution.md)
- [Cloudflare server notes](docs/2026-03-07-cloudflare-server.md)
- [GitHub login notes](docs/2026-03-07-github-login.md)
- [Project plan](docs/2026-03-07-pixel-game-plan.md)
