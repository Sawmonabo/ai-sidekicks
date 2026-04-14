# Repo Exploration: CLI And Desktop

## Table of Contents
- [CLI](#cli)
- [Desktop](#desktop)
- [Why These Two Packages Matter Together](#why-these-two-packages-matter-together)
- [Sources](#sources)

## CLI
The CLI is defined in `packages/cli/src/cli.ts` and uses Commander to expose both top-level shortcuts and grouped subcommands. The visible design choice is that common agent operations such as `ls`, `run`, `attach`, `logs`, `stop`, `delete`, `send`, `inspect`, `wait`, and `archive` are promoted to the top level, while daemon, chat, terminal, loop, schedule, permit, provider, speech, and worktree commands remain grouped under dedicated namespaces.[S1]

That structure matches the architecture: the CLI is not a second implementation of agent management, only a command-oriented front end over the daemon's WebSocket protocol and shared client library.[S1][S2]

The clearest example is `commands/agent/run.ts`. It validates options such as prompt, worktree/base consistency, timeout parsing, and structured-output schema handling; then it connects to the daemon, creates the agent, optionally waits for completion, and can recover the final assistant message by querying the daemon timeline if needed.[S2]

## Desktop
The Electron main process in `packages/desktop/src/main.ts` initializes logging, imports the login shell environment, isolates `userData` for git worktrees in dev mode, registers the custom `paseo://` protocol, sets up the pending open-project flow, creates the main BrowserWindow, and applies the single-instance lock and app lifecycle rules.[S3]

The important architectural point is that the desktop package is not only a shell around the web app. It also supervises a local daemon through `daemon-manager.ts`.[S3][S4]

`daemon-manager.ts` resolves the local Paseo home, polls for daemon status, starts a detached daemon process when needed, restarts on app/daemon version mismatch, tails `daemon.log` on failure, and exposes desktop-only IPC for local transport, updates, managed attachments, pairing offers, and integration installation flows.[S4]

That makes Electron the only package in the repo that owns both a privileged app runtime and daemon supervision at the same time.[S3][S4]

## Why These Two Packages Matter Together
The CLI and desktop package are the two non-mobile client surfaces that prove the daemon boundary is real. The CLI consumes the daemon as a remote API. The desktop shell embeds the web app but still treats the daemon as a separate managed process. Both packages reinforce the same architectural rule: client features should sit on top of daemon capabilities, not reimplement them locally.[S1][S2][S3][S4]

## Sources
- [S1] `packages/cli/src/cli.ts#L1-L163`, CLI command topology and output/daemon host options.
- [S2] `packages/cli/src/commands/agent/run.ts#L1-L280`, agent run flow, structured-output support, and daemon interaction.
- [S3] `packages/desktop/src/main.ts#L1-L260`, Electron shell bootstrap, protocol setup, window creation, and single-instance behavior.
- [S4] `packages/desktop/src/daemon/daemon-manager.ts#L1-L260`, daemon supervision, status polling, and desktop-only IPC surface.
