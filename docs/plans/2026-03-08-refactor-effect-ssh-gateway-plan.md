---
title: "refactor: Rewrite SSH Gateway With Effect"
type: refactor
status: active
date: 2026-03-08
---

# refactor: Rewrite SSH Gateway With Effect

## Overview
`src/ssh-gateway.ts` is already functionally useful, but it currently mixes six concerns in one file:

1. environment/config parsing
2. command parsing and validation
3. SSH authentication/session wiring
4. PTY control socket lifecycle
5. child-process spawning and stream bridging
6. process boot and fatal error handling

This plan rewrites the gateway around Effect so the runtime becomes composable, testable, and resource-safe without changing the public product behavior:

- `ssh pxpx.sh`
- `ssh -t pxpx.sh owner/repo`
- `ssh pxpx.sh login|logout|whoami|access ...`

## Problem Statement / Motivation
Today the gateway works, but the current structure makes the next wave of work harder than it should be.

- Top-level process setup exits eagerly during module evaluation (`src/ssh-gateway.ts:526`).
- Sync shell calls (`spawnSync`) and filesystem checks are embedded directly in startup and account resolution (`src/ssh-gateway.ts:104`, `src/ssh-gateway.ts:115`).
- Pure domain logic and Node event plumbing live in the same file (`src/ssh-gateway.ts:159`, `src/ssh-gateway.ts:532`).
- Cleanup is manual and spread across callbacks for control sockets, child processes, channels, and SSH sessions (`src/ssh-gateway.ts:332`, `src/ssh-gateway.ts:398`, `src/ssh-gateway.ts:591`).
- Errors are stringly typed, so failures are hard to classify and test.

That is acceptable for a first working version, but not for the long-lived hosted SSH entrypoint described in [docs/2026-03-08-ssh-gateway-spec.md](/Users/bh/workspaces/pixel-game/docs/2026-03-08-ssh-gateway-spec.md).

## Research Summary
### Local Repo Findings
- The gateway is a single-file Node daemon in [src/ssh-gateway.ts](/Users/bh/workspaces/pixel-game/src/ssh-gateway.ts).
- The current design already has good logical seams:
  - command parsing and normalization (`src/ssh-gateway.ts:159`)
  - auth identity construction (`src/ssh-gateway.ts:283`)
  - runtime env assembly (`src/ssh-gateway.ts:312`)
  - PTY socket management (`src/ssh-gateway.ts:332`)
  - process launch modes (`src/ssh-gateway.ts:447`, `src/ssh-gateway.ts:454`)
- The product spec already decided that the hosted SSH entrypoint should be a custom gateway, not normal shell access.

### Institutional Learnings
- `docs/solutions/` currently contains no SSH gateway or Effect-specific prior solution.
- The only stored solution is unrelated UI work, so this rewrite should treat the current gateway and spec as the canonical local source of truth.

### External Research Used
- Referenced example: Terminal PR 38 (`terminaldotshop/terminal`).
- Official Effect docs: service/layer composition, `Schema.TaggedError`, and `Effect.acquireRelease` / `Scope`.

### What To Borrow From Terminal PR 38
- Define typed services instead of reaching into globals directly.
- Model operational failures as tagged errors instead of generic `Error`.
- Move IO boundaries behind Effect values so the runtime graph is explicit.

### What Not To Borrow
- `@effect-atom/atom-react` and UI state patterns are not relevant to a Node SSH daemon.
- This rewrite should stay server-only and not spread Effect into `src/client.tsx` or `cloudflare/worker.ts` yet.

## Proposed Solution
Rewrite the gateway into a small Effect-based module tree while preserving the `ssh2` transport and the existing Python PTY runner.

### Target Module Layout
```text
src/ssh-gateway/
  main.ts
  config.ts
  errors.ts
  types.ts
  command-plan.ts
  auth.ts
  account.ts
  host-keys.ts
  runner-env.ts
  control-channel.ts
  child-process.ts
  session.ts
  server.ts
```

Keep `src/ssh-gateway.ts` temporarily as a thin compatibility entrypoint that imports `main.ts`, then remove it after the scripts/docs switch over cleanly.

### Effect Architecture
1. `GatewayConfig` layer
- Read env vars with Effect config primitives instead of eager top-level constants.
- Fail startup with typed config errors if host keys, binary path, runner path, or port config are invalid.

2. Domain-first modules
- Keep command tokenization, repo normalization, GitHub login normalization, and command-plan resolution as mostly pure functions.
- Return typed domain errors rather than throwing raw exceptions.

3. Infrastructure services
- `HostKeyService`
- `UserAccountService`
- `ControlChannelService`
- `ProcessRunnerService`
- `SshServerService`

Each service should expose Effect-returning methods and hide Node callback/event mechanics internally.

4. Resource safety with `Scope`
- Wrap server listen/close in `Effect.acquireRelease`.
- Wrap the PTY control socket lifecycle in `Effect.acquireRelease`.
- Wrap spawned child processes so `SIGTERM`, stdin close, socket cleanup, and channel exit all happen from one ownership boundary.

