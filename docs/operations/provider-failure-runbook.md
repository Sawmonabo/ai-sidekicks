# Provider Failure Runbook

## Purpose

Diagnose and contain driver-level provider failures that affect run execution or recovery.

## Symptoms

- New runs fail during `starting`
- Active runs transition to `failed` with `provider failure` detail or visible `recovery-needed` condition
- Driver capability data is missing or inconsistent
- Scope and blast radius: one provider account, one provider on this machine, or every session on one provider

## Detection

- Read the failure category the affected run's state-transition events carry, and run `sidekicks daemon status` on the machine.
- Read the provider's line on Settings › Providers, which says one of three things: installed and signed in with its version, `Not installed.`, or `Cannot tell right now.` `Check again` reads it again, and a provider re-reads what it can do when its command path changes, when a provider process starts, and when its model catalog goes stale.
- Compare canonical failure events with driver logs for startup failure, transport failure, capability refresh failure, or resume failure.

## Preconditions

- The `sidekicks` command line on the affected machine
- Access to the daemon's diagnostic logs on that machine
- Settings › Providers for that machine, where `Available for new sessions` stops new sessions starting on one provider

## Recovery Steps

1. Identify whether the failure is startup, active-run, capability-refresh, or resume-related.
2. Turn off `Available for new sessions` for the affected provider on Settings › Providers until the failure is understood.
3. If the failure is recovery-related, press `Check again` on Settings › Providers to read the provider again, then `Restart` on a session that shows its provider ended; the daemon resumes that session's conversation. When a Claude Code process or a Codex service dies, the daemon restarts it at once and then on waits that double from 1 second, resuming a service's conversations; after five crashes within three minutes it leaves it down, and each of its sessions shows that the provider ended, with `Restart`.
4. If resume is impossible or the restart fails, mark affected runs as `failed` with `provider failure` detail and visible `recovery-needed` condition rather than silently recreating sessions.
5. Turn `Available for new sessions` back on only after a known-good test run, sent in a session already on that provider, starts, streams events, and reaches a terminal or valid blocking state normally.

## Validation

- Settings › Providers reads the provider as installed and signed in, with its version
- Capability projection matches supported controls
- One test run succeeds or blocks cleanly without unexpected driver errors
- No affected run remains stuck in a non-terminal state without updated failure or recovery detail

## Provider Re-Authentication (Per Account)

Use when one registered provider account's credentials have expired or been revoked while other accounts on the same node stay healthy. Scope and blast radius: **one account and its own credential home**, never the node and never the provider. Each account's credential material lives in its own daemon-managed home, so repairing one account cannot disturb another, and runs bound to the node's other accounts keep running throughout ([Spec-025 §Credential homes and the constructed environment](../specs/025-provider-accounts-and-credential-homes.md#credential-homes-and-the-constructed-environment)).

The daemon refuses rather than substitutes. A run whose bound account is unregistered or whose credential home is missing is refused **before spawn** with a typed refusal and no provider process is created; a run on an account whose login has gone starts and meets the provider's own refusal. Neither falls back to the person's ambient provider configuration, to the provider's current account, or to another registered account ([Spec-025 §Validation at spawn — fail-closed](../specs/025-provider-accounts-and-credential-homes.md#validation-at-spawn--fail-closed)). The refusal is the intended state, not a fault to route around.

Detection: **normally Settings › Providers says so before any run does** — the background observation reads each account's own limits every five minutes, and an account whose login has gone reads `Login expired · Sign in again` on its row with the sign-in beside it, which is the front door to this procedure ([Spec-025 §Credential-home health observation](../specs/025-provider-accounts-and-credential-homes.md#credential-home-health-observation)). The other three arrivals are the account's authentication probe reporting other than `authenticated`, a run bound to it meeting the provider's own sign-in refusal, and a mid-run credential expiry surfacing the `reauth-required` recovery condition. Probe state is per `(driver, account)` — read it for the specific account, because a healthy sibling account says nothing about this one.

