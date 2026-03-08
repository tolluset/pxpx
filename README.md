# Pixel Game

Terminal-native collaborative pixel board built with OpenTUI, React, and Yjs. The client runs in the terminal and can connect either to a local `y-websocket` server or the Cloudflare Worker in this repository.

For a simpler Korean overview for presentations, see [README.ko.md](./README.ko.md).

## What It Supports

- Remote-first multiplayer via Cloudflare Worker, with an optional local `y-websocket` server for development
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

Start the client:

```bash
pnpm dev:client
```

By default the client connects to `wss://pixel-game-collab.dlqud19.workers.dev` and joins room `pixel-game`. No local server is required.

Useful remote variations:

```bash
pnpm dev:client -- facebook/react
PIXEL_NAME=alice pnpm dev:client
PIXEL_ROOM=design-review pnpm dev:client
```

Run a second client in another terminal to verify real-time sync.

For local-only development, start the local collaboration server and override the endpoint:

```bash
pnpm dev:server
PIXEL_SERVER_URL=ws://127.0.0.1:1234 pnpm dev:client
```

## Install Options

Run directly from a checkout:

```bash
pnpm install
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
| Show repo access policy | `pxboard access status owner/repo` | `pnpm dev:client -- access status owner/repo` |
| Enable protected mode | `pxboard access enable owner/repo` | `pnpm dev:client -- access enable owner/repo` |
| Grant an editor | `pxboard access grant owner/repo alice` | `pnpm dev:client -- access grant owner/repo alice` |

Other project scripts:

```bash
pnpm build:client
pnpm package:client:release
pnpm dev:server:cloudflare
pnpm deploy:server:cloudflare
pnpm typegen:worker
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

Login is optional for open rooms. For repository rooms that have protected mode enabled, the owner and invited editors can paint while everyone else stays read-only.

```bash
pxboard login
pxboard whoami
pxboard logout
pxboard access status owner/repo
pxboard access enable owner/repo
pxboard access grant owner/repo alice
pxboard access revoke owner/repo alice
```

To use your own auth worker:

```bash
pxboard login --server-url wss://<your-worker-url>
PIXEL_AUTH_SERVER_URL=wss://<your-worker-url> pxboard login
```

If the worker login flow is unavailable, `pxboard login` can fall back to GitHub's device flow when `PIXEL_GITHUB_CLIENT_ID` or `GITHUB_CLIENT_ID` is set locally.

Successful worker-backed logins also upsert the GitHub user profile into a server-side Durable Object-backed registry. The worker still does not store GitHub access tokens.

Repository access management commands require a worker-backed login because they depend on the worker-signed session token.

## Cloudflare Worker

This repository includes a Durable Object-backed Yjs collaboration worker in `cloudflare/worker.ts`.

Repository rooms also support an owner-managed protected mode. When enabled, editing is limited to the repository owner plus the invited editor list stored in the room Durable Object.

If you change `wrangler.toml` bindings, regenerate the worker runtime declarations before typechecking:

```bash
pnpm typegen:worker
```

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
pnpm exec wrangler secret put ROOM_RESET_TOKEN
```

Then connect clients to the deployed worker:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> pnpm dev:client
PIXEL_SERVER_URL=wss://<your-worker-url> pxboard facebook/react
```

To reset a room back to an empty 16x16 board:

```bash
curl -X POST \
  -H "Authorization: Bearer $ROOM_RESET_TOKEN" \
  https://<your-worker-url>/admin/rooms/pixel-game/reset
```

## Environment Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PIXEL_SERVER_URL` | Gameplay websocket server URL | `wss://pixel-game-collab.dlqud19.workers.dev` |
| `PIXEL_AUTH_SERVER_URL` | GitHub login worker URL | `wss://pixel-game-collab.dlqud19.workers.dev` |
| `PIXEL_ROOM` | Explicit room name | `pixel-game` |
| `PIXEL_REPO` | Repository slug alias for the room | none |
| `PIXEL_NAME` | Player label override | stored GitHub login or random `player-xxxx` |
| `PIXEL_GITHUB_CLIENT_ID` | Direct GitHub device-login fallback | none |
| `GITHUB_CLIENT_ID` | Same fallback, alternate name | none |
| `GITHUB_SESSION_SECRET` | Worker-side HMAC secret for signed GitHub sessions | none |
| `ROOM_RESET_TOKEN` | Worker-side bearer token for room reset operations | none |

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
- `X`: clear the current cell when editing is allowed
- `1-8`: select a palette color
- `C`: open custom color input mode (`#RRGGBB`, `Enter` to apply, `Esc` to cancel)
- `Esc` or `Q`: quit

Painting or pushing beyond the south or east edge grows the shared board by `8` cells in that direction.

## Related Docs

- [Client distribution notes](docs/2026-03-07-client-distribution.md)
- [Cloudflare server notes](docs/2026-03-07-cloudflare-server.md)
- [GitHub login notes](docs/2026-03-07-github-login.md)
- [Repository access control notes](docs/2026-03-08-repo-access-control.md)
- [SSH gateway spec](docs/2026-03-08-ssh-gateway-spec.md)
- [Project plan](docs/2026-03-07-pixel-game-plan.md)