5. Typed errors
- Replace stringly runtime failures with `Schema.TaggedError` classes such as:
  - `MissingHostKeysError`
  - `InvalidCommandError`
  - `InvalidGithubLoginError`
  - `InvalidRepoSlugError`
  - `UserAccountLookupError`
  - `PtyRequiredError`
  - `ChildProcessLaunchError`
  - `SshAuthenticationError`
  - `GatewayListenError`

6. Structured logging
- Replace ad hoc `console.log`/`console.error` with a single gateway logger interface.
- Keep the existing human-readable prefix (`[pxpx-ssh]`) so deployment logs remain grep-friendly.

## Detailed Phases
## 2-PR Migration Shape
### PR 1: Safety Rails + Bootstrap
- Add `effect` and a minimal gateway test harness.
- Extract pure command parsing/normalization into separate modules.
- Introduce `src/ssh-gateway/main.ts`, `config.ts`, and typed error definitions.
- Keep the current ssh2 runtime behavior intact behind a compatibility entrypoint.

### PR 2: Runtime Rewrite
- Split the remaining runtime concerns into server/session/process/control-channel modules.
- Move child-process and server lifecycle ownership under Effect-managed services/scopes.
- Finish the removal of top-level imperative startup from the legacy entrypoint.

## Phase 1: Dependency And Runtime Skeleton
- Add `effect` as a dependency.
- Add any minimal Node/runtime packages only if the implementation actually needs them; do not pre-install half the ecosystem.
- Introduce `src/ssh-gateway/main.ts`, `config.ts`, and `errors.ts`.
- Make `pnpm dev:ssh-gateway` run the new entrypoint behind the old script name.

### Deliverable
- Gateway boots through `Effect.runPromise` or `NodeRuntime.runMain`.
- No behavior change yet.

## Phase 2: Extract Pure Domain Logic
- Move and test:
  - `tokenizeCommand`
  - `sanitizeRepoSlug`
  - `sanitizeGithubLogin`
  - `resolveCommandPlan`
  - public-key fingerprint derivation
- Convert thrown validation failures into typed domain errors.

### Deliverable
- Pure modules are decoupled from SSH transport and Node process APIs.

## Phase 3: Convert Startup Side Effects Into Services
- Replace eager top-level checks with startup effects:
  - host key discovery
  - pxpx binary existence
  - PTY runner existence
  - run-as user UID/GID lookup
- Represent startup failure as typed configuration/infrastructure errors.

### Deliverable
- Importing the module no longer exits the process.
- Startup can be tested without booting the whole daemon.

## Phase 4: Resource-Safe PTY And Child Process Layer
- Move `createControlChannel`, `buildRunnerEnvironment`, `buildSpawnOptions`, `bridgeStreams`, `launchPlainCommand`, and `launchInteractiveCommand` behind infrastructure services.
- Use `acquireRelease` to guarantee:
  - socket file removal
  - server close
  - child termination
  - channel shutdown
- Keep the current Python PTY runner for the first rewrite. Do not swap the PTY implementation in the same change.

### Deliverable
- Interactive and non-interactive execution paths share a single cleanup model.

## Phase 5: Session Program Rewrite
- Model an SSH client lifecycle as an Effect program:
  - authenticate public key
  - derive identity
  - reject unsupported channel/request types
  - track PTY/window state
  - run `shell` and `exec` through the same command handler
- Encapsulate `ssh2` event bridging with `Effect.async`-style wrappers rather than open-coded nested callbacks.

### Deliverable
- SSH session behavior is unchanged, but flow is readable as one program instead of nested listeners.

## Phase 6: Hardening And Verification
- Add focused tests for:
  - command parsing matrix
  - repo/login normalization
  - startup config failure modes
  - PTY-required branch
  - access command argument validation
- Run:
  - `pnpm typecheck`
  - `pnpm dev:ssh-gateway`
  - targeted manual SSH smoke tests on the host

### Deliverable
- Behavior parity proven for the currently documented SSH flows.

## Technical Considerations
### Why Effect Fits This File
- The gateway is dominated by lifecycle management and failure handling, not data transformation.
- The hard part is ownership: server socket, SSH session, PTY socket, spawned process, and channel streams.
- `Effect.acquireRelease` and service layering directly match that problem.

### Why This Should Stay Narrow
- Rewriting the SSH gateway is already enough architectural change for one plan.
- Pulling `src/client.tsx` or `cloudflare/worker.ts` into the same migration would mix transport/runtime work with gameplay logic and make rollback harder.

### Why `ssh2` Should Stay For Now
- The current gateway already works with `ssh2`.
- A simultaneous transport rewrite would bury behavior regressions under framework churn.
- The first goal is control-flow clarity and testability, not transport replacement.