1. Identify the affected account by its `accountId`, taken from the typed refusal or from the run's `admittedProviderAccountId` admission stamp. Do not act on the provider name alone: a node may hold several accounts per provider and only one may be affected.
2. Record that account's current `credentialGeneration` before changing anything. It is the evidence the repair actually landed.
3. Probe every registered account of that provider and establish the blast radius. Only accounts reporting other than `authenticated` are in scope; leave the rest untouched and let their runs continue. If accounts on unrelated homes are failing too, this is not an account-scoped credential failure — treat it as a driver-level failure and return to Recovery Steps above.
4. Work from Settings › Providers for the affected machine, on that machine or on any linked device. Registration, removal, sign-in, a change of the provider's current account, and credential-home reset are open to the machine's own client and to every linked device, and to no session ([Spec-025 §Authorization Posture](../specs/025-provider-accounts-and-credential-homes.md#authorization-posture)).
5. Do not remove the account, and do not point it at another account's home. Removal is refused while a session runs on the account, naming the sessions (its `Sign out` is never refused), and when permitted it forgets the registry row without deleting the home and **without running the provider's own sign-out** — it forgets the account, it does not repair it, and on one leg a sign-out can end the login of the account being left. Pointing two accounts at one home is forbidden on every path including recovery: a shared home is the credential-corruption case per-account isolation exists to prevent ([Spec-025 §Fallback Behavior](../specs/025-provider-accounts-and-credential-homes.md#fallback-behavior)).
6. Where the account's home is absent, or present but husked (holding no usable credential), issue the registry's credential-home reset for that account through the machine's `providerAccount.*` surface before re-authenticating.
7. Re-authenticate the provider CLI **into that account's own credential home** — the same home the daemon points the provider child at through its reserved, daemon-set credential-home variable. **Use the machine's own brokered sign-in** (`providerAccount.login` on the `providerAccount.*` surface, which `Sign in` on the account's row on Settings › Providers calls). It spawns the provider's own **unmodified** binary with that account's home already pinned and hands you the provider's verification URL — and, where the provider publishes a device-code arm, a user code you can enter on any other device, which is how a headless node is re-authenticated without moving credential material between hosts. Cancel an attempt you cannot finish with `providerAccount.loginCancel` rather than abandoning it: at least one provider holds exactly one active login slot, and starting a second attempt silently drops the first. Where the provider publishes no device-code arm and the node has no browser, the remaining path is the non-interactive token the provider's own tooling mints — supplied on registration, never echoed, and sealed by the daemon outside the home ([Spec-025 §Non-interactive token registration](../specs/025-provider-accounts-and-credential-homes.md#non-interactive-token-registration)). The credential stays in the home: the daemon brokers the provider's own refresh mechanism, reads nothing the sign-in flow writes, and stores no credential material.
8. Re-run that account's authentication probe and wait for `authenticated` before restarting work.
9. Restart the affected work. A resume re-realizes the same account from the durable spawn-bound record; a resume never silently rebinds to whichever account is current now ([Spec-025 §Selection at run start](../specs/025-provider-accounts-and-credential-homes.md#selection-at-run-start)).

**Validation**:

- The affected account's probe reports `authenticated`, and every other account of that provider reports what it reported before.
- The account's `credentialGeneration` is strictly greater than the value recorded in step 2. A completed re-authentication, a home reset, and a probe transition into or out of `authenticated` each bump it, so check for an increase rather than a specific increment; an unchanged generation means no lifecycle transition was observed and the repair is not recorded ([Spec-025 §Account identity and credential generation](../specs/025-provider-accounts-and-credential-homes.md#account-identity-and-credential-generation)).
- The account's `accountId` is unchanged. Identity is stable across re-authentication — a new id means an account was re-registered, not repaired.
- One test run bound to the affected account spawns, streams events, and reaches a terminal or valid blocking state normally.
- One run bound to a healthy sibling account of the same provider ran uninterrupted throughout.
- No two registered accounts share a credential-home path.

## Provider Usage-Limit Outage

Use when a provider reports that the account's plan allowance is spent. **This is a pacing fact with a reset boundary — not a credential failure and not a condition for the person to reconcile.** The distinction is operational, not taxonomic: re-authenticating repairs nothing here and is actively harmful, because a completed re-authentication bumps the account's `credentialGeneration` and marks every stored quota reading as predating a change, while the allowance stays exactly as spent. Nor is it `recovery-needed` — that condition means a human must reconcile something, while a spent allowance needs nothing from the person at all. The usage-limit signal is a sibling axis beside the `RecoveryCondition` set, never a member of it, so finding no `RecoveryCondition` value on a park is correct rather than missing data ([Spec-015 §Provider-limit pacing and durable resumption (SA-37)](../specs/015-workflow-authoring-and-execution.md#provider-limit-pacing-and-durable-resumption-sa-37)).

Recognition is typed and only typed: the refusal is recognized from the driver's normalized usage-limit signal, which is account-scoped and keyed on `(accountId, credentialGeneration)`, and whose declaration is owned by [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md). Never classify from provider prose, an error string, a rate-limit window's name, or a model id.

1. Confirm the classification before acting: the run parked on the typed usage-limit signal, and the signal names an account. If the run instead failed on message text or exhausted the provider's own retries, do not force it into this classification; the account lever in steps 6 to 8 still applies to it. What applies to neither shape is re-authentication.
2. Identify the affected account by the `accountId` on the signal. The limit is scoped to the provider **account** — not to the node, not to the provider, and not to the session — so other accounts of the same provider are unaffected by it.
3. Read the reset boundary from the park. A boundary is present only where the provider stated the reset instant; where one is present, the waiting step carries a durable `resumeAt` and the run resumes itself when the window opens; the schedule is per-phase, so branches parked against different accounts each keep their own boundary. Where no boundary was reported, **no schedule is armed** and the step is shown waiting with no resume instant, `awaiting resume`, rather than as a countdown — the driver never fills in a default or an estimate, so a guess is never displayed as a real reset. An unscheduled park is a normal, fully visible, fully resumable state, not a stuck run.
4. Do not read the boundary off the quota display. The account-scoped quota snapshot (`usage.rate_limit_update` — `{provider, providerAccountId, credentialGeneration, limitId?, windowMins, usedPercent, resetsAt?}` keyed `(providerAccountId, limitId)`, carrying the account identity and the credential generation it was observed with) is a display surface only: its `resetsAt` carries no provenance stamp and is deliberately not an input to the park, to the schedule, or to admission. It is machine-local — refreshed on each machine and describing that machine's view of the account's standing — so it is not a control-plane fact, and another of the person's machines holds its own ([Spec-005 §Usage Telemetry](../specs/005-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry), [Spec-025 §Provider quota is account-scoped](../specs/025-provider-accounts-and-credential-homes.md#provider-quota-is-account-scoped)).
5. Leave a scheduled park alone unless the work is needed before the boundary. The park spends no attempt, and nothing retries it on the person's behalf. Firing early costs exactly one refused attempt and re-parks honestly against whatever boundary is then in force.
6. Where progress is needed before the reset, make another registered account of the same provider the provider's **current** one, on Settings › Providers or with `/account <name>` in a session's composer. Every running session on that provider that is not pinned to an account moves with the mark, in place, from its next request: the spend up to the provider's acknowledgment of the switch stays with the old account, and the spend after it goes to the new one ([Spec-025 §Moving a session to another account](../specs/025-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)). A session pinned to a specific account — a saved agent definition or a workflow step set to one — stays where it is pinned and keeps its own boundary ([Spec-025 §Selection at run start](../specs/025-provider-accounts-and-credential-homes.md#selection-at-run-start)).
7. Runs bound to the new account start at once, beside any still running on another account of the same provider; nothing serializes runs by account ([Spec-025 §Concurrency Posture](../specs/025-provider-accounts-and-credential-homes.md#concurrency-posture)).
8. Where no second account exists, register one on the node with its own label, its own credential home, and its own billing mode, then bring it to `authenticated` per [Provider Re-Authentication (Per Account)](#provider-re-authentication-per-account) before binding work to it. Never point the new account at the existing account's home.

**Validation**:

- The affected runs show a step `waiting` with cause `account`, folded under the correct account's attention entry (`providerAccountId`) — not a `failed` run, and not a `recovery-needed` condition.
- Runs bound to the node's other provider accounts, of this provider and of others, continued unaffected.
- Where a boundary was reported, the parked run resumed itself at the boundary with no action from the person; where it was not, the park is visibly unscheduled and no countdown is displayed.
- The affected account's `credentialGeneration` is unchanged. If it moved, an account that was never broken was re-authenticated.
- The account's quota snapshot carries that account's identity, and a two-account node attributes each snapshot to the correct account.
- No run changed account except by the provider-wide switch, and no two accounts resolve to one credential home.

## Escalation

- When a driver regression or systemic resume failure persists after these steps, or provider transport semantics have changed without a compatible driver update, report it to the project as a bug with the daemon's logs and the provider's version attached

## CLI Commands

```bash
sidekicks daemon status
```

A provider is read and checked again on Settings › Providers, and a run is read from its session; the command line has no `driver`, `run` or `provider-account` command.

## SLOs and Thresholds

| Threshold | Value |
| --- | --- |
| Providers' own retries | Claude Code retries a rate limit or an overload ten times over about three minutes; Codex retries a transport error; neither retries a plan limit |
| Provider process restart (a Claude Code process or a Codex service) | At once, then waits that double from 1 second; after five crashes within three minutes it stays down until `Restart` |
| Capability refresh latency | < 5s |

## Who Runs It And Where To Report

- The machine belongs to one person, who runs this procedure on it; there is no paging, no chat alert and no on-call rotation.
- A provider failure that stays after these steps is reported to the project as a bug, with the daemon's logs and the provider's version attached.

## Related Architecture Docs

- [Daemon Architecture](../architecture/daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Provider Driver Contract And Capabilities](../specs/004-provider-driver-contract-and-capabilities.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related Plans

- [Provider Driver Contract And Capabilities](../plans/003-provider-driver-contract-and-capabilities.md)
