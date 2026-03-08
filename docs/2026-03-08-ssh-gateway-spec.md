# SSH Gateway Spec

## Status

Proposed on 2026-03-08.

This document describes a planned SSH entrypoint for the project. It does not describe behavior that exists today.

## Goal

Allow users to join a room through a native SSH command:

```bash
ssh pxpx.space
ssh -t pxpx.space facebook/react
```

The command should launch the existing terminal client and connect it to the same shared room model already used by the local client and Cloudflare Worker backend.

## Existing Building Blocks

- The client already accepts a positional GitHub repository selector such as `owner/repo`.
- The client already normalizes repository selectors into room names.
- The collaboration worker already accepts slash-separated room names such as `owner/repo`.

Relevant code:

- `src/client.tsx`
- `cloudflare/worker.ts`

## User Experience

### Phase 1

- `ssh pxpx.space`
  - Launch the terminal client in a default room such as `pixel-game`.
- `ssh -t pxpx.space facebook/react`
  - Launch the terminal client in room `facebook/react`.
- `ssh -t pxpx.space owner/repo`
  - Behaves the same as `pxboard owner/repo`.

### Out Of Scope

- General shell access on the host
- Running arbitrary remote commands
- Reusing a persistent shell session after disconnect
- SSH file transfer features such as `scp` or `sftp`

## Routing Rules

- Empty remote command maps to the default room.
- A single remote argument matching `owner/repo` maps to that room.
- Invalid selectors return a short error in the terminal and close the session.
- Future support for named rooms such as `--room design-review` is optional and not required for Phase 1.

## Server Behavior

On each SSH connection:

1. Accept the SSH session and allocate a PTY.
2. Read the remote command string.
3. Validate and normalize the room selector.
4. Launch `pxboard` with either:
   - no room argument, or
   - a normalized `owner/repo` argument.
5. Attach the SSH PTY to the launched process.
6. Terminate the process when the SSH session closes.

The SSH layer is only a transport and launcher. Shared game state continues to live in the existing collaboration backend.

## Architecture

### Application Flow

```text
SSH client
  -> SSH gateway host
  -> pxboard process
  -> Cloudflare Worker websocket backend
  -> Durable Object room
```

### Recommended Phase 1 Host Design

Use the operating system SSH server instead of building a custom SSH server first.

- Host OS: macOS on a dedicated Mac mini is acceptable
- SSH entrypoint: system `sshd`
- Isolation model: dedicated local user such as `pxboard`
- Command restriction: `ForceCommand` launcher script
- Long-running service management: `launchd`

This keeps the SSH surface area small and avoids shipping a custom SSH daemon in v1.

### Future Hosted Design

A custom SSH gateway process remains a valid later option if the project needs:

- custom SSH banners
- richer deep-link commands
- connection telemetry
- host-independent packaging

## Network And DNS Options

### Option A: Direct Public SSH On The Home Host

How it works:

- `pxpx.space` points to the home public IP.
- The router forwards TCP `22` to the Mac mini.
- Users connect with plain `ssh pxpx.space`.

Pros:

- preserves the target UX exactly
- no client-side helper software
- simplest mental model

Cons:

- the home public IP may change
- requires inbound port exposure
- depends on router configuration and ISP policies
- not ideal as the default open source install story

Notes:

- If the ISP gives a dynamic public IP, DNS must be updated whenever the IP changes.
- This can be handled with dynamic DNS or an automated Cloudflare DNS update job.
- If the ISP uses CGNAT, direct inbound SSH may not be possible.

### Option B: Cloudflare Tunnel To The Home Host

How it works:

- `cloudflared` runs on the Mac mini and creates an outbound tunnel to Cloudflare.
- No inbound port needs to be opened on the home router.

Pros:

- no public inbound port on the home network
- avoids dynamic public IP management
- good self-hosted story for personal deployments

Cons:

- native plain `ssh pxpx.space` is not the default client path
- users typically need Cloudflare client-side tooling such as `cloudflared` or WARP, depending on the tunnel mode
- this changes the end-user setup and weakens the zero-config public demo UX

Decision:

- Supportable as an installation mode
- Not the default recommendation for the public shared host if the goal is plain `ssh -t pxpx.space owner/repo`

### Option C: VPS Relay In Front Of The Home Host

How it works:

- A small VPS exposes public TCP `22`.
- The home host creates an outbound tunnel or reverse connection to the VPS.
- Users connect to the VPS with plain `ssh pxpx.space`.

Pros:

- preserves the target UX exactly
- stable public IP and DNS
- no inbound home port required
- better fit for a public open source hosted endpoint

Cons:

- adds a second machine and operating cost
- requires tunnel or relay management between VPS and home host

Decision:

- Recommended public-hosted architecture
- Recommended fallback when the home ISP changes IPs often or uses CGNAT

## Recommended Product Decision

### For A Public Shared Host

Prefer a VPS relay in front of the game host.

Reasoning:

- It preserves `ssh -t pxpx.space owner/repo`.
- It does not require end users to install Cloudflare client tooling.
- It avoids direct inbound exposure on a home network.

### For Personal Self-Hosting

Support two installation modes:

- Direct public SSH mode for users with a stable public IP or working DDNS
- Cloudflare Tunnel mode for users who do not want to open inbound ports and are willing to accept client-side Cloudflare requirements

## Process Isolation Requirements

The SSH entrypoint must not expose the host as a normal shell box.

### Required Isolation Controls

- Create a dedicated unprivileged OS user such as `pxboard`
- Restrict login to the launcher only with `ForceCommand`
- Reject any remote command that is not empty or a valid room selector
- Disable SSH forwarding features:
  - TCP forwarding
  - agent forwarding
  - X11 forwarding
  - tunneling
- Disable `sftp` and general shell access
- Use a fixed working directory
- Pass a minimal environment to the launched process
- Keep runtime logs separate from normal user activity
- Set connection and idle timeouts
- Limit concurrent sessions per host

### Launcher Requirements

The launcher script should:

- read `SSH_ORIGINAL_COMMAND`
- normalize to either default room or `owner/repo`
- exec `pxboard` directly instead of invoking a shell pipeline
- emit short user-facing errors for invalid input
- avoid string interpolation into a shell command

## macOS Host Requirements

- Dedicated Mac mini or another always-on machine
- Sleep disabled while acting as a host
- Automatic restart of the launcher environment after reboot via `launchd`
- A dedicated directory for the project runtime and logs
- Clear separation between the maintainer's normal login account and the SSH gateway account

## Install Guide Follow-Up

When implementation starts, add a user-facing installation guide for:

- macOS direct public SSH mode
- macOS Cloudflare Tunnel mode
- VPS relay mode

That guide should include:

- DNS setup
- router setup when applicable
- Cloudflare setup when applicable
- `sshd` hardening
- launcher installation
- `launchd` service registration
- update and rollback steps
- troubleshooting for PTY issues and connection failures

## Security Notes

- Treat all remote command input as untrusted.
- Do not expose repository checkout write access to the SSH runtime user.
- Keep secrets out of the SSH runtime environment unless the client needs them.
- Prefer outbound-only connectivity from the home host when a public relay is available.

## Open Questions

- Whether Phase 1 should support only the default room and `owner/repo`, or also named rooms
- Whether the project should later replace system `sshd` with a custom SSH gateway
- Whether the public hosted service should run the `pxboard` process on the VPS itself or only use the VPS as a relay
