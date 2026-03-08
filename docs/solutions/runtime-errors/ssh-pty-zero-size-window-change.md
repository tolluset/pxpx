---
module: SSH Gateway
date: 2026-03-09
problem_type: runtime_error
component: tooling
symptoms:
  - "The terminal client crashed only when connected through `ssh pxpx.sh`."
  - "Resizing the SSH terminal could terminate the session with a renderer resize error."
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [ssh-gateway, pty, window-change, terminal-resize, opentui]
---

# SSH PTY Zero-Size Window Change

## Context
The terminal client stayed stable locally, but users could crash the session when resizing an SSH-backed `pxpx.sh` terminal.

## Problem
During SSH `window-change`, some terminals can briefly report invalid PTY dimensions such as `0x0`. The gateway forwarded those values to the child PTY runner, which then propagated them to the OpenTUI client. OpenTUI rejects framebuffer resizes at `0` width or height and aborts.

## Working Solution
- Added `sanitizePtyWindow` and `sanitizePtyInfo` in `src/ssh-gateway/pty.ts`
- Sanitized initial PTY dimensions before launching the interactive child
- Sanitized every SSH `window-change` event before forwarding it
- Preserved the last valid PTY size when a resize event reported invalid dimensions
- Added regression tests in `tests/ssh-gateway/pty.test.ts`

## Key Insight
This was not a generic client-side resize bug. The failure path was specific to the SSH PTY bridge, where transient invalid sizes can appear during interactive terminal resizes.

## Verification
- Ran `bun test tests/ssh-gateway/*.test.ts`
- Ran `pnpm typecheck`
