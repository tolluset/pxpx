# SSH Gateway Architecture And Deployment Notes

## Status

Implemented on the OCI test host on 2026-03-08.

This document started as a product spec and now serves as the main knowledge log for the hosted SSH entrypoint:

- target user experience
- actual implementation shape
- deployment process on the first public host
- operational runbook
- lessons learned while shipping it

## Goal

Give users a native terminal entrypoint into a shared board:

```bash
ssh pxpx.sh
ssh -t pxpx.sh facebook/react
```

The command should feel like a product surface, not like "logging into a server". The board itself remains the existing `pxpx` terminal client connected to the existing collaboration backend.

## Product Mental Model

`pxpx.sh` is not a general-purpose shell box.

It is closer to:

- a terminal-native app launcher
- carried over SSH transport
- with the real shared state living in the collaboration server

That distinction matters because it drives almost every implementation decision:

- the host should not expose a normal shell
- the SSH username should not be part of the product contract
- the launched process should always be `pxpx`
- room selection should be treated like application routing, not host login

## User Experience Contract

### Supported Commands

```bash
ssh pxpx.sh
ssh -t pxpx.sh facebook/react
ssh pxpx.sh -- --help
ssh pxpx.sh login
ssh pxpx.sh whoami
ssh pxpx.sh access status facebook/react
```

### Command Semantics

- Empty remote command launches the default room.
- A single `owner/repo` token launches that repository room.
- `login`, `logout`, `whoami`, and `access ...` are treated as non-interactive control commands.
- Unsupported commands return a short validation error and close.

### Explicit Non-Goals

- general shell access on the public port
- arbitrary command execution
- file transfer over `scp` or `sftp`
- agent forwarding, X11 forwarding, or TCP forwarding
- persistent shell sessions after disconnect

## Existing Building Blocks

The SSH entrypoint works because the rest of the project already had the core room model.

- The terminal client already accepts a positional repository selector such as `owner/repo`.
- The client already normalizes repository selectors into room names.
- The collaboration worker already accepts slash-separated room names.

Relevant code:

- `src/client.tsx`
- `cloudflare/worker.ts`

The hosted SSH gateway is therefore only a transport and process launcher. It does not own room state.

## Why A Custom SSH Gateway Was Needed

### First Attempt: System `sshd` + `ForceCommand`

The simplest version worked with a dedicated Unix user and a forced command:

- user connects with `ssh pxpx@host`
- `sshd` logs them into the `pxpx` Unix account
- `ForceCommand` launches `pxpx`

This is enough for:

```bash
ssh pxpx@131.186.25.184
ssh -t pxpx@131.186.25.184 facebook/react
```

### Why That Was Not Enough

The desired public entrypoint was:

```bash
ssh pxpx.sh
```

without requiring every user to add a local SSH alias such as:

```sshconfig
Host pxpx.sh
  User pxpx
```

That requirement breaks the `sshd + ForceCommand` model because the SSH username is chosen by the client before the server sees the session. The server cannot tell OpenSSH clients "actually log in as `pxpx` instead".

That led to the final decision:

- public port `22` is owned by a custom SSH server
- the custom server ignores the presented SSH username
- admin shell access moves to a separate port

## Final Hosted Architecture

### Network Shape

```text
SSH client
  -> custom SSH gateway on public TCP 22
  -> pxpx process
  -> Cloudflare Worker websocket backend
  -> Durable Object room
```

### Administrative Access

```text
Admin SSH client
  -> system sshd on TCP 2222
  -> ubuntu shell
```

### Current Host Layout

- Public board entrypoint: custom gateway on port `22`
- Admin shell: system `sshd` on port `2222`
- Public DNS: `pxpx.sh -> 131.186.25.184`
- Runtime OS user for board sessions: `pxpx`
- Admin OS user: `ubuntu`
- Service manager: `systemd`

### Why This Split Is Good

- Users get the clean product command: `ssh pxpx.sh`
- Admins still have normal SSH for maintenance
- The board runtime is isolated from the maintenance shell
- Public traffic does not land in `sshd`

## Repository Code Map

### Entry Points

- `src/ssh-gateway.ts`
  - compatibility bootstrap for the hosted SSH gateway process
- `src/ssh-gateway/main.ts`
  - startup wiring

### Core Modules

- `src/ssh-gateway/config.ts`
  - env parsing, host key loading, run user lookup, runner paths
