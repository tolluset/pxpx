# Progress Log
Started: Sat Mar  7 15:46:14 KST 2026

## Codebase Patterns
- (add reusable patterns here)

---
## [2026-03-07 15:57:43 KST] - US-001: Define and validate the local multiplayer runtime
Thread: 
Run: 20260307-154614-67806 (iteration 1)
Run log: /Users/bh/workspaces/pixel-game/.ralph/runs/run-20260307-154614-67806-iter-1.log
Run summary: /Users/bh/workspaces/pixel-game/.ralph/runs/run-20260307-154614-67806-iter-1.md
- Guardrails reviewed: yes
- No-commit run: false
- Commit: 3bd8ca3 feat: define local multiplayer runtime
- Post-commit status: `clean`
- Verification:
  - Command: `pnpm typecheck` -> PASS
  - Command: `pnpm dev:client` -> PASS
  - Command: `pnpm dev:server` -> PASS
  - Command: `node -e "const WebSocket=require('ws'); const ws=new WebSocket('ws://127.0.0.1:1234/pixel-game'); ws.on('open',()=>{console.log('open'); ws.close();}); ws.on('error',(err)=>{console.error(err.message); process.exit(1);});"` -> PASS
  - Command: `pnpm dev:client` -> PASS
- Files changed:
  - .ralph/activity.log
  - .ralph/progress.md
  - README.md
  - docs/2026-03-07-client-distribution.md
  - docs/2026-03-07-cloudflare-server.md
  - package.json
  - src/client.tsx
- What was implemented
  - Set the gameplay runtime defaults to `ws://127.0.0.1:1234` and room `pixel-game`, and removed git-origin room auto-detection from the default path.
  - Updated `pnpm dev:server` to bind explicitly on `127.0.0.1:1234` so the documented local example works on IPv4-first clients.
  - Documented the `PIXEL_SERVER_URL`, `PIXEL_ROOM`, and `PIXEL_NAME` contract in the CLI help and README, and aligned the Cloudflare/runtime notes with the local-first default.
  - Kept the client responsive when the websocket server is absent by surfacing visible `Connecting` and `Reconnecting` states in the TUI.
- **Learnings for future iterations:**
  - Patterns discovered
    - The OpenTUI client can be validated through PTY capture plus socket inspection when alternate-screen redraws make plain logs incomplete.
  - Gotchas encountered
    - `y-websocket` defaults `HOST` to `localhost`, which resolved to IPv6-only on this machine and broke the required `127.0.0.1:1234` client path until the script bound explicitly on IPv4.
  - Useful context
    - The GitHub auth worker can keep its remote default independently of the gameplay websocket default, which avoids regressing login flows while making local multiplayer deterministic.
---
