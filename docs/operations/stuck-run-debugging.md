# Stuck Run Debugging

## Purpose

Diagnose runs that appear active but are no longer making observable progress.

## Symptoms

- The working line's clock keeps counting while its action words and the tokens received (`↓ 8.4k`) stop changing, and no new transcript row lands
- The action words read `Retrying…` for minutes
- Scope and blast radius: one run, sometimes every run on one provider account on the machine

## Detection

- Read the working line left to right. The action words say what the agent is doing (`Waiting for approval`, `Compacting…`, `Retrying…`, `Running pnpm test`), and the state word after the clock says `Paused`, `Interrupted` or `switching to account <name>`. Each of these is a valid wait, not a stuck run.
- Check whether the session waits on the person: the bell counts it, the session reads `Waiting on you`, and an approval, a question or a plan card is open in the composer.
- While any command runs, press the action words to open the running-commands list and read each command's live tail. A long command, such as a four-minute test run, is progress.
- Claude Code retries a rate limit or an overload silently for up to about three minutes while the line reads `Retrying…`, then lands one row, `<Provider> did not answer · Try again`. Codex fails the turn at once with one row, `Limit reached · resets at <time> · Try again`.
- On the machine, run `sidekicks daemon status`, and read the daemon's diagnostic logs for the run's provider. With tracing on (Settings › Runtime), the traces for the run are there too.

## Preconditions

- The session open on any of the person's linked devices, or on the machine itself
- The `sidekicks` command line on the machine that runs the session, for the daemon's status and logs

## Recovery Steps

1. Confirm the run is not in a valid wait: an open card, `Paused`, `Retrying…`, `Compacting…`, or a running command whose live tail is still moving.
2. To end one command only, press `Stop` on that command's row; it ends that command and nothing else.
3. To end the turn, press `Interrupt` at the end of the working line, or Escape. The agent in view stops its turn, the command it was running is ended, the agents it dispatched keep going, and it waits for a steer. To stop everything the session started, press `Interrupt everything`, or Ctrl+C with nothing selected and focus outside a terminal.
4. Continue by sending a steer or a new message, or use `Try again` on a failed row.
5. If the session shows that its provider ended, with `Restart`, press `Restart`. When a Codex service dies, the daemon restarts it at once and resumes its conversations; after three deaths within five minutes it leaves the service down, and each of its sessions shows that the provider ended, with `Restart`.
6. If nothing answers an interrupt, treat it as a provider or daemon failure and follow the [Provider Failure Runbook](./provider-failure-runbook.md) or the [Local Daemon Runbook](./local-daemon-runbook.md).

## Validation

- The run reaches a terminal state, or a valid wait the working line names
- The working line shows no queued message and no pending interrupt for the run
- A turn started with a steer, a new message or `Try again` shows in the same session's transcript

## Escalation

- When runs on one provider or in one workspace stall again and again and an interrupt does not clear them, report it to the project as a bug with the daemon's logs attached

## CLI Commands

```bash
sidekicks daemon status
```

A run is read and interrupted from its session; the command line has no `run` command.

## SLOs and Thresholds

| Threshold | Value |
| --- | --- |
| Claude Code silent retry | Up to about three minutes, while the working line reads `Retrying…` |
| Codex service restart | At once; after three deaths within five minutes it stays down until `Restart` |

## Who Runs It And Where To Report

- The machine belongs to one person, who runs this procedure on it; there is no paging, no chat alert and no on-call rotation.
- A stall that an interrupt does not clear, and that comes back, is reported to the project as a bug with the daemon's logs attached.

## Related Architecture Docs

- [Observability Architecture](../architecture/observability-architecture.md)
- [Daemon Architecture](../architecture/daemon.md)

## Related Specs

- [Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related Plans

- [Queue Steer Pause Resume](../plans/003-queue-steer-pause-resume.md)
- [Provider Driver Contract And Capabilities](../plans/004-provider-driver-contract-and-capabilities.md)