- `src/ssh-gateway/command-plan.ts`
  - command tokenization, repo slug normalization, access command validation
- `src/ssh-gateway/runtime.ts`
  - `ssh2` session handling, auth, PTY checks, child process orchestration
- `src/ssh-gateway/errors.ts`
  - typed startup and validation errors
- `src/ssh-gateway/types.ts`
  - shared runtime types

### Child Process Runner

- `scripts/ssh-pty-runner.py`
  - creates a PTY with `forkpty`
  - launches the configured command
  - handles stdin/stdout bridging
  - accepts window-size updates over a control socket

### Shared Client/Auth Code Reused By The Gateway

- `src/github-auth.ts`
  - now supports `PIXEL_GITHUB_AUTH_FILE`
- `src/client.tsx`
  - still owns the board UX and GitHub auth commands

## Connection Lifecycle

The SSH gateway performs the following steps for each connection.

### 1. Accept SSH Public-Key Authentication

The gateway accepts public-key authentication and verifies the signature against the presented public key.

Important detail:

- the SSH username is accepted but not used as the product identity
- the public key fingerprint is the stable identity input

This gives the hosted product two useful properties:

- `ssh pxpx.sh` works without a fixed Unix username
- GitHub login state can be isolated per SSH key

### 2. Build An App-Level Identity

After authentication, the gateway derives:

- SSH key fingerprint
- presented SSH username, for logs only
- per-user auth file path under the configured auth root

The per-user auth path is then passed to the child process through `PIXEL_GITHUB_AUTH_FILE`.

That prevents all remote users from sharing one global GitHub login file.

### 3. Parse The Requested Command

The gateway converts the SSH command into an internal command plan:

- empty command -> interactive default room
- `owner/repo` -> interactive room
- `login`, `logout`, `whoami`, `access ...` -> plain command mode
- everything else -> validation error

The validation rules intentionally stay narrow. The public entrypoint should only launch supported app actions.

### 4. Decide Whether A PTY Is Required

Interactive room sessions require a PTY. Plain commands do not.

That is why:

```bash
ssh pxpx.sh
ssh -t pxpx.sh facebook/react
```

work, but:

```bash
ssh pxpx.sh facebook/react
```

still needs `-t`.

This is not just an implementation quirk. In standard SSH, the client decides whether to request a PTY. The server cannot force an already-open `exec` channel to become a PTY-backed interactive terminal.

Relevant code:

- `src/ssh-gateway/runtime.ts`

### 5. Launch The Child Process As `pxpx`

The gateway never launches a shell. It launches only the configured board command.

Default command:

```text
/usr/local/bin/pxpx
```

The process is run as the dedicated unprivileged Unix user defined by `PXPX_GATEWAY_RUN_AS_USER`.

### 6. Bridge I/O And Window Resizes

For interactive sessions:

- the child process gets a PTY
- SSH input is forwarded to the PTY
- PTY output is forwarded back to the SSH channel
- `window-change` events are forwarded to the PTY runner

### 7. Tear Down Cleanly

When the SSH session closes:

- the child process is terminated
- the resize control socket is removed
- logs retain the fingerprint prefix for correlation

## Security Model

### Public Port 22

The public gateway is intentionally narrower than OpenSSH.

It rejects:

- TCP forwarding
- stream-local forwarding
- agent forwarding
- X11 forwarding
- `sftp`
- arbitrary environment injection

It also does not expose a general shell.

### Runtime Isolation

The board process runs as:

- user: `pxpx`
- home: `/home/pxpx`
- workdir: `/home/pxpx`

This is separate from:

- user: `ubuntu`
- admin shell on port `2222`

### Auth Storage Isolation

Each SSH key fingerprint gets its own auth file tree under the configured auth root.

Without that, every remote user would share a single `github-auth.json`, which would be a serious product and security bug.

## Runtime Configuration

The current gateway is configured entirely by environment variables.

