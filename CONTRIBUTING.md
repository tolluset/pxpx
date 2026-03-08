# Contributing

## Ground Rules

- Use `pnpm`, not `npm`
- Keep production-facing code comments in English
- Prefer small, reviewable pull requests
- Update docs when behavior, setup, or operations change
- Never commit secrets, tokens, or local credential files

## Local Setup

```bash
pnpm install
pnpm dev:server
pnpm dev:client
```

For Worker-backed flows:

```bash
pnpm dev:server:cloudflare
PIXEL_SERVER_URL=ws://127.0.0.1:8787 pnpm dev:client
PIXEL_AUTH_SERVER_URL=ws://127.0.0.1:8787 pnpm dev:client -- login
```

Copy `.env.example` to `.env.local` or your preferred local env file only when you need overrides.

## Before Opening A Pull Request

Run the core checks:

```bash
pnpm typecheck
pnpm build:client
```

Also verify the behavior you changed:

- Multiplayer sync with two local clients when gameplay changes
- Worker-backed login or access flows when auth behavior changes
- README or setup snippets when developer workflows change

## Pull Request Expectations

- Explain the user-visible change and any operational impact
- List the commands you ran
- Include doc updates for changed workflows, defaults, or environment variables
- Keep generated artifacts and local-only files out of the diff

## Reporting Issues

- Use the bug report template for regressions or runtime failures
- Use the feature request template for proposals or product ideas
- Follow `SECURITY.md` for suspected vulnerabilities
