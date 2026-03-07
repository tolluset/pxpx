# Pixel Game

OpenTUI, React, and Yjs-based terminal pixel board. The client runs in the terminal, and collaboration sync works through `y-websocket` protocol servers, including the Cloudflare Worker in this repo.

## Start Here

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/tolluset/pxboard/main/install.sh | PIXEL_GAME_REPO=tolluset/pxboard sh
```

Once `install.sh` ships with `DEFAULT_REPO=tolluset/pxboard`, this becomes:

```bash
curl -fsSL https://raw.githubusercontent.com/tolluset/pxboard/main/install.sh | sh
```

### 2. Run

The default gameplay runtime is local-first:

```bash
pnpm dev:server
pnpm dev:client
```

Without any environment overrides, the client connects to `ws://127.0.0.1:1234` and joins room `pixel-game`.

If you want a remote collaboration server instead of the local default:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> pxboard facebook/react
```

### 3. Optional: Sign In With GitHub

```bash
pxboard login
pxboard whoami
```

The default Cloudflare Worker can broker the GitHub device flow, so end users do not need to set a local OAuth client ID.

### From A Repo Checkout

If you cloned this repository and want the same install flow:

```bash
./install.sh
```

### Development Only

If you just want to run the local multiplayer workflow from source:

```bash
pnpm install
pnpm dev:server
pnpm dev:client
```

## What You Can Do

- Run one local `y-websocket` server plus multiple terminal clients with no extra environment setup
- Run a local `y-websocket` server for development
- Deploy your own Cloudflare Worker + Durable Object collaboration server
- Sign in from the terminal with GitHub device login
- Use `PIXEL_ROOM`, `PIXEL_NAME`, or an explicit `owner/repo` selector when you need a different local session
- Paint only after GitHub login is verified by the collaboration worker
- Build the client into a standalone binary for the current platform
- Track live remote cursors directly on the board
- See freshly painted cells glow for a short moment
- Review a live paint activity list on the right side of the TUI
- Grow the shared canvas by painting the south or east frontier

## Prerequisites

- `pnpm` for dependency management
- `bun` for running and compiling the terminal client
- A Cloudflare account if you want to deploy your own collaboration server

If `pnpm` is not installed yet:

```bash
corepack enable
corepack prepare pnpm@10.13.1 --activate
```

## Install

```bash
pnpm install
```

To install a checked-out copy into a writable directory on your `PATH`:

```bash
./install.sh
```

## User Install

If you publish GitHub release assets, users can install the app without `bun` or `pnpm`:

```bash
curl -fsSL https://raw.githubusercontent.com/tolluset/pxboard/main/install.sh | PIXEL_GAME_REPO=tolluset/pxboard sh
```

The installer uses a writable directory already in your `PATH` when possible, so `pxboard ...` works immediately after install.

The intended published repository slug is `tolluset/pxboard`. After `install.sh` is published with `DEFAULT_REPO=tolluset/pxboard`, users can omit `PIXEL_GAME_REPO=tolluset/pxboard` and install with:

```bash
curl -fsSL https://raw.githubusercontent.com/tolluset/pxboard/main/install.sh | sh
```

Run it with:

```bash
pxboard facebook/react
```

Route a session by GitHub repository:

```bash
pxboard facebook/react
```

If you are using your own collaboration server:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> pxboard facebook/react
```

## Quick Start

The default developer workflow is one local websocket server plus one or more terminal clients.

```bash
pnpm dev:server
```

In another terminal:

```bash
pnpm dev:client
```

With no environment overrides, `pnpm dev:client` connects to `ws://127.0.0.1:1234` and joins room `pixel-game`.

Run the client again in a second terminal to verify shared-room sync:

```bash
pnpm dev:client
```

If the websocket server is unavailable, the terminal UI stays up and shows `Connecting` or `Reconnecting` status in the sidebar and footer instead of failing silently.

Join a repository room from source:

```bash
pnpm dev:client -- facebook/react
```

Run the same command in multiple terminals to verify real-time sync. If you want a fixed player name:

```bash
PIXEL_NAME=alice pnpm dev:client
```

If you want GitHub identity as your default player name:

```bash
pnpm dev:client -- login
pnpm dev:client -- whoami
```

## Local Development

### 1. Default Local Runtime

```bash
pnpm dev:server
```

Then connect the client with the built-in defaults:

```bash
pnpm dev:client
```

### 2. Room And Name Overrides

```bash
PIXEL_ROOM=design-review pnpm dev:client
PIXEL_NAME=alice pnpm dev:client
pnpm dev:client -- facebook/react
```

If you are pointing at a different websocket server:

```bash
PIXEL_SERVER_URL=ws://127.0.0.1:8787 pnpm dev:client
```

### 3. Local Cloudflare Worker

Run the Worker locally with Wrangler:

```bash
pnpm dev:server:cloudflare
```

Then connect the client to the local Worker:

