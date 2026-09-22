# ADR-033: One Claude Code Process Per Session, One Codex Service Per Account

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

A session's lead agent is a provider's command-line program, Claude Code or Codex, run by the daemon as a child process. A provider account is a credential home on disk ([Spec-026](../specs/026-provider-accounts-and-credential-homes.md)); a process reads its credentials from the home it was started in. A person can save several accounts for one provider. A session's spend is shown per account, the provider keeps its own session file under the home the process was started in, and the transcript is rebuilt from the session's event log ([ADR-029](029-canonical-transcript-is-authoritative.md)).

## Problem Statement

How many provider processes does a session have, which account does each run on, and when can the account change?

### Trigger

The locked console design lets a person make another saved account the current one for a provider while sessions are running on it, and lets them ask a side question without disturbing the conversation. Both raise the question of a second process, and the answer shapes the daemon's supervision, the cost rows and the command list.

---

## Decision

A session's lead runs on **one account, and the carrier depends on the provider**: a Claude Code session has **one long-lived process of its own**, and a Codex session is a conversation on **one shared service per account** — `codex app-server --listen unix://<the account home's control socket>`, holding every Codex conversation the daemon runs on that account, spoken to over the websocket that socket answers ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). Claude Code stays one process per session because that provider offers nothing else.

- A session starts on the account marked as its provider's default at the moment the session is created.
- It moves to another saved account of the same provider when the person makes that account the provider's current one on the provider settings page. An idle session moves at once; a busy one moves **at its next tool call** ([Spec-026 §Moving a session to another account](../specs/026-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)).
- The move is a new carrier, because credentials are read from the home a process starts in. The daemon holds the turn at the boundary the pause mechanism already holds at, interrupts it there, copies the provider's own conversation file into the new account's home, reopens it there through **the provider's own resume**, and continues the work in a new run on the new account. On Claude Code the new carrier is a new process. On Codex it is the other account's service, and the old one lets go first: the daemon unsubscribes the conversation there, waits for that service's own unload, and only then resumes the copied file in the new account's service, so no conversation is ever held by two services at once.
- A run is a turn on the session's one carrier, and **one run carries one account for its whole life** — the property [Spec-026 §Concurrency Posture](../specs/026-provider-accounts-and-credential-homes.md#concurrency-posture) rests on. The boundary a switch needs is one the daemon creates at the next tool call, not one it waits for.
- The session's spend keeps counting across the move: the work before it stays under the account it ran on, the work after it goes under the new one, and the session's total sums both. The accountant re-baselines on the new carrier's own counters, because a provider's cumulative figure restarts with the process it is read from; that per-carrier figure is an input to the baseline and never something the person is shown. On the Codex leg the figure is per conversation even though the process is shared: the service reports usage per thread (`thread/tokenUsage/updated` names the thread it counts, measured 2026-09-21 at 0.155.1, [codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)), so a service holding several conversations attributes spend to each without a split of ours.
- **Nothing of the daemon's stops that carrier while a session needs it**: no idle timer, no memory-pressure stop, no fixed bound of any kind. It ends when the person ends the session or when the provider exits on its own, and a Codex service outlives any one conversation on it. Both providers keep their own background work, their pending wake-ups and their helper conversations inside that process, so a stop of ours would end them unseen; memory is a matter of what is started, never of what is killed. Two things are not stops of ours: a service that dies is restarted by the daemon and every conversation in it resumed through the provider's own resume, each session's transcript carrying one faint row that says so; and the provider's own unloading of an idle conversation nobody is subscribed to, which it reloads from that conversation's own file, is the provider stopping its own state.
- **Four conditions hold the Codex leg up**, and it rests on all four. A conversation's folder, its configuration and its tool servers are its own, passed at `thread/start` and never as a flag on the shared service — for a conversation the daemon starts; a terminal session that joins takes the service's own folder, measured 2026-09-21 ([codex.md §A second seat on the shared service](../reference/provider-wire/codex.md#a-second-seat-on-the-shared-service)), so the folder the daemon starts a service in is load-bearing until the provider carries the joining client's folder, so two sessions on one service can differ in every one of them. A change to a conversation the service already holds — its configuration, its base instructions, its developer instructions — is measured before it is relied on, and until it is, such a change waits for the conversation to be reopened. A session moving to another account waits for the old service to release it, as the move bullet above says. And on a daemon restart the service comes back on the same socket before the daemon starts anything else: a session attached to it reconnects by itself when the service returns within about five seconds, and has given up by about twenty-four, after which that session's row says so and offers the provider's own resume, `codex resume <thread id>`, its transcript kept ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). **The account is the sharing key, never who started the session**: the service lives in one account's credential home, so a session this product runs and a session the person typed in a terminal share the service of the account they are on, and a session on another account is on another service.
- The side question (the console's `/btw` word) is answered by a **second, short-lived, read-only process** that is not a second lead: on Claude Code a process started on a fork of the session in plan permission mode, on Codex an ephemeral thread fork. It takes one turn, keeps nothing, and its cost lands on the session's own account.

### Thesis — Why This Option

- **A run on two accounts cannot be shown honestly, so the daemon makes a boundary instead of tearing one.** A switch applied inside a step would leave half of that step in each account's provider session file and leave the run itself unable to say which account it ran on. Holding at the next tool call, ending the run there and continuing the work in a new run splits neither — and it costs the person one tool call instead of a whole run. The person's own turn does continue across the move, and its spend lands as two account rows under one total, which is the shape the receipt is built for rather than a split it cannot represent.
- **The carrier is the unit each provider gives us, and each provider's own resume carries the conversation across.** Credentials are fixed when a provider process starts, so a new account means a new carrier on either leg. Claude Code fixes the working directory, the loaded commands and the tool servers at start too, which is why its carrier is one process per session; Codex takes all of those per conversation at `thread/start`, which is what makes one service per account the provider's own shape rather than a trick of ours. Both providers find and reopen their own conversation file after it is copied into a different credential home, so nothing of the conversation is re-sent as text.
- **One carrier per provider keeps the inventory readable, and the shared one is markedly cheaper.** One lead process per live Claude Code session, one service per Codex account however many conversations sit on it, plus a side-question process that lives for one turn, is a bound a person can read in a process list. A Codex session joined to a service holds about 17 MB of real memory against about 58 MB standing alone, the service itself about 40 MB with one client, measured at Codex `0.155.1` ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)).
- **The command list stays truthful.** The list a session shows is bound to the live carrier, so a new carrier brings a new list at a moment the person chose.

### Antithesis — The Strongest Case Against [T2]

A person who hits a quota wall wants the switch to be instant, and one tool call is not instant: a turn stuck in a long tool call holds the old account until that call ends. A pool of warm processes, one per account, would make the switch immediate on both legs and would also make the side question free.

### Synthesis — Why It Still Holds [T2]

One tool call is the shortest wait that keeps a turn whole, and it is short: an agent reaches a tool boundary every few seconds through ordinary work. A person who will not wait even that long interrupts, which is one press, and the switch then applies at once. A warm pool multiplies resident processes by the number of saved accounts for a benefit measured in seconds, a few times a week; the Codex service is not that pool, because it is one process a running session is already using rather than one kept idle against a switch that may never come. The side question is rare and read-only, so a process that lives for one turn costs less than one that waits all day.

---

## Alternatives Considered

### Option A: One long-lived carrier per session — a process on Claude Code, a shared service per account on Codex — account switch at the next tool call (Chosen)

- **What:** As decided above. The daemon holds at the tool boundary, ends the turn there, and continues the work in a new run on the new account through the provider's own resume.
- **Steel man:** Every turn belongs to exactly one account, one carrier and one provider session file, and the person waits one tool call rather than a whole run.
- **Weaknesses:** A turn inside a long tool call holds the old account until that call ends.

### Option B: Hold the switch until the run ends on its own (Rejected)

- **What:** Record the pick as a pending switch and apply it when the current run finishes.
- **Steel man:** The boundary arrives without the daemon doing anything, and a pending intent is simple to store.
- **Why rejected:** Across a long run it is indistinguishable from being ignored, and it makes the person interrupt their own work to get the thing they already asked for. The accounting it was protecting is protected just as well by a boundary the daemon makes one tool call away.

### Option C: A warm process per saved account (Rejected)

- **What:** Keep one idle provider process per account per session.
- **Steel man:** Instant switches and a ready side-question process.
- **Why rejected:** Process count grows with accounts times sessions, each holding memory and a provider connection, for an act that is rare.

### Option F: One Codex process per conversation (Superseded 2026-09-21)

- **What:** The Codex leg as this record first decided it — every Codex conversation in a process of its own, exactly as the Claude Code leg.
- **Steel man:** One line in a process list per session, nothing shared between two sessions, and the two legs identical to read and to supervise.
- **Why superseded:** The provider is built for the other shape and says so — many conversations in one service, each conversation's folder, configuration and tool servers its own at `thread/start`, and an idle conversation unloaded and reloaded by the provider itself — while a process each costs what a service does not: a joined Codex session holds about 17 MB of real memory against about 58 MB standing alone, the service about 40 MB with one client, at Codex `0.155.1` ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). The four conditions in §Decision are what the move costs; the Claude Code leg keeps this option because that provider offers nothing else.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | A provider process cannot change credential home while running, a Codex service included, its control socket living in that home | Both providers read credentials from their home at start ([Spec-026](../specs/026-provider-accounts-and-credential-homes.md)); the service's socket is a path under the account's Codex home ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)) | A mid-run switch would be possible, but its accounting problems remain |
| 2 | Each provider reopens its own conversation file after it is copied into another account's credential home | Measured on both legs: a Claude transcript copied into a fresh signed-out home is found and loaded by that provider's own resume, and a Codex rollout copied into a fresh home is listed and resumed with the same identifier and turn — both up to the model call, which needs a second account to run | The move falls back to replaying the conversation as text, and the row says the conversation was restarted rather than continued |
| 3 | Both providers offer a read-only, throwaway fork for the side question | Claude Code resumes a session as a fork in plan permission mode; Codex forks a thread as ephemeral | The side question would need a different carrier on that provider, or degrade honestly |
| 4 | A Codex conversation the service already holds takes a change to its configuration, base instructions or developer instructions | Not established: the provider takes all three at `thread/start`, and whether a later change reaches a loaded conversation is the measurement the Codex leg's second condition demands before anything relies on it | A session changing any of the three waits for its conversation to be reopened, which is a reopen the person does not see and the row does not claim |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The new process fails to start on the new account | Med | Med | The start returns an error | The session stays on the account it was on and says why; the current mark does not move |
| A side-question process outlives its turn | Low | Med | The process inventory shows more than one process for the session | The daemon owns its lifetime and ends it when the turn ends or the session closes |
| The shared Codex service dies | Med | Med | The daemon's websocket seat on its control socket drops | The daemon brings it back on the same socket and resumes every conversation in it through the provider's own resume, one faint row per session; a session whose own attachment gave up past the provider's reconnect window reads `stopped responding` and offers `codex resume <thread id>` |
| A provider adds in-process account switching | Low | Low | Provider release notes | Adopt it; the turn would no longer have to end, and the accounting argument is unchanged because one turn would still carry one account |

## Reversibility Assessment

- **Reversal cost:** Weeks. Supervision, cost attribution and the command-list subscription all assume one process per Claude Code session and one service per Codex account.
- **Blast radius:** [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md), [Spec-014](../specs/014-multi-agent-channels-and-orchestration.md), [Spec-026](../specs/026-provider-accounts-and-credential-homes.md), and the provider settings page the switch lives on.
- **Migration path:** None before release.
- **Point of no return:** When cost history attributed per account and per turn exists on people's machines.

## Consequences

### Positive

- Every turn has one account, one carrier and one cost row.
- The inventory is one process per live Claude Code session, one service per Codex account, plus one process for the length of a side question — so a person running several Codex sessions on one account pays for one service rather than for each of them.

### Negative (accepted trade-offs)

- An account switch waits for the turn to reach its next tool call, so a long tool call delays it. Accepted because interrupting is one press and the wait is seconds rather than a run.

### Unknowns

- Whether a conversation resumed under a second account's own login runs a model turn cleanly. Measured when the switch is built, on two real accounts; the cross-home resume itself is measured on both legs up to that call.

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
| Lead carriers | One process per live Claude Code session; one service per Codex account, whatever the number of conversations on it | The daemon's process inventory under a test that switches accounts mid-turn and asks a side question | When the account switch lands |

---

## References

No outside research was needed; the decision rests on the specifications linked above.

### Related ADRs

- [ADR-028: Provider Credential Custody Posture](028-provider-credential-custody-posture.md) — what a credential home is and who may read it.
- [ADR-029: Canonical Transcript Is Authoritative](029-canonical-transcript-is-authoritative.md) — the transcript that stands in where a provider's own resume cannot reopen the conversation.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-09-21 | Accepted | Decided with the console design. |
| 2026-09-21 | Codex leg amended | Codex moves from one process per session to one service per account home, with the four conditions in §Decision; the Claude Code leg is unchanged. Decided with the console design on the measured shape of the shared `app-server`. |
