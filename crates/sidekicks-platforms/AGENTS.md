# crates/sidekicks-platforms — operating-system rules

Applies to every change under `crates/sidekicks-platforms/`, where all operating-system code lives, on top of the [root `AGENTS.md`](../../AGENTS.md) and [`crates/AGENTS.md`](../AGENTS.md), which this file never restates.

## Spawning a child

- On Linux a `Command` child arms `PR_SET_PDEATHSIG` (SIGHUP) in its own `pre_exec`, then compares `getppid()` with the daemon's pid and exits on a mismatch.

## The socket path

- **A socket path** is checked with `std::os::unix::net::SocketAddr::from_pathname` (Windows: `uds_windows`' own check) before binding: std refuses an over-long path with `InvalidInput` before any system call, so no probe waits for `EINVAL`; one fresh test checks a path at the limit and one past it.

## Ctrl-C

The Ctrl-C ending the command line owes (exit 130 through `emulate_default_handler`, `STATUS_CONTROL_C_EXIT` on Windows) is specified in [`sidekicks-cli/AGENTS.md`](../sidekicks-cli/AGENTS.md#exit-codes-and-output); its handlers live here.
