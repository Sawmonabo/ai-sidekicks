# ADR-033: One Provider Process Per Session

| Field         | Value                      |
| ------------- | -------------------------- |
| **Status**    | `accepted`                 |
| **Type**      | `Type 2 (one-way door)`    |
| **Domain**    | Provider Runtime, Accounts |
| **Date**      | 2026-09-21                 |
| **Author(s)** | Claude (AI-assisted)       |
| **Reviewers** | Sawmon Abo                 |

---

## Context

A session's lead sidekick is a provider's command-line program, Claude Code or Codex, run by the daemon as a child process. A provider account is a credential home on disk ([Spec-026](../specs/026-provider-accounts-and-credential-homes.md)); a process reads its credentials from the home it was started in. A person can save several accounts for one provider. A session's spend is shown per account, the provider keeps its own session file under the home the process was started in, and the transcript is rebuilt from the session's event log ([ADR-029](029-canonical-transcript-is-authoritative.md)).

## Problem Statement

How many provider processes does a session have, which account does each run on, and when can the account change?

### Trigger

The locked console design lets a person switch a running session to another saved account and ask a side question without disturbing the conversation. Both raise the question of a second process, and the answer shapes the daemon's supervision, the cost rows and the command list.

---

## Decision

A session has **one long-lived provider process, on one account**.

- A session starts on the account marked as its provider's default at the moment the session is created.
- It can move to another saved account of the same provider, and **only at the run boundary**. The pick is recorded as one durable pending switch, a later pick replaces it, and when the current run ends the daemon starts a new process in the new account's credential home with the canonical transcript replayed ([Spec-014 §Same-Agent Provider Switch](../specs/014-multi-agent-channels-and-orchestration.md#same-agent-provider-switch)).
- A switch never applies mid-run at the sidekick's next tool call.
- A run is a turn on the session's one process, and the account is fixed for that run's lifetime, which is the property [Spec-026 §Concurrency Posture](../specs/026-provider-accounts-and-credential-homes.md#concurrency-posture) rests on.
- The side question (the console's `/btw` word) is answered by a **second, short-lived, read-only process** that is not a second lead: on Claude Code a process started on a fork of the session in plan permission mode, on Codex an ephemeral thread fork. It takes one turn, keeps nothing, and its cost lands on the session's own account.

### Thesis — Why This Option

- **One turn on two accounts cannot be shown honestly.** A mid-run switch would have to appear in the transcript, split one turn across two cost rows, and leave half a turn in each account's provider session file. At the run boundary none of those is split.
- **The process is the unit the providers give us.** Credentials, the working directory, the loaded commands and the tool servers are all fixed when a provider process starts. A new account therefore means a new process, and the transcript replay that a provider switch already uses carries the conversation across.
- **One process keeps the inventory readable.** One lead process per live session, plus a side-question process that lives for one turn, is a bound a person can read in a process list.
- **The command list stays truthful.** The list a session shows is bound to the live process, so a new process brings a new list at a moment the person chose.

### Antithesis — The Strongest Case Against [T2]

A person who hits a quota wall mid-run wants to switch accounts now, not after a run that cannot finish. Holding the switch to the run boundary makes them interrupt first. A pool of warm processes, one per account, would make the switch instant and would also make the side question free.

### Synthesis — Why It Still Holds [T2]

A run that has hit a quota wall has already ended or will end on the provider's refusal, so the boundary arrives by itself and the pending switch applies then; a person who wants it sooner interrupts, which is one press. A warm pool multiplies resident processes by the number of saved accounts for a benefit measured in seconds, a few times a week. The side question is rare and read-only, so a process that lives for one turn costs less than one that waits all day.

---

## Alternatives Considered

### Option A: One long-lived process, account switch at the run boundary (Chosen)

- **What:** As decided above.
- **Steel man:** Every turn belongs to exactly one account, one process and one provider session file.
- **Weaknesses:** A switch waits for the run to end.

### Option B: Switch accounts mid-run (Rejected)

- **What:** Apply the switch at the sidekick's next tool call.
- **Steel man:** The fastest escape from a quota wall.
- **Why rejected:** One turn would span two accounts in the transcript, the cost rows and two provider session files, and a process cannot change credential home without restarting, so the turn would be torn anyway.

### Option C: A warm process per saved account (Rejected)

- **What:** Keep one idle provider process per account per session.
- **Steel man:** Instant switches and a ready side-question process.
- **Why rejected:** Process count grows with accounts times sessions, each holding memory and a provider connection, for an act that is rare.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | A provider process cannot change credential home while running | Both providers read credentials from their home at start ([Spec-026](../specs/026-provider-accounts-and-credential-homes.md)) | A mid-run switch would be possible, but its accounting problems remain |
| 2 | Transcript replay reproduces enough of the conversation on the new account | It is the mechanism the provider switch already specifies, with its declared-loss list | The switch would lose context; the loss list must say so to the person |
| 3 | Both providers offer a read-only, throwaway fork for the side question | Claude Code resumes a session as a fork in plan permission mode; Codex forks a thread as ephemeral | The side question would need a different carrier on that provider, or degrade honestly |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The new process fails to start on the new account | Med | Med | The start returns an error | The session stays on its current account and says why; the pending switch stays until it is replaced or the person clears it |
| A side-question process outlives its turn | Low | Med | The process inventory shows more than one process for the session | The daemon owns its lifetime and ends it when the turn ends or the session closes |
| A provider adds in-process account switching | Low | Low | Provider release notes | Adopt it behind the same run-boundary rule; the accounting argument is unchanged |

## Reversibility Assessment

- **Reversal cost:** Weeks. Supervision, cost attribution, the pending-switch column and the command-list subscription all assume one process.
- **Blast radius:** [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md), [Spec-014](../specs/014-multi-agent-channels-and-orchestration.md), [Spec-026](../specs/026-provider-accounts-and-credential-homes.md) and the session screen's inspector.
- **Migration path:** None before release.
- **Point of no return:** When cost history attributed per account and per turn exists on people's machines.

## Consequences

### Positive

- Every turn has one account, one process and one cost row.
- The process inventory per session is one, plus one for the length of a side question.

### Negative (accepted trade-offs)

- An account switch waits for the run to end. Accepted because interrupting is one press.

### Unknowns

- How long transcript replay takes on a very long session. Measured when the switch is built, against a budget set before it.

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [x] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Lead provider processes per live session | Exactly one | The daemon's process inventory under a test that switches accounts and asks a side question | When the account switch lands |

---

## References

No outside research was needed; the decision rests on the specifications linked above.

### Related ADRs

- [ADR-028: Provider Credential Custody Posture](028-provider-credential-custody-posture.md) — what a credential home is and who may read it.
- [ADR-029: Canonical Transcript Is Authoritative](029-canonical-transcript-is-authoritative.md) — the transcript that is replayed into the new process.

## Decision Log

| Date       | Event    | Notes                            |
| ---------- | -------- | -------------------------------- |
| 2026-09-21 | Accepted | Decided with the console design. |
