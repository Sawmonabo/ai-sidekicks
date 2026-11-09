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

A session's lead agent is a provider's command-line program, Claude Code or Codex, run by the daemon as a child process. A provider account is a credential home on disk ([Spec-025](../specs/025-provider-accounts-and-credential-homes.md)); a Claude Code process reads its credential from the store folder or the pasted token it was started on, and a Codex service reads the sign-in of the home it runs in or the tokens the daemon hands it. A person can save several accounts for one provider. A session's spend is shown per account, the provider keeps its own session file under the home the process was started in, and the transcript is rebuilt from the session's event log ([ADR-027](027-canonical-transcript-is-authoritative.md)).

## Problem Statement

How many provider processes does a session have, which account does each run on, and when can the account change?

### Trigger

The console design lets a person make another saved account the current one for a provider while sessions are running on it, and lets them ask a side question without disturbing the conversation. Both raise the question of a second process, and the answer shapes the daemon's supervision, the cost rows and the command list.

---

## Decision

A session's lead runs on **one account, and the carrier depends on the provider**: a Claude Code session has **one long-lived process of its own**, and a Codex session is a conversation on **one shared service per account** — `codex app-server --listen unix://<the account home's control socket>`, holding every Codex conversation the daemon runs on that account, spoken to over the websocket that socket answers ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). Claude Code stays one process per session because that provider offers nothing else.

- A session starts on the account marked as its provider's default at the moment the session is created.
- It moves to another saved account of the same provider when the person makes that account the provider's current one on the provider settings page, unless an agent definition or a workflow step pins it to an account. **The move lands between turns**, with no interrupt, copy or `continue`: the turn running when it is asked finishes and bills on the account it started on, a running tool finishing and never repeated, and the session's next turn runs on the new account ([Spec-025 §Moving a session to another account](../specs/025-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)). On Claude Code the session's process starts again between turns on the new account, its store folder or its pasted token on the process's file descriptor, and resumes its conversation by its id: an idle session at once, a busy one once its turn settles. No store is changed under a running process, because Claude Code reads a store changed under a running process only once its 30-second store-read cache lapses, and no token is ever handed to a running process ([ADR-026](./026-provider-credential-custody-posture.md)). On Codex every session that follows the current account runs in the one switching service the daemon keeps for the current account, which runs on tokens the daemon hands it with `account/login/start {type: "chatgptAuthTokens"}`, held only in the daemon's memory. That service runs in a Codex home of its own under the daemon's data folder, apart from every account home, on that home's own control socket and started with `-c cli_auth_credentials_store="ephemeral"`, so it writes no `auth.json`; the conversations, goals, state, hook trust and memories of every session that follows the current account live in that home whichever account paid for them, the daemon keeps it in a lasting record as it keeps an account's service, so a daemon restart finds the same process again, and a backup and the diagnostic expiry treat it as they treat an account home; the switch is one such call with the new account's tokens, made once no session attached to the service runs, starts or is still ending a turn, because Codex revokes every model request in flight when its sign-in changes. No turn starts on the service while the switch waits, a newer switch takes the waiting one's place and one login answers both, an idle service switches at once, and every conversation's next turn runs on the new account. The login itself is quick (measured: a replacement handed in while a 6-second command ran was accepted in 0.025 s), so holding it to the turn's end costs only the wait for the turn. A session pinned to an account runs in that account's own service on its own sign-in and never moves.
- **The move is the same on every version.** Every installed version switches a session's account the same way: no feature checks a version number, and there is no second way to move a session's account. A running tool finishes and is never repeated, nothing is interrupted, and the conversation and its reasoning stay where they are. A switch the provider refuses fails and the session stays on the account it had: an accepted switch whose login then fails shows as the provider's refusal of the next request, the daemon hands the previous account back (a start again between turns on the previous account on Claude Code, the previous account's tokens on Codex), and the transcript gains one system message, `Switch to account <name> failed · login expired · Sign in again`.
- A switch lands between turns, so **no turn spans it**: every turn runs and bills on one account, and a session that moved shows as two account rows under one total with nothing to apportion — the property [Spec-025 §Concurrency Posture](../specs/025-provider-accounts-and-credential-homes.md#concurrency-posture) rests on.
- The session's spend keeps counting across the move: the work before it stays under the account it ran on, the work after it goes under the new one, and the session's total sums both. The switch splits at the turn boundary, and the carrier's own running figure is never something the person is shown. On the Codex leg the figure is per conversation even though the process is shared: the service reports usage per thread (`thread/tokenUsage/updated` names the thread it counts, measured at 0.155.1, [codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)), so a service holding several conversations attributes spend to each without a split of ours.
- **Nothing of the daemon's stops a carrier while the stop would end something, save a Codex service that stopped answering**: no memory-pressure stop and no fixed bound of any kind. **An idle Claude Code session sleeps**: after 30 idle minutes, checked every 5 and again under the session lock at the stop, the daemon stops the process of a Claude Code session it started, but only while no turn, queued or untaken message, open approval or question, running background task, wake-up or session-only job, `/btw` aside or voice call would end with it. The running background tasks are the set Claude Code reports with `background_tasks_changed`; wake-ups (`ScheduleWakeup`) and session-only jobs (`CronCreate` until its last run or `CronDelete`) are kept from their tool results, because they are never in that set and fire only while a process runs: a resume brings a session-only job back but skips the runs that fell due while no process ran and drops a one-shot job whose time passed, and it does not bring a wake-up back, and they hold the session awake until two minutes after they fire. The stop closes the process's input; Claude Code's own idle exit (`CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`) is never used. The next message, a `session_send` or a workflow step wakes it through Claude Code's own resume on the same conversation, account, folder, settings and permission level, with nothing on screen: ready in about 1.2 s and answering in about 2.4 s, measured on 2.1.283, with `SessionStart` hooks run again as `resume`. An archived session sleeps like any other. Codex is never slept, and a session the person runs in their own terminal is never stopped. Otherwise a carrier ends when the person ends the session or when the provider exits on its own, and a Codex service outlives any one conversation on it. Two things are not stops of ours: a service that dies is restarted by the daemon, at once and then on waits that double from 1 second, and every conversation in it resumed through the provider's own resume, the one on screen first, with no row for the restart: only the daemon's log names it, while it restarts the working line reads `Reconnecting…`, and the crash lands `Turn ended · Codex ended unexpectedly · exit code 137` (the process's own exit code) only on the sessions whose running turn it ended, nothing on its idle sessions; a service whose fifth crash falls within three minutes is left down with each of its sessions offering `Restart`, so process starts stay at five per account in any three minutes, and a service the daemon started that stays alive but answers nothing for 2 minutes — no redial answering since its connection dropped, or no reply to a request on its open connection, any message from it clearing the count — is ended by the daemon and restarted as after a crash, its cut turns landing `Turn ended · Codex stopped answering · no reply for 2 minutes`, its fifth such end within thirty minutes leaving it down the same way, while a service the daemon only joined is never ended; and the provider's own unloading of an idle conversation nobody is subscribed to, which it reloads from that conversation's own file, is the provider stopping its own state.
- **Three conditions hold the Codex leg up**, and it rests on all three. A conversation's folder, its configuration and its tool servers are its own, passed at `thread/start` and never as a flag on the shared service, so two sessions on one service can differ in every one of them; a `-c` given when the service starts applies to every conversation in it, so the daemon puts there only what every conversation shares (its own hooks, the features it switches off, the unload delay), and one combined notification opt-out list serves every conversation, events routed by `threadId`. A terminal session that joins runs its commands in the folder the person typed `codex` in, which `thread/started` names as the conversation's `cwd`, its `environments[0].cwd` and its `runtimeWorkspaceRoots`, whatever folder the service runs in (measured at 0.156.0, [codex.md §A second seat on the shared service](../reference/provider-wire/codex.md#a-second-seat-on-the-shared-service)). A change to a conversation the service already holds goes through the provider's own verbs: its settings by `thread/settings/update`, its developer instructions appended, and its base instructions only by a reload fork of the conversation, passed again on every fork and resume. And the service on the person's own Codex folder runs apart from the daemon, so a daemon restart leaves it running and the daemon finds it again by connecting: a terminal session that loses its service reconnects by itself for up to 120 seconds, after which `session_list` reads it as not reachable and a send to it reads `not delivered`, the second line being `Reopen it in a terminal: codex resume <thread id>`, with no `Retry`, its transcript kept ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)). **The account is the sharing key, never who started the session**: an account's service lives in that account's credential home, so a session pinned to that account and a session the person typed in a terminal there share it, and a session on another account is on another service. A terminal `codex` started in an account home joins that account's own service, never the switching one, whose socket sits in its own home. The daemon's seat on a service subscribes to a terminal's conversation only for an exchange an agent sends, resuming it at the send and writing the message once the reload is done, and it never lets a conversation go while `thread/backgroundTerminals/list` shows a command of it running, because an unload kills the command. Every service starts with `thread_unload_delay_secs=5`, so a terminal session that has quit leaves `session_list` about 5 s after the service's `thread/closed`.
- The side question (the console's `/btw` word) is answered by a **second, short-lived, read-only process** that is not a second lead: on Claude Code a process started on a fork of the session in plan permission mode (`--resume <session> --fork-session --permission-mode plan`), with the session's full model id, because plan mode runs the `haiku` alias as Sonnet 5 otherwise, and `--no-session-persistence`, so no copy of the transcript is left behind; on Codex an ephemeral thread fork (`thread/fork {ephemeral: true, excludeTurns: true, permissions: ":read-only", approvalPolicy: "never"}`, the daemon checking that the reply's `activePermissionProfile` names `:read-only`). It takes one turn, keeps nothing, and its cost lands on the session's own account: on Codex the fork's own figure, on Claude Code the fork's own spend, which Claude Code counts from the fork's start.

### Thesis — Why This Option

- **The turn boundary is the one place both providers change account cleanly.** Claude Code takes a store changed under a running process only once its 30-second store-read cache lapses, and Codex revokes every model request in flight when its sign-in changes; between turns neither reaches a request, so no step is torn, every turn belongs to one account, and the receipt's account rows need no apportioning. The person's turn finishes undisturbed, and the next one runs on the account they picked.
- **The carrier is the unit each provider gives us.** Claude Code fixes the working directory, the loaded commands and the tool servers at start, which is why its carrier is one process per session; Codex takes all of those per conversation at `thread/start`, which is what makes one service per account the provider's own shape rather than a trick of ours. A switch keeps each carrier's shape: on Claude Code the session's process starts again on the conversation it had, resumed by its id, and on Codex the session stays in the service it runs in, so the conversation and its reasoning stay where they are and nothing of the conversation is re-sent.
- **One carrier per provider keeps the inventory readable, and the shared one is markedly cheaper.** One lead process per live Claude Code session, one service per Codex account however many conversations sit on it, plus a side-question process that lives for one turn, is a bound a person can read in a process list. A Codex session joined to a service holds about 17 MB of real memory against about 58 MB standing alone, the service itself about 40 MB with one client, measured at Codex `0.155.1` ([codex.md §The shared `app-server` a terminal `codex` joins](../reference/provider-wire/codex.md#the-shared-app-server-a-terminal-codex-joins)).
- **The command list stays truthful.** The list a session shows is bound to the live carrier, so a new carrier brings a new list at a moment the person chose.

### Antithesis — The Strongest Case Against [T2]

A switch held to the turn boundary makes a person who switches during a long turn wait for it to finish, and on Claude Code it starts again a process that a switch inside the running one would have kept. A pool of warm processes, one per account, would also make the side question free.

### Synthesis — Why It Still Holds [T2]

A switch inside the turn cannot say which account a request ran on: Claude Code's store-read cache leaves up to 30 seconds of requests on an account nobody can name, and Codex fails a turn caught streaming. The wait is the person's own turn finishing, with nothing interrupted, and the start again is Claude Code's own resume by id, ready in about 1.2 s (the wake measured in §Decision). A warm pool multiplies resident processes by the number of saved accounts for a benefit the between-turns switch already delivers; the Codex service is not that pool, because it is one process a running session is already using rather than one kept idle against a switch that may never come. The side question is rare and read-only, so a process that lives for one turn costs less than one that waits all day.

---

## Alternatives Considered

### Option A: One long-lived carrier per session — a process on Claude Code, a shared service per account on Codex — account switch between turns (Chosen)

- **What:** As decided above. The daemon starts each moving Claude Code session's process again between turns on the new account and resumes it by its id, and hands the current account's Codex service the new account's tokens once no turn runs there, on every supported version.
- **Steel man:** Every turn runs and bills on exactly one account, and nothing is interrupted, copied or sent `continue`.
- **Weaknesses:** A switch asked during a long turn waits for that turn to finish, and on Claude Code each switch starts the session's process again.

### Option B: Switch inside the running turn, from the next request (Rejected)

- **What:** Point a running Claude Code process at the new account's store with `apply_flag_settings {env: {CLAUDE_SECURESTORAGE_CONFIG_DIR}}` and hand a busy Codex service the new account's tokens at once, so the turn's next model request runs on the new account.
- **Steel man:** A busy session takes the switch at its next model call, with no wait for the turn and no start again.
- **Why rejected:** Neither provider takes it cleanly. Claude Code reads the named store only once its 30-second store-read cache lapses (measured at 2.1.319: a turn sent 2 s after Claude Code took the change ran on the previous account, one sent 36 s after on the new one), so the account of the requests in between is unknown and the receipt could not say who paid; Codex revokes every model request in flight when its sign-in changes and fails a turn caught streaming ([codex.md §Adjacent currency facts](../reference/provider-wire/codex.md#adjacent-currency-facts-verified-from-the-same-generation)).

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
| 1 | A Claude Code process started again between turns on the new account's store folder or token resumes its conversation by its id, and a Codex service running on handed tokens takes new ones through `account/login/start {type: "chatgptAuthTokens"}` once no turn runs there | Claude Code's own resume by id reopens the conversation in the home that holds it, as the idle session's wake does; on Codex a replacement handed in while a 6-second command ran was accepted in 0.025 s ([Spec-025 §Moving a session to another account](../specs/025-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)) | The provider refuses the switch: it fails with `Switch to account <name> failed · login expired · Sign in again`, and the session stays on the account it had |
| 2 | Claude Code and Codex both offer a read-only, throwaway fork for the side question | Claude Code resumes a session as a fork in plan permission mode; Codex forks a thread as ephemeral | The side question would need a different carrier on that provider, or degrade honestly |
| 3 | A Codex conversation the service already holds takes a change to its settings through `thread/settings/update` and to its developer instructions by appending, and its base instructions only through a reload fork passed on every later fork and resume | The provider's own verbs for a loaded conversation; a trust write through `config/value/write` does not reach a loaded conversation, which is why the daemon's hook trust is written before any conversation starts, forks or resumes | A change that does not reach the loaded conversation waits for the reload fork, which the person does not see and the row does not claim |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The new account's login fails on the first request after the switch | Med | Med | The provider refuses that request | The daemon hands the previous account back (a start again between turns on the previous account on Claude Code, the previous account's tokens on Codex), the session stays on the account it had, and the transcript gains one system message, `Switch to account <name> failed · login expired · Sign in again` |
| A side-question process outlives its turn | Low | Med | The process inventory shows more than one process for the session | The daemon owns its lifetime and ends it when the turn ends or the session closes |
| The shared Codex service dies | Med | Med | The daemon's websocket seat on its control socket drops | The daemon brings it back on the same socket and resumes every conversation in it through the provider's own resume, the one on screen first; the restart itself draws no row on any session, the crash drawing nothing on an idle session and `Turn ended · Codex ended unexpectedly · exit code 137` (the process's own exit code) on each session whose running turn it ended; the restart is one structured line in the daemon's log naming the account and each conversation resumed, and one count on the daemon's restart counter for that account. A terminal session whose own attachment gave up past the provider's reconnect window reads as not reachable in `session_list`, and a send to it reads `not delivered` with `Reopen it in a terminal: codex resume <thread id>` |
| The shared Codex service stays alive but answers nothing | Low | Med | No redial answers for 2 minutes after its connection dropped, or no reply comes for 2 minutes to a request on its open connection | The daemon ends the service it started and restarts it as after a crash, and its fifth such end within thirty minutes leaves it down with each of its sessions showing `Restart`; a service the daemon only joined is never ended, only redialed |
| The shared Codex service crashes five times within three minutes | Low | Med | The daemon counts the service's crashes per account in a sliding three-minute window | The service is left down and each of its sessions shows `Restart`, the person's own act |
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

- A switch asked during a long turn waits for the turn to finish, and on Claude Code it starts the session's process again. Accepted because every turn then runs and bills on one account, and the start again is Claude Code's own resume by id.
- An idle Claude Code session's first message after a sleep waits about 1.2 s for the resume. Accepted because the sleep frees the process only when nothing would end with it.

### Unknowns

- Whether a switch onto a real second account carries the earlier reasoning across on each provider: Claude Code's signed thinking and Codex's encrypted reasoning. Measured before build acceptance, on a real second account on each provider.

---

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Lead carriers | One process per live, awake Claude Code session; one service per Codex account, whatever the number of conversations on it | The daemon's process inventory under a test that switches accounts mid-turn and asks a side question | When the account switch lands |
| An account switch during a turn | The turn finishes on the account it started on and the next turn runs on the new account with no interrupt and no `continue`, on Claude Code through one start again resumed by id; the session's spend shows as two account rows under one total | A test that switches during a running tool call on each provider | When the account switch lands |
| An idle Claude Code session | Stopped after 30 idle minutes only when nothing would end; the next message answers after the wake | A test holding each guard (a background task, a wake-up, a session-only job, an open question) past 30 minutes, then one with none | When the sleep lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Live probe of the shared Codex `app-server` at `0.155.1` | Primary research | One service holds many conversations, each taking its own folder, configuration and tool servers at `thread/start`; the service reports usage per thread, so spend attributes without a split of ours; a joined conversation holds about 17 MB of real memory against about 58 MB standing alone, the service about 40 MB with one client; a dropped attachment reconnects by itself for up to 120 seconds (measured at `0.161.0`) | Measured for the console design; the figures are inlined here and in the Codex wire reference |
| Feature census of two reference desktop apps, a Go one and a Rust one | Primary research | Both run one provider process per session with nothing shared per account, and both stop an idle one on a half-hour timer; the guards that grew around those timers — a turn in flight, a pending approval, queued work, and a wake-up timer living inside the provider process with no lifecycle of its own — are the conditions the daemon's own idle stop checks before it stops anything | Read for the console design; the reading is summarized here |
| Idle stop and wake of a Claude Code session at 2.1.283 | Primary research | Closing a process's input ends it; `--resume` on the same conversation is ready in about 1.2 s and answers in about 2.4 s, with `SessionStart` hooks run as `resume`; at 2.1.292 a resume brings a session-only job back, which fires only while a process runs and skips the runs it missed, and does not bring a wake-up back | Measured for the console design; the reading is inlined in §Decision |

### Related ADRs

- [ADR-026: Provider Credential Custody Posture](026-provider-credential-custody-posture.md) — what a credential home is and who may read it.
- [ADR-027: Canonical Transcript Is Authoritative](027-canonical-transcript-is-authoritative.md) — the transcript that stands in where a provider's own resume cannot reopen the conversation.
