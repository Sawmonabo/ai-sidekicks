# Provider Failure Runbook

## Purpose

Diagnose and contain driver-level provider failures that affect run execution or recovery.

## Symptoms

- New runs fail during `starting`
- Active runs transition to `failed` with `provider failure` detail or visible `recovery-needed` condition
- Driver capability data is missing or inconsistent
- Scope and blast radius: one provider driver, one RuntimeNode, or all nodes using the same driver

## Detection

- Read `HealthStatusRead` and `FailureDetailRead` for the affected run or RuntimeNode.
- Inspect driver capability refresh status and the latest `RuntimeBindingRead` for affected recovery handles.
- Compare canonical failure events with driver logs for startup failure, transport failure, capability refresh failure, or resume failure.

## Preconditions

- Access to the affected RuntimeNode
- Access to driver logs and runtime binding state
- Ability to disable new scheduling to the affected driver if needed

## Recovery Steps

1. Identify whether the failure is startup, active-run, capability-refresh, or resume-related.
2. Stop routing new work to the affected driver until health is understood.
3. If the failure is recovery-related, issue one bounded `RecoveryActionRequest` for driver health refresh and resume-handle adoption or resume.
4. If resume is impossible or the bounded recovery action fails, mark affected runs as `failed` with `provider failure` detail and visible `recovery-needed` condition rather than silently recreating sessions.
5. Re-enable scheduling only after a known-good test run starts, streams events, and reaches a terminal or valid blocking state normally.

## Validation

- Driver health returns to expected status
- Capability projection matches supported controls
- One test run succeeds or blocks cleanly without unexpected driver errors
- No affected run remains stuck in a non-terminal state without updated failure or recovery detail

## Provider Re-Authentication (Per Account)

Use when one registered provider account's credentials have expired or been revoked while other accounts on the same node stay healthy. Scope and blast radius: **one account and its own credential home**, never the node and never the provider. Each account's credential material lives in its own daemon-managed home, so repairing one account cannot disturb another, and runs bound to the node's other accounts keep running throughout ([Spec-029 §Credential homes and the constructed environment](../specs/029-provider-accounts-and-credential-homes.md#credential-homes-and-the-constructed-environment)).