## SpecFlow / Edge Cases
1. Public-key auth two-step behavior
- `ssh2` may invoke auth without a signature before the signed attempt.
- The Effect rewrite must preserve the current behavior of accepting the unsigned probe but only persisting identity after a signed request.

2. Interactive sessions require a PTY
- `ssh pxpx.sh owner/repo` without `-t` must still fail with the current user-facing guidance.

3. Window resize timing
- `window-change` may arrive before or after the child process attaches to the control socket.
- The rewritten control channel service must preserve pending window state.

4. Session teardown race
- Child close, channel close, and SSH client close may happen in different orders.
- The new design must make cleanup idempotent.

5. Unsupported SSH features
- `env`, `auth-agent`, `x11`, `sftp`, TCP forwarding, and streamlocal forwarding must continue to reject explicitly.

## Acceptance Criteria
- [x] `src/ssh-gateway.ts` is split into focused modules under `src/ssh-gateway/`.
- [x] The gateway boots through Effect-managed startup rather than top-level imperative initialization.
- [ ] All current supported commands behave the same: empty command, `owner/repo`, `login`, `logout`, `whoami`, and `access ...`.
- [ ] Interactive sessions still require a PTY and surface the same user guidance.
- [x] Host-key loading, binary checks, user lookup, and process launch failures are represented as typed errors.
- [ ] Child-process and control-socket cleanup is resource-safe and idempotent.
- [x] `pnpm typecheck` passes after the rewrite.

## Risks And Mitigations
- Risk: Effect migration hides behavior regressions behind large file moves.
- Mitigation: migrate in phases and keep command parsing/tests green before touching session wiring.

- Risk: Over-abstracting too early creates an “Effect-shaped” codebase instead of a simpler one.
- Mitigation: only introduce services where there is actual IO, lifecycle, or dependency injection value.

- Risk: Event-wrapper complexity around `ssh2` becomes harder to debug than the current callbacks.
- Mitigation: keep wrappers thin and preserve direct mapping between ssh2 events and gateway handlers.

## Implementation Notes
### Proposed File-Level Tasks
- [x] [src/ssh-gateway.ts](/Users/bh/workspaces/pixel-game/src/ssh-gateway.ts): reduce to compatibility bootstrap or remove after cutover
- [x] `src/ssh-gateway/config.ts`: env parsing and startup validation
- [x] `src/ssh-gateway/errors.ts`: tagged error definitions
- [x] `src/ssh-gateway/command-plan.ts`: tokenization, normalization, plan resolution
- [x] `src/ssh-gateway/auth.ts`: public-key parsing, verification, identity building
- [x] `src/ssh-gateway/account.ts`: UID/GID lookup and run-user model
- [x] `src/ssh-gateway/control-channel.ts`: socket lifecycle
- [x] `src/ssh-gateway/child-process.ts`: spawn, bridge, teardown
- [ ] `src/ssh-gateway/session.ts`: per-session orchestration
- [x] `src/ssh-gateway/server.ts`: ssh2 server boot/listen lifecycle

### Suggested Verification Matrix
1. `ssh pxpx.sh`
2. `ssh -t pxpx.sh facebook/react`
3. `ssh pxpx.sh login`
4. `ssh pxpx.sh access status facebook/react`
5. `ssh pxpx.sh foo bar` returns a typed validation error path
6. disconnect during active board session leaves no stale control socket

### Pseudocode Sketch
```ts
class GatewayConfig extends Context.Tag("GatewayConfig")<
  GatewayConfig,
  {
    readonly bindHost: string
    readonly bindPort: number
    readonly runAsUser: string
    readonly runCommand: string
    readonly runnerPath: string
    readonly authRoot: string
    readonly defaultRoom: string
    readonly hostKeyPaths: ReadonlyArray<string>
  }
>() {}

class ProcessRunner extends Context.Tag("ProcessRunner")<
  ProcessRunner,
  {
    readonly launch: (
      request: LaunchRequest
    ) => Effect.Effect<RunningProcess, ChildProcessLaunchError, Scope.Scope>
  }
>() {}

const program = Effect.gen(function* () {
  const server = yield* SshServer
  yield* server.listen
}).pipe(Effect.scoped)
```

## Out Of Scope
- Rewriting the Cloudflare worker to Effect
- Rewriting the TUI client to Effect
- Replacing `ssh2`
- Replacing the Python PTY runner
- Adding new hosted product commands beyond existing gateway behavior

## Sources & References
- Current gateway: [src/ssh-gateway.ts](/Users/bh/workspaces/pixel-game/src/ssh-gateway.ts)
- Product spec: [docs/2026-03-08-ssh-gateway-spec.md](/Users/bh/workspaces/pixel-game/docs/2026-03-08-ssh-gateway-spec.md)
- Reference architecture:
  - `terminaldotshop/terminal` PR 38
  - `packages/tui/src/api.ts` in that PR for `Effect.Service` + `Schema.TaggedError`
  - Effect official docs for `Layer`, `Scope`, `Effect.acquireRelease`