Important ones:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PXPX_GATEWAY_HOST` | bind host | `0.0.0.0` |
| `PXPX_GATEWAY_PORT` | public listen port | `22` |
| `PXPX_GATEWAY_HOST_KEYS` | SSH host key paths | `/etc/ssh/ssh_host_ed25519_key,/etc/ssh/ssh_host_rsa_key` |
| `PXPX_GATEWAY_COMMAND` | launched board binary | `/usr/local/bin/pxpx` |
| `PXPX_GATEWAY_RUN_AS_USER` | runtime Unix user | `pxpx` |
| `PXPX_GATEWAY_RUN_HOME` | runtime home override | derived |
| `PXPX_GATEWAY_WORKDIR` | working directory override | derived |
| `PXPX_GATEWAY_AUTH_ROOT` | per-fingerprint auth root | `<runHome>/.local/share/pxpx-auth` |
| `PXPX_GATEWAY_RUNNER` | PTY runner path | repo `scripts/ssh-pty-runner.py` |
| `PXPX_GATEWAY_DEFAULT_ROOM` | default room | `tolluset/pxpx` |

## First Public Deployment

### Platform Choice

The first public host was provisioned on Oracle Cloud Infrastructure in `ap-seoul-1`.

Reasons:

- already available
- low-cost test path
- normal VM model
- public TCP `22` support without special SSH products

### What Actually Landed

- compute shape: `VM.Standard.E2.1.Micro`
- architecture: x86
- public IP: ephemeral
- DNS: apex `A` record to the public IP

### Why The ARM Plan Changed

The original intent was to use Always Free ARM (`A1`) because it is a better long-term free-tier fit. That did not work in practice because the region had no host capacity available at the time.

That forced a fallback to `E2.1.Micro`.

### Why The Network Was Reused

The tenancy was already at the VCN quota, so a new VCN could not be created.

The deployment therefore reused:

- an existing VCN
- an existing public subnet
- an existing security list

### Why The IP Was Ephemeral

Reserved public IP quota was already exhausted.

That forced the initial deployment to use an ephemeral public IP. This is acceptable for early operation, but it means DNS must be updated manually if the instance is recreated or the public IP changes.

## System-Level Deployment Shape

### Files On The Host

- project checkout: `~/pxpx`
- board binary: `/usr/local/bin/pxpx`
- gateway launcher: `/usr/local/bin/pxpx-ssh-gateway-start`
- gateway env file: `/etc/default/pxpx-ssh-gateway`
- gateway service: `pxpx-ssh-gateway.service`
- SSH socket override: `/etc/systemd/system/ssh.socket.d/10-pxpx-ports.conf`

### Final Port Ownership

- `22/tcp` -> `pxpx-ssh-gateway.service`
- `2222/tcp` -> system `sshd`

### Why `ssh.socket` Was Used

The Ubuntu image used socket activation for SSH. That means simply editing `sshd_config` is not enough. The active listener is often controlled by `ssh.socket`.

The fix was to move the socket listener itself to `2222`.

## Runbook: How The Host Was Brought Up

This is the implementation sequence that actually worked.

### 1. Create Or Reuse The VM

- create the OCI instance
- attach a public IP
- verify `ssh ubuntu@<ip>`

### 2. Clone The Repository And Install Runtime Dependencies

- clone `https://github.com/bhkku/pxpx`
- install Bun
- run `bun install`
- build or install the board binary as `/usr/local/bin/pxpx`

### 3. Create A Dedicated Runtime User

- create Unix user `pxpx`
- set home directory to `/home/pxpx`
- keep this user separate from the admin user

### 4. Stage The Custom Gateway On A Non-Public Port

Before taking over port `22`, the gateway was first staged on a spare port and tested end-to-end.

This matters because:

- it validates auth and PTY flow
- it avoids locking out admin access
- it allows incremental cutover

### 5. Move Admin SSH To `2222`

- change the active `ssh.socket` listener to `2222`
- verify `ssh -p 2222 ubuntu@<ip>`

Only after that succeeds should public port `22` be reassigned.

### 6. Move The Gateway To Port `22`

- update the gateway env file to bind to `22`
- restart the gateway
- verify `ssh <ip>`
- verify `ssh -t <ip> facebook/react`

### 7. Point DNS At The Host

- add `A pxpx.sh -> <public-ip>`
- wait for recursive resolvers to see the record

## Operational Commands

### User Entry

```bash
ssh pxpx.sh
ssh -t pxpx.sh facebook/react
```

### Admin Entry

```bash
ssh -p 2222 ubuntu@pxpx.sh
```

### Service Inspection

```bash
sudo systemctl status pxpx-ssh-gateway
sudo systemctl status ssh.socket
sudo ss -ltnp | grep -E ':(22|2222)\b'
journalctl -u pxpx-ssh-gateway -f
```

### Repo Maintenance