The daemon refuses rather than substitutes. A run whose bound account is unregistered, whose credential home is missing or husked, or whose authentication probe reports anything other than `authenticated`, is refused **before spawn** with a typed refusal and no provider process is created — there is no fallback to the operator's ambient provider configuration, to the provider's default account, or to another registered account ([Spec-029 §Validation at spawn — fail-closed](../specs/029-provider-accounts-and-credential-homes.md#validation-at-spawn--fail-closed)). The refusal is the intended state, not a fault to route around.

Detection: the account's authentication probe reports other than `authenticated`; a run bound to it refuses before spawn; or a mid-run credential expiry surfaces the `reauth-required` recovery condition. Probe state is per `(driver, account)` — read it for the specific account, because a healthy sibling account says nothing about this one.

1. Identify the affected account by its `accountId`, taken from the typed refusal or from the run's `admittedProviderAccountId` admission stamp. Do not act on the provider name alone: a node may hold several accounts per provider and only one may be affected.
2. Record that account's current `credentialGeneration` before changing anything. It is the evidence the repair actually landed.
3. Probe every registered account of that provider and establish the blast radius. Only accounts reporting other than `authenticated` are in scope; leave the rest untouched and let their runs continue. If accounts on unrelated homes are failing too, this is not an account-scoped credential failure — treat it as a driver-level failure and return to Recovery Steps above.
4. Work on the affected node itself. Registration, removal, default change, and credential-home reset are node-local operator authority; a control-plane-relayed attempt is denied, never queued ([Spec-029 §Authorization Posture](../specs/029-provider-accounts-and-credential-homes.md#authorization-posture)).
5. Do not remove the account, and do not point it at another account's home. Removal is refused while a run bound to the account is live, and when permitted it forgets the registry row without deleting the home — it forgets the account, it does not repair it. Pointing two accounts at one home is forbidden on every path including recovery: a shared home is the credential-corruption case per-account isolation exists to prevent ([Spec-029 §Fallback Behavior](../specs/029-provider-accounts-and-credential-homes.md#fallback-behavior)).
6. Where the account's home is absent, or present but husked (holding no usable credential), issue the registry's credential-home reset for that account through the node-local `providerAccount.*` surface before re-authenticating.
7. Re-authenticate the provider CLI **into that account's own credential home** — the same home the daemon points the provider child at through its reserved, daemon-set credential-home variable. The credential stays in the home: the daemon brokers the provider's own refresh mechanism and never stores, logs, relays, or serves the material ([Spec-029 §Credential-refresh brokering](../specs/029-provider-accounts-and-credential-homes.md#credential-refresh-brokering)).
8. Re-run that account's authentication probe and wait for `authenticated` before restarting work.
9. Restart the affected work. A resume re-realizes the same account from the durable spawn-bound record and refuses again while the probe is not `authenticated`; a resume never silently rebinds to the default account ([Spec-029 §Selection at run start](../specs/029-provider-accounts-and-credential-homes.md#selection-at-run-start)).

**Validation**:

- The affected account's probe reports `authenticated`, and every other account of that provider reports what it reported before.
- The account's `credentialGeneration` is strictly greater than the value recorded in step 2. A completed re-authentication, a home reset, and a probe transition into or out of `authenticated` each bump it, so check for an increase rather than a specific increment; an unchanged generation means no lifecycle transition was observed and the repair is not recorded ([Spec-029 §Account identity and credential generation](../specs/029-provider-accounts-and-credential-homes.md#account-identity-and-credential-generation)).
- The account's `accountId` is unchanged. Identity is stable across re-authentication — a new id means an account was re-registered, not repaired.
- One test run bound to the affected account spawns, streams events, and reaches a terminal or valid blocking state normally.
- One run bound to a healthy sibling account of the same provider ran uninterrupted throughout.
- No two registered accounts share a credential-home path.

## Provider Usage-Limit Outage

Use when a provider reports that the account's plan allowance is spent. **This is a pacing fact with a reset boundary — not a credential failure and not an operator-reconciliation condition.** The distinction is operational, not taxonomic: re-authenticating repairs nothing here and is actively harmful, because a completed re-authentication bumps the account's `credentialGeneration` and thereby ends the outage's attention epoch, splitting one outage into two attention records. Nor is it `recovery-needed` — that condition means a human must reconcile something, while a spent allowance needs no operator at all. The usage-limit signal is a sibling axis beside the closed `RecoveryCondition` set, never a member of it, so finding no `RecoveryCondition` value on a park is correct rather than missing data ([Spec-017 §Provider-limit pacing and durable resumption (SA-40)](../specs/017-workflow-authoring-and-execution.md#provider-limit-pacing-and-durable-resumption-sa-40)).

Recognition is typed and only typed: the refusal is recognized from the driver's normalized usage-limit signal, which is account-scoped and keyed on `(accountId, credentialGeneration)`. Never classify from provider prose, an error string, a rate-limit window's name, or a model id. Until the driver carrier ships that typed signal (its declaration is owned by [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md)), a spent allowance is seen by the engine as an ordinary failure and travels the ordinary retry-and-fail path — steps 3 and 5 below apply only where the run actually parked.

1. Confirm the classification before acting: the run parked on the typed usage-limit signal, and the signal names an account. If the run instead failed on message text or exhausted its retries, do not force it into this classification — but note that until the typed carrier ships, an ordinary retry exhaustion is the expected shape of a spent allowance, and the account lever in steps 6 to 8 still applies to it. What applies to neither shape is re-authentication.
2. Identify the affected account by the `accountId` on the signal. The limit is scoped to the provider **account** — not to the node, not to the provider, and not to the session — so other accounts of the same provider are unaffected by it.
3. Read the reset boundary and its provenance from the park. Where the driver stamped the boundary provider-reported, the parked phase carries a durable auto-resume instant and the run resumes itself when the window opens; the schedule is per-phase, so branches parked against different accounts each keep their own boundary. Where the provenance is the driver's default or its estimate, or where no boundary was reported at all, **no schedule is armed** and the park is shown as parked-without-a-schedule rather than as a countdown — a derived boundary is the driver's admission that the number is a guess, and a guess is never displayed as a real reset. An unscheduled park is a normal, fully visible, fully resumable state, not a stuck run.
4. Do not read the boundary off the quota display. The account-scoped quota snapshot (`usage.rate_limit_update` — `{provider, windowMins, usedPercent, resetsAt?}`, carrying the account identity and the credential generation it was observed with) is a display surface only: its `resetsAt` carries no provenance stamp and is deliberately not an input to the park, to the schedule, or to admission. It is node-local — refreshed per runtime node and describing this node's view of that account's standing — so it is not a control-plane fact and another operator's node holds its own ([Spec-006 §Usage Telemetry](../specs/006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry), [Spec-029 §Provider quota is account-scoped](../specs/029-provider-accounts-and-credential-homes.md#provider-quota-is-account-scoped)).
5. Leave a scheduled park alone unless the work is needed before the boundary. The park spends no attempt and consumes none of the retry budget priced in SLOs and Thresholds below — it sits outside that ladder by design. Firing early costs exactly one refused attempt and re-parks honestly against whatever boundary is then in force.
6. Where progress is needed before the reset, direct **new** work at another registered account of the same provider: supply the per-run account override at run start, or move that provider's default account. A live run is never repointed — the account bound at admission is immutable for the run's lifetime, so the parked run keeps its own account and its own boundary ([Spec-029 §Selection at run start](../specs/029-provider-accounts-and-credential-homes.md#selection-at-run-start)).
7. Expect continued progress, not extra throughput. Until the cross-account concurrency probe establishes concurrency against the pinned provider binaries, runs bound to two accounts of one provider serialize, and that serialization is visible in run state rather than presented as slowness ([Spec-029 §Concurrency Posture](../specs/029-provider-accounts-and-credential-homes.md#concurrency-posture)).
8. Where no second account exists, register one on the node with its own label, its own credential home, and its own billing mode, then bring it to `authenticated` per [Provider Re-Authentication (Per Account)](#provider-re-authentication-per-account) before binding work to it. Never point the new account at the existing account's home.

**Validation**:

- The affected runs show a usage-limit park attributed to the correct `accountId` — not a `failed` run, and not a `recovery-needed` condition.
- Runs bound to the node's other provider accounts, of this provider and of others, continued unaffected.
- Where the boundary was provider-reported, the parked run resumed itself at the boundary with no operator action; where it was not, the park is visibly unscheduled and no countdown is displayed.
- The affected account's `credentialGeneration` is unchanged. If it moved, an account that was never broken was re-authenticated, and the outage's single attention record has split.
- The account's quota snapshot carries that account's identity, and a two-account node attributes each snapshot to the correct account.
- No run was re-bound to a different account mid-flight, and no two accounts resolve to one credential home.

## Escalation

- Escalate when a driver regression affects multiple nodes, resume failures are systemic, or provider transport semantics have changed without a compatible driver update

## CLI Commands

```bash
sidekicks driver status
sidekicks driver capabilities <driver-name>
sidekicks run retry <run-id>
sidekicks driver health <driver-name>
sidekicks driver logs <driver-name> --tail 50
sidekicks run inspect <run-id> --failure-detail
```

## SLOs and Thresholds

| Metric                                    | Target                                            |
| ----------------------------------------- | ------------------------------------------------- |
| Provider response timeout                 | 30s                                               |
| Retry budget                              | 3 attempts with exponential backoff (1s, 5s, 15s) |
| Provider driver capability probe interval | every 15s                                         |
| Capability refresh latency                | < 5s                                              |
| Recovery action timeout                   | 60s                                               |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Provider issues route to **integrations on-call**.

## Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Provider Driver Contract And Capabilities](../plans/005-provider-driver-contract-and-capabilities.md)
