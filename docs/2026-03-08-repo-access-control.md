# Repository Access Control

## Goal

Add an owner-managed protected mode for repository rooms so a board can be switched from open editing to owner-only plus invited collaborators.

## Decision

- Keep non-repository rooms unchanged.
- Keep repository rooms open by default until the owner enables protected mode.
- When protected mode is enabled, unauthorized users stay connected in read-only mode instead of being disconnected.
- Store the policy in the room Durable Object so access control stays room-local and updates can be pushed to connected clients immediately.

## CLI

The terminal client now supports:

```bash
pxboard access status owner/repo
pxboard access enable owner/repo
pxboard access disable owner/repo
pxboard access grant owner/repo alice
pxboard access revoke owner/repo alice
```

These commands require a worker-backed GitHub login because they depend on the worker-signed session token.

## Worker API

- `GET /admin/rooms/:room/access`
- `PUT /admin/rooms/:room/access`
- `POST /admin/rooms/:room/access/editors`
- `DELETE /admin/rooms/:room/access/editors/:login`

Only the repository owner can call these endpoints.

## Typechecking

- `pnpm typecheck` now covers both `src/**` and `cloudflare/worker.ts`.
- `worker-configuration.d.ts` is generated from Wrangler.
- If Durable Object bindings or env definitions change, rerun `pnpm typegen:worker` before committing.

## TUI Behavior

- Owners see whether a repository room is open or protected.
- Owners get command hints for enabling protected mode or managing invited editors.
- Invited editors see that they are editing with delegated access.
- Unauthorized users receive a read-only reason from the worker.

## Current Limitation

Protected mode is managed from the service-side allowlist, not from GitHub collaborator membership. That keeps the first version simple and avoids storing GitHub access tokens on the worker.