```bash
PIXEL_SERVER_URL=ws://127.0.0.1:8787 pnpm dev:client
```

## Build A Standalone Binary

Build the client for the current OS and CPU architecture:

```bash
pnpm build:client
```

Run the compiled binary:

```bash
./dist/pxboard facebook/react
```

You can still override the collaboration server at runtime:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> ./dist/pxboard facebook/react
```

## Publish Release Assets

Package the current platform build as a GitHub release asset:

```bash
pnpm package:client:release
```

This creates:

- `artifacts/pxboard-<os>-<arch>.tar.gz`
- `artifacts/pxboard-<os>-<arch>.tar.gz.sha256`

Upload the `.tar.gz` file to the GitHub release for the target tag. The install script expects the asset name format above.

## GitHub Login

The terminal client supports GitHub device login.

```bash
pxboard login
pxboard whoami
pxboard logout
```

By default, `pxboard login` talks to the default Cloudflare Worker over HTTPS. If you deploy your own worker, point login at it:

```bash
pxboard login --server-url wss://<your-worker-url>
PIXEL_AUTH_SERVER_URL=wss://<your-worker-url> pxboard login
```

When a stored GitHub session exists, the client uses your GitHub login as the default player name unless you override it with `--name` or `PIXEL_NAME`.

Editing is locked to verified GitHub sessions. Guests can still connect and watch the board, but only logged-in users can paint. The terminal UI also shows a live paint log in the right panel.

## Deploy Your Own Cloudflare Server

This repo includes a Cloudflare Worker with a Durable Object-backed Yjs room server.

### 1. Authenticate Wrangler

Use one of the following approaches:

- `pnpm exec wrangler login`
- Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`

### 2. Configure GitHub Login And Edit Verification

If you want `pxboard login` to use your own Worker and unlock painting for logged-in users, register a GitHub OAuth App and store both secrets in the Worker:

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_SESSION_SECRET
```

### 3. Deploy

```bash
pnpm deploy:server:cloudflare
```

Wrangler will print the deployed Worker URL. Use that host as your websocket endpoint.

### 4. Point The Client To Your Deployment

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> pnpm dev:client
```

Or with the compiled binary:

```bash
PIXEL_SERVER_URL=wss://<your-worker-url> ./dist/pxboard facebook/react
```

## Repository Rooms

Use a GitHub slug to route everyone working on the same repository into the same room:

```bash
pxboard facebook/react
PIXEL_REPO=facebook/react pxboard
```

The slug is normalized to lowercase and used as the room key. Manual room selection still works:

```bash
pxboard --room design-review
PIXEL_ROOM=design-review pxboard
```

If no room override is provided, the default room is `pixel-game`.

## Environment Variables

- `PIXEL_SERVER_URL`: websocket gameplay server URL. Default: `ws://127.0.0.1:1234`
- `PIXEL_AUTH_SERVER_URL`: GitHub login worker URL. Default: `wss://pixel-game-collab.dlqud19.workers.dev`
- `PIXEL_REPO`: GitHub repository slug used as the room name, for example `facebook/react`
- `PIXEL_ROOM`: explicit room name override. Default: `pixel-game`
- `PIXEL_NAME`: player name override. Default: stored GitHub login when available, otherwise random `player-xxxx`
- `GITHUB_CLIENT_ID`: direct-login fallback for local development when no auth worker is available
- `GITHUB_SESSION_SECRET`: Worker-only HMAC secret used to verify GitHub edit sessions
- `CLOUDFLARE_API_TOKEN`: optional token-based Wrangler auth
- `CLOUDFLARE_ACCOUNT_ID`: required when using token-based Wrangler auth

Runtime precedence:

- `--room`
- positional `owner/repo`
- `--repo`
- `PIXEL_ROOM`
- `PIXEL_REPO`
- default room `pixel-game`

## Commands

- `pnpm dev:client`: run the terminal client
- `pnpm dev:server`: run the local `y-websocket` server
- `pnpm dev:server:cloudflare`: run the Cloudflare Worker locally
- `pxboard login`: start GitHub device login
- `pxboard whoami`: print the stored GitHub identity
- `pxboard logout`: clear the stored GitHub identity
- `pnpm build:client`: build a standalone client binary
- `pnpm package:client:release`: package the current platform binary for a GitHub release
- `pnpm deploy:server:cloudflare`: deploy the Cloudflare Worker
- `pnpm typecheck`: run TypeScript checks

## Controls

- `Arrow keys`, `WASD`, or `HJKL`: move the cursor
- `Enter` or `Space`: paint the current cell
- `1-8`: select a color
- Keyboard-only input
- Other players tint their live cursor cells and show name tags near visible cursors
- Fresh paint briefly brightens to show recent activity
- `Esc` or `Q`: quit

Painting the south or east edge, or nudging the cursor one step past that edge, expands the shared board by `8` cells in that direction. When the board outgrows the terminal, the board view follows your cursor instead of requiring the whole canvas to fit on screen.
