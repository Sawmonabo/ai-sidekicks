# ADR-031: One Claude Code Process Per Session, One Codex Service Per Account

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

A session's lead agent is a provider's command-line program, Claude Code or Codex, run by the daemon as a child process. A provider account is a credential home on disk ([Spec-025](../specs/025-provider-accounts-and-credential-homes.md)); a Claude Code process reads its credential from the store folder it is pointed at, at each request, and a Codex service reads the sign-in of the home it runs in or the tokens the daemon hands it. A person can save several accounts for one provider. A session's spend is shown per account, the provider keeps its own session file under the home the process was started in, and the transcript is rebuilt from the session's event log ([ADR-027](027-canonical-transcript-is-authoritative.md)).

## Problem Statement

How many provider processes does a session have, which account does each run on, and when can the account change?

### Trigger

The console design lets a person make another saved account the current one for a provider while sessions are running on it, and lets them ask a side question without disturbing the conversation. Both raise the question of a second process, and the answer shapes the daemon's supervision, the cost rows and the command list.

---

## Decision

A session's lead runs on **one account, and the carrier depends on the provider**: a Claude Code session has **one long-lived process of its own**, and a Codex session is a conversation on **one shared service per account** — `codex app-server --listen unix://<the account home's control socket>`, holding every Codex conversation the daemon runs on that account, spoken to over the websocket that socket answers ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). Claude Code stays one process per session because that provider offers nothing else.

- A session starts on the account marked as its provider's default at the moment the session is created.
- It moves to another saved account of the same provider when the person makes that account the provider's current one on the provider settings page, unless an agent definition or a workflow step pins it to an account. **The move is in place, from the session's next request**, with no hold, interrupt, copy, resume or `continue` ([Spec-025 §Moving a session to another account](../specs/025-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)). On Claude Code the daemon sends each moving session `apply_flag_settings {env: {CLAUDE_SECURESTORAGE_CONFIG_DIR: "<the new account's store folder>"}}` (a pasted-token account rides `CLAUDE_CODE_OAUTH_TOKEN` on the same channel), and its next request runs on the new account: between turns the next turn's first request, mid-turn the model call after the step in flight, a running tool finishing and never repeated. On Codex every session that follows the current account runs in the one service the daemon keeps for the current account, which runs on tokens the daemon hands it with `account/login/start {type: "chatgptAuthTokens"}`, held only in the daemon's memory; the switch is one such call with the new account's tokens, and every conversation in that service uses the new account from its next request (measured: a replacement handed in while a 6-second command ran was accepted in 0.025 s, the command ran once, and the next model request went through on it). A session pinned to an account runs in that account's own service on its own sign-in and never moves.
- **The move is the same on every version.** Every installed version switches a session's account in place: no feature checks a version number, and there is no second way to move a session's account. A running tool finishes and is never repeated, nothing is interrupted, and the conversation and its reasoning stay where they are. A switch the provider refuses fails and the session stays on the account it had: an accepted switch whose login then fails shows as the provider's refusal of the next request, the daemon hands the previous account back (the previous store on Claude Code, the previous account's tokens on Codex), and the transcript gains one system message, `Switch to account <name> failed · login expired · Sign in again`.
- A switch lands at the provider's acknowledgment, and **the spend splits there**: a turn that spans a switch shows as two account rows under one total, the account each request ran on known from the acknowledgment's position in the session's own record — the property [Spec-025 §Concurrency Posture](../specs/025-provider-accounts-and-credential-homes.md#concurrency-posture) rests on.
- The session's spend keeps counting across the move: the work before it stays under the account it ran on, the work after it goes under the new one, and the session's total sums both. The switch splits at its acknowledgment and the carrier's own running figure carries on, and that figure is never something the person is shown. On the Codex leg the figure is per conversation even though the process is shared: the service reports usage per thread (`thread/tokenUsage/updated` names the thread it counts, measured 2026-09-21 at 0.155.1, [codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)), so a service holding several conversations attributes spend to each without a split of ours.
- **Nothing of the daemon's stops a carrier while the stop would end something**: no memory-pressure stop and no fixed bound of any kind. **An idle Claude Code session sleeps**: after 30 idle minutes, checked every 5 and again under the session lock at the stop, the daemon stops the process of a Claude Code session it started, but only while no turn, queued or untaken message, open approval or question, running background task, wake-up or session-only job, `/btw` aside or voice call would end with it. The running background tasks are the set Claude Code reports with `background_tasks_changed`; wake-ups (`ScheduleWakeup`) and session-only jobs (`CronCreate` until its last run or `CronDelete`) are kept from their tool results, because they are never in that set and die with the process even across a resume, and they hold the session awake until two minutes after they fire. The stop closes the process's input; Claude Code's own idle exit (`CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`) is never used. The next message, a `session_send` or a workflow step wakes it through Claude Code's own resume on the same conversation, account, folder, settings and permission level, with nothing on screen: ready in about 1.2 s and answering in about 2.4 s, measured on 2.1.283, with `SessionStart` hooks run again as `resume`. An archived session sleeps like any other. Codex is never slept, and a session the person runs in their own terminal is never stopped. Otherwise a carrier ends when the person ends the session or when the provider exits on its own, and a Codex service outlives any one conversation on it. Two things are not stops of ours: a service that dies is restarted by the daemon and every conversation in it resumed at once through the provider's own resume, the one on screen first, the restart written to the daemon's log and to no transcript, and a service that dies three times within five minutes is left down with each of its sessions offering `Restart`, so process starts stay at three per account per five minutes; and the provider's own unloading of an idle conversation nobody is subscribed to, which it reloads from that conversation's own file, is the provider stopping its own state.
- **Three conditions hold the Codex leg up**, and it rests on all three. A conversation's folder, its configuration and its tool servers are its own, passed at `thread/start` and never as a flag on the shared service, so two sessions on one service can differ in every one of them; a `-c` given when the service starts applies to every conversation in it, so the daemon puts there only what every conversation shares (its own hooks, the features it switches off, the unload delay), and one combined notification opt-out list serves every conversation, events routed by `threadId`. A terminal session that joins runs its commands in the folder the person typed `codex` in, which `thread/started` names as the conversation's `cwd`, its `environments[0].cwd` and its `runtimeWorkspaceRoots`, whatever folder the service runs in (measured at 0.156.0, [codex.md §A second seat on the shared service](../reference/provider-wire/codex.md#a-second-seat-on-the-shared-service)). A change to a conversation the service already holds goes through the provider's own verbs: its settings by `thread/settings/update`, its developer instructions appended, and its base instructions only by a reload fork of the conversation, passed again on every fork and resume. And on a daemon restart the service comes back on the same socket before the daemon starts anything else: a session attached to it reconnects by itself when the service returns within about five seconds, and has given up by about twenty-four, after which that session's row says so and offers the provider's own resume, `codex resume <thread id>`, its transcript kept ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). **The account is the sharing key, never who started the session**: the service lives in one account's credential home, so a session this product runs and a session the person typed in a terminal share the service of the account they are on, and a session on another account is on another service. The daemon's seat on a service subscribes to a terminal's conversation only for an exchange an agent sends, resuming it at the send and writing the message once the reload is done, and it never lets a conversation go while `thread/backgroundTerminals/list` shows a command of it running, because an unload kills the command. Every service starts with `thread_unload_delay_secs=5`, so a terminal session that has quit leaves `session_list` about 5 s after the service's `thread/closed`.
- The side question (the console's `/btw` word) is answered by a **second, short-lived, read-only process** that is not a second lead: on Claude Code a process started on a fork of the session in plan permission mode (`--resume <session> --fork-session --permission-mode plan`), with the session's full model id, because plan mode runs the `haiku` alias as Sonnet 5 otherwise, and `--no-session-persistence`, so no copy of the transcript is left behind; on Codex an ephemeral thread fork (`thread/fork {ephemeral: true, excludeTurns: true, permissions: ":read-only", approvalPolicy: "never"}`, the daemon checking that the reply's `activePermissionProfile` names `:read-only`). It takes one turn, keeps nothing, and its cost lands on the session's own account: on Codex the fork's own figure, on Claude Code the fork's total less the parent's.

### Thesis — Why This Option

- **The provider itself reads the credential per request, so the switch is the provider's own act.** Claude Code reads its credential from the store folder it is pointed at on each request, and a Codex service running on handed tokens takes a replacement between requests; a switch applied through either lands between two requests, never inside one, so no step is torn and the acknowledgment marks exactly where the spend changes account. The person's turn continues across the move with no interruption, and its spend lands as two account rows under one total, which is the shape the receipt is built for.
- **The carrier is the unit each provider gives us.** Claude Code fixes the working directory, the loaded commands and the tool servers at start, which is why its carrier is one process per session; Codex takes all of those per conversation at `thread/start`, which is what makes one service per account the provider's own shape rather than a trick of ours. A switch replaces neither carrier, so the conversation and its reasoning stay where they are and nothing of the conversation is re-sent.
- **One carrier per provider keeps the inventory readable, and the shared one is markedly cheaper.** One lead process per live Claude Code session, one service per Codex account however many conversations sit on it, plus a side-question process that lives for one turn, is a bound a person can read in a process list. A Codex session joined to a service holds about 17 MB of real memory against about 58 MB standing alone, the service itself about 40 MB with one client, measured at Codex `0.155.1` ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)).
- **The command list stays truthful.** The list a session shows is bound to the live carrier, so a new carrier brings a new list at a moment the person chose.

### Antithesis — The Strongest Case Against [T2]

A switch that lands mid-turn leaves one turn's requests on two accounts and one provider session file holding both; a boundary the daemon made at a tool call would keep every turn on one account. A pool of warm processes, one per account, would also make the side question free.

### Synthesis — Why It Still Holds [T2]

The split is exact: each request runs on one account, and the acknowledgment's place in the session's record says which, so the receipt's two rows are a faithful account rather than an estimate. Holding the turn for a boundary would cost the person a hold, an interrupt and a resume for a fact the provider already tracks per request. A warm pool multiplies resident processes by the number of saved accounts for a benefit the in-place switch already delivers; the Codex service is not that pool, because it is one process a running session is already using rather than one kept idle against a switch that may never come. The side question is rare and read-only, so a process that lives for one turn costs less than one that waits all day.

---

## Alternatives Considered

### Option A: One long-lived carrier per session — a process on Claude Code, a shared service per account on Codex — account switch in place from the next request (Chosen)

- **What:** As decided above. The daemon points each moving Claude Code session at the new account's store and hands the current account's Codex service the new account's tokens, on every supported version.
- **Steel man:** The switch lands at the next request with nothing held, copied or resumed, and every request belongs to exactly one account.
- **Weaknesses:** A turn that spans a switch spends on two accounts.

### Option B: Hold the switch until the run ends on its own (Rejected)

- **What:** Record the pick as a pending switch and apply it when the current run finishes.
- **Steel man:** The boundary arrives without the daemon doing anything, and a pending intent is simple to store.
- **Why rejected:** Across a long run it is indistinguishable from being ignored, and it makes the person interrupt their own work to get the thing they already asked for. The accounting it was protecting is protected just as well by the split at the provider's acknowledgment, where the switch lands.

### Option C: A warm process per saved account (Rejected)

- **What:** Keep one idle provider process per account per session.
- **Steel man:** Instant switches and a ready side-question process.
- **Why rejected:** Process count grows with accounts times sessions, each holding memory and a provider connection, for an act that is rare.

### Option F: One Codex process per conversation (Rejected)

- **What:** Every Codex conversation in a process of its own, exactly as the Claude Code leg.
- **Steel man:** One line in a process list per session, nothing shared between two sessions, and the two legs identical to read and to supervise.
- **Why rejected:** The provider is built for the other shape and says so — many conversations in one service, each conversation's folder, configuration and tool servers its own at `thread/start`, and an idle conversation unloaded and reloaded by the provider itself — while a process each costs what a service does not: a joined Codex session holds about 17 MB of real memory against about 58 MB standing alone, the service about 40 MB with one client, at Codex `0.155.1` ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). The three conditions in §Decision are what sharing costs; the Claude Code leg keeps one process per session because that provider offers nothing else.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | A running Claude Code process takes a new credential store folder through `apply_flag_settings {env}` from its next request, and a Codex service running on handed tokens takes new ones through `account/login/start {type: "chatgptAuthTokens"}` | Measured on Codex: a replacement handed in while a 6-second command ran was accepted in 0.025 s, the command ran once, and the next model request went through on it; on Claude Code the next request after the acknowledgment runs on the new account ([Spec-025 §Moving a session to another account](../specs/025-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)) | The provider refuses the switch: it fails with `Switch to account <name> failed · login expired · Sign in again`, and the session stays on the account it had |
| 2 | Both providers offer a read-only, throwaway fork for the side question | Claude Code resumes a session as a fork in plan permission mode; Codex forks a thread as ephemeral | The side question would need a different carrier on that provider, or degrade honestly |
| 3 | A Codex conversation the service already holds takes a change to its settings through `thread/settings/update` and to its developer instructions by appending, and its base instructions only through a reload fork passed on every later fork and resume | The provider's own verbs for a loaded conversation; a trust write through `config/value/write` does not reach a loaded conversation, which is why the daemon's hook trust is written before any conversation starts, forks or resumes | A change that does not reach the loaded conversation waits for the reload fork, which the person does not see and the row does not claim |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The new account's login fails on the first request after the switch | Med | Med | The provider refuses that request | The daemon hands the previous account back (the previous store on Claude Code, the previous account's tokens on Codex), the session stays on the account it had, and the transcript gains one system message, `Switch to account <name> failed · login expired · Sign in again` |
| A side-question process outlives its turn | Low | Med | The process inventory shows more than one process for the session | The daemon owns its lifetime and ends it when the turn ends or the session closes |
| The shared Codex service dies | Med | Med | The daemon's websocket seat on its control socket drops | The daemon brings it back on the same socket and resumes every conversation in it through the provider's own resume, one faint row per session; a session whose own attachment gave up past the provider's reconnect window reads `stopped responding` and offers `codex resume <thread id>` |
| The shared Codex service dies three times within five minutes | Low | Med | The daemon counts the service's starts per account | The service is left down and each of its sessions shows `Restart`, the person's own act |
| An idle Claude Code session is stopped while something of it still runs | Low | High | The stop is checked again under the session lock against the running set, the kept wake-ups and session-only jobs, open approvals and questions, `/btw` and voice | Nothing is stopped while any of them would end; the wake-up and job records keep the session awake until two minutes after they fire |

## Reversibility Assessment

- **Reversal cost:** Weeks. Supervision, cost attribution and the command-list subscription all assume one process per Claude Code session and one service per Codex account.
- **Blast radius:** [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md), [Spec-014](../specs/014-multi-agent-orchestration.md), [Spec-025](../specs/025-provider-accounts-and-credential-homes.md), and the provider settings page the switch lives on.
- **Migration path:** None before release.
- **Point of no return:** When cost history attributed per account and per turn exists on people's machines.

## Consequences

### Positive

- Every turn has one account, one carrier and one cost row.
- The inventory is one process per live Claude Code session, one service per Codex account, plus one process for the length of a side question — so a person running several Codex sessions on one account pays for one service rather than for each of them.

### Negative (accepted trade-offs)

- A turn that spans an account switch spends on two accounts. Accepted because each request is known to one account and the receipt shows both rows under one total.
- An idle Claude Code session's first message after a sleep waits about 1.2 s for the resume. Accepted because the sleep frees the process only when nothing would end with it.

### Unknowns

- Whether a switch onto a real second account carries the earlier reasoning across on each provider: Claude Code's signed thinking and Codex's encrypted reasoning. Measured before build acceptance, on a real second account on each provider.

---

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Lead carriers | One process per live, awake Claude Code session; one service per Codex account, whatever the number of conversations on it | The daemon's process inventory under a test that switches accounts mid-turn and asks a side question | When the account switch lands |
| An account switch mid-turn | The next request runs on the new account with no second process, no resume and no `continue`; the turn's spend shows as two account rows | A test that switches during a running tool call on each provider | When the account switch lands |
| An idle Claude Code session | Stopped after 30 idle minutes only when nothing would end; the next message answers after the wake | A test holding each guard (a background task, a wake-up, a session-only job, an open question) past 30 minutes, then one with none | When the sleep lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Live probe of the shared Codex `app-server` at `0.155.1` | Primary research | One service holds many conversations, each taking its own folder, configuration and tool servers at `thread/start`; the service reports usage per thread, so spend attributes without a split of ours; a joined conversation holds about 17 MB of real memory against about 58 MB standing alone, the service about 40 MB with one client; a dropped attachment reconnects by itself within about five seconds and has given up by about twenty-four | Measured for the console design; the figures are inlined here and in the Codex wire reference |
| Feature census of two reference desktop apps, a Go one and a Rust one | Primary research | Both run one provider process per session with nothing shared per account, and both stop an idle one on a half-hour timer; the guards that grew around those timers — a turn in flight, a pending approval, queued work, and a wake-up timer living inside the provider process with no lifecycle of its own — are the conditions the daemon's own idle stop checks before it stops anything | Read for the console design; the reading is summarized here |
| Idle stop and wake of a Claude Code session at 2.1.283 | Primary research | Closing a process's input ends it; `--resume` on the same conversation is ready in about 1.2 s and answers in about 2.4 s, with `SessionStart` hooks run as `resume`; wake-ups and session-only jobs die with the process, even across a resume | Measured for the console design; the reading is inlined in §Decision |

### Related ADRs

- [ADR-026: Provider Credential Custody Posture](026-provider-credential-custody-posture.md) — what a credential home is and who may read it.
- [ADR-027: Canonical Transcript Is Authoritative](027-canonical-transcript-is-authoritative.md) — the transcript that stands in where a provider's own resume cannot reopen the conversation.