```bash
ssh -p 2222 ubuntu@pxpx.sh
cd ~/pxpx
git pull
bun install
```

## Troubleshooting Notes From The First Deployment

### Issue: `ssh pxpx.sh` Needed To Work Without `pxpx@`

Cause:

- standard `sshd` binds product routing to a Unix username

Fix:

- replace the public `sshd` entrypoint with a custom gateway that ignores the presented SSH username

### Issue: Interactive Repo Rooms Needed `-t`

Cause:

- SSH `exec` requests do not automatically allocate a PTY

Fix:

- require `-t` for interactive remote commands
- keep plain shell-style `ssh pxpx.sh` as the no-flag default

### Issue: `2222` Looked Open In OCI But Was Still Unreachable

Cause:

- the guest OS image had local firewall rules that only allowed new inbound traffic on port `22`

Fix:

- add local firewall rules for `2222`
- persist them

Key insight:

- cloud security rules are only half the story; always check the instance firewall too

### Issue: `pxpx.sh` Resolved In `dig` But Not In `ssh`

Cause:

- local macOS DNS cache still held stale resolver state

Fix:

```bash
sudo killall -HUP mDNSResponder
```

Key insight:

- `dig` and `ssh` do not always reflect the same resolver path on macOS

### Issue: OCI Network Creation Failed

Cause:

- tenancy VCN quota was already exhausted

Fix:

- reuse the existing public subnet instead of assuming greenfield infrastructure

Key insight:

- practical deployments often start inside messy pre-existing cloud accounts, not empty ones

### Issue: Always Free ARM Was Unavailable

Cause:

- regional host capacity was exhausted

Fix:

- fall back to another free-tier-compatible shape and keep the deployment moving

Key insight:

- free-tier architecture plans should always include a fallback shape

## Experience And Engineering Insights

### 1. The Product Surface Should Drive The Host Architecture

If the desired command is:

```bash
ssh pxpx.sh
```

then the host architecture must be chosen around that fact. A simpler server design that forces `pxpx@` is technically valid but product-invalid.

### 2. SSH Can Be An App Transport, Not Just A Shell Transport

This project worked well once SSH was treated as:

- authentication transport
- PTY transport
- command transport

and not as a normal shell session.

That mental shift simplified the model.

### 3. The Right Isolation Boundary Was "Board Process", Not "Full Multi-User Shell"

Trying to model public users as Unix users would have pushed the system toward the wrong shape.

The real requirement was:

- one board process per connection
- launched as one unprivileged runtime account
- with app-level identity carried by the SSH key fingerprint

### 4. Process And Port Separation Reduced Risk

Putting:

- public app traffic on `22`
- admin shell on `2222`

was simpler and safer than trying to overload one daemon with both jobs.

### 5. Per-Fingerprint Auth Storage Was Essential

This was easy to miss. Without it, a hosted multi-user SSH service would accidentally share one GitHub login session across unrelated users.

That would have been a subtle but severe bug.

### 6. The Real Deployment Work Happened Below The App Layer

The core app logic was already mostly ready. The hard parts were:

- socket activation behavior
- host key reuse
- firewall rules
- DNS propagation and local DNS caches
- cloud quota limits

That is a useful reminder for future hosted features: product work often finishes before infrastructure work does.

## Recommendations For Future Clean-Up

### Short Term

- write a reproducible server bootstrap script instead of relying on ad hoc remote shell steps
- codify the `systemd` service file in the repository
- codify the `ssh.socket` override in the repository
- add a hosted deployment checklist to avoid forgetting the firewall step

### Medium Term

- package the gateway and board binary into a single installable release artifact
- document upgrade and rollback steps
- add a smoke-test script that checks:
  - public `ssh pxpx.sh -- --help`
  - public `ssh -t pxpx.sh facebook/react`
  - admin `ssh -p 2222 ubuntu@pxpx.sh`

### Long Term

- support an installation path for users who want to self-host the SSH entrypoint
- consider a VPS-first deployment story as the default public host recommendation
- decide whether hosted auth should eventually move beyond local per-fingerprint files

## Open Questions

- Whether the public shared host should remain on OCI or move to a simpler VPS provider
- Whether the project should later ship a one-command installer for the gateway host
- Whether the public hosted service should stay on an ephemeral public IP until reserved IP quota is available
- Whether the public product should eventually offer a web terminal mirror in addition to SSH
