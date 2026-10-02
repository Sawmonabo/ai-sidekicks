# ADR-037: Kept Sessions Keep Their Provider Files

| Field         | Value                            |
| ------------- | -------------------------------- |
| **Status**    | `accepted`                       |
| **Type**      | `Type 1 (two-way door)`          |
| **Domain**    | Data Retention, Provider Drivers |
| **Date**      | 2026-09-29                       |
| **Author(s)** | Claude (AI-assisted)             |
| **Reviewers** | Sawmon Abo                       |

---

## Context

**How long the product keeps a session.** A finished session stays until the person deletes it. Settings › Runtime carries `Keep sessions for`, 90 days by default, and past it a session is only eligible for deletion: the control's own line says nothing goes until `Delete old data` is pressed, and `Delete old data` is the one act that removes sessions ([Spec-020 §Retention Policy](../specs/020-data-retention-and-gdpr.md#retention-policy)). The service drops one thing on its own: the diagnostic logs past `Keep diagnostic logs for`, a bound the person sets that does not turn deletion on or off. A workflow run's step data and its snapshots stay until the person deletes the run or its session. Background compaction may compress, repack and move the service's own storage, and never removes anything a person could see.

**Why the provider's files matter.** Resuming a session reads the provider's own record of it. Claude Code resumes from its conversation file in the account home the session ran in; Codex resumes a thread it keeps. If the provider deletes that file while the product still shows the session, the session can be read but not continued, which breaks the promise above without anyone pressing anything.

**What Claude Code deletes on its own.** Claude Code sweeps its home past `cleanupPeriodDays`, 30 days by default ([settings reference, `cleanupPeriodDays`](https://code.claude.com/docs/en/settings-reference#cleanupperioddays); [the `.claude` directory, "Cleaned up automatically"](https://code.claude.com/docs/en/claude-directory)). Measured on this machine on Claude Code 2.1.281, in throwaway homes with planted files:

| Finding | Result |
| --- | --- |
| When the sweep runs | 5 s after a process starts, at most once a day per home (a `.last-cleanup` marker), again after about 10 minutes in a long-lived process; never under `--bare`. Sign-in does not matter. |
| How age is judged | By the file's modification time, never by the times written inside it. A 40-day-old file whose entries were dated today was deleted; a file touched today whose entries were 60 days old was kept. |
| What goes | The conversation file with its subagent and tool-result files, file history, session environment, task lists, plans, debug logs, paste cache, shell snapshots, backups, todos, usage data, and the binary's own longer list (MCP logs, telemetry, traces, jobs). Tool-result files are judged by their own age even while their conversation file is kept. |
| Resume and age | `--resume` refreshes the conversation file's age, even with no turn, and leaves its tool-result and file-history files as old as they were. |
| Where the value comes from | Managed, then `--settings`, then local, then project, then user ([settings precedence](https://code.claude.com/docs/en/settings)). The highest source sets the value for the whole home. |
| A repository's own file | With 3650 in the home's `settings.json` and 1 in a working folder's `.claude/settings.json`, every older conversation file in the home was deleted, in other projects too. With 3650 also passed through `--settings`, every file was kept. |
| Zero | A validation error ("Setting `0` fails validation, so pick a large value such as `3650`"); with it the sweep pauses only as a side effect of the invalid settings file. |
| The ceiling | The schema is a positive whole number with no maximum. With a file dated Jan 2, 1970, a value of 20,000 deleted it and 21,000 kept it. |

**What Codex deletes on its own.** Nothing, in 0.156.0: a conversation stays until `thread/delete`, which removes its conversation file and the threads it spawned.

## Problem Statement

A kept session must stay resumable for as long as the product keeps it. How does the daemon stop each provider from deleting a kept session's files, and what removes those files when the person does delete the session?

### Trigger

The rule that nothing deletes a session automatically, set against a probe showing that Claude Code's default sweep, and a single repository's settings file, would delete the conversation files of sessions the product still keeps.

---

## Decision

**A kept session and its personal data stay until the person deletes it, and nothing deletes one by age. The provider's conversation file lasts as long as the session: the daemon holds Claude Code's age sweep off in every account home it manages, and `Delete old data` removes the session's provider files when the session goes.**

1. **Every Claude Code process the daemon starts carries `"cleanupPeriodDays": 36500` in its `--settings` JSON**, in the same JSON as the daemon's other flag settings. The flag outranks a repository's project and local files, so no repository can shorten retention for the home. 36,500 days reaches back before 1970, so no file's age can pass it.
2. **Each account home's `settings.json` holds the same value**, for a process started in that home without the flag, such as a sign-in.
3. **A managed value below it raises `settings_ignored`.** A managed policy outranks the flag. After each spawn the daemon reads `effective.cleanupPeriodDays` from `get_settings`, and when it is lower the session shows the `session.notice` kind `settings_ignored`.
4. **`Delete old data` removes each purged session's provider files from every account home it ran in.** On Claude Code that is the conversation file with its subagent and tool-result files, its file history, session environment, todo and task lists, plan file and debug log; on Codex it is `thread/delete`. A session typed in a terminal keeps its conversation in the person's own Codex folder, which the purge never touches.
5. **The provider's other files go past `Keep diagnostic logs for`.** With the sweep held off, what the provider writes into an account home and never reads back for a session — its logs, telemetry, traces, shell snapshots and paste cache — is diagnostic data and follows the service's own diagnostic bound. The list is the pinned build's own cleanup list minus what belongs to a session, and it is read again on every pin move.

The daemon never writes these values into the person's own `~/.claude` or `~/.codex`: a home the person uses in a terminal keeps the person's own settings.

### Thesis — Why This Option

The flag is the provider's own setting, used as the provider documents it, so there is no second copy of any conversation and no process of the daemon's that rewrites file ages. It is also the only placement that holds against a repository's settings file, which the probe showed can empty a home. Deleting a session's provider files inside the one purge keeps one act for deletion and one confirm that says what goes.

### Antithesis — The Strongest Case Against

The value is home-wide. It keeps plans, pastes, debug logs, file history and tool results as long as conversations, and it cannot keep one session longer than another. The product becomes responsible for deleting what Claude Code would have deleted, and if the purge or the diagnostic sweep misses a file, it stays forever. A managed policy the person cannot change can still delete conversations the product shows as resumable.

### Synthesis — Why It Still Holds

The product already promises the person that nothing goes until they say so, and a provider sweep that deletes on its own schedule is exactly what that promise rules out. What the provider would have swept is not left: the files that belong to a session go with the session in the purge, and everything else in the home goes past the diagnostic bound, driven by the pinned build's own cleanup list so a new kind of file is not missed. The managed-policy case cannot be prevented, so it is said out loud in the session rather than hidden.

---

## Alternatives Considered

### Option A: 36500 through `--settings` and in each home's `settings.json`, a managed-value read-back, and provider files deleted at purge (Chosen)

- **What:** the decision above.
- **Steel man:** holds against every settings source except a managed one, which it reports; uses the provider's own mechanism.
- **Weaknesses:** home-wide; the daemon owns the deletion Claude Code would have done.

### Option B: `cleanupPeriodDays: 0` (Rejected)

- **What:** set zero, which pauses the sweep.
- **Steel man:** one value, and the sweep does nothing.
- **Why rejected:** zero is a validation error; the sweep pauses only because the settings file is invalid, and Claude Code's own docs say to pick a large value instead. A behavior that rests on an invalid file is not one to build on.

### Option C: Start Claude Code without the user settings source (Rejected)

- **What:** `--setting-sources` without `user`, which skips the sweep when no enabled source sets a value.
- **Steel man:** no value to maintain.
- **Why rejected:** it skips the sweep only while no other source sets the value, so a repository file with a small value turns it back on; and it withholds the settings the daemon passes in every home for its own reasons.

### Option D: The value in each home's `settings.json` only (Rejected)

- **What:** write 36500 into the home and pass nothing on the command line.
- **Steel man:** one place, covering every process in the home.
- **Why rejected:** a repository's project or local settings file outranks the home's file, and a value of 1 there deleted every older conversation in the home, across projects.

### Option E: Delete kept sessions by age, matching the provider (Rejected)

- **What:** remove a finished session automatically past `Keep sessions for`, so the provider's sweep and the product agree.
- **Steel man:** no files kept past a bound; no provider setting to hold.
- **Why rejected:** the product's rule is that nothing deletes a session automatically: past the bound a session is eligible for deletion and nothing more, and `Delete old data` is the only act that removes one.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `cleanupPeriodDays` accepts 36500 | The schema is a positive whole number with no maximum; 21,000 was accepted and kept a 1970 file | A build that adds a maximum rejects the flag's settings; the pin-bump probe catches it |
| 2 | `--settings` outranks project and local files | Measured: with the flag, a repository value of 1 deleted nothing | A repository could empty a home; the probe re-runs on every pin |
| 3 | A managed value outranks the flag | Claude Code's settings precedence and its binary | Assumed true, which is why the read-back exists |
| 4 | Codex deletes nothing by age | 0.156.0 has no age sweep; `thread/delete` is its only delete | A Codex build that adds one needs the same treatment; checked on each Codex pin |
| 5 | Age is file modification time | Measured on planted files | If content times were used, the value's reach would change; still covered by the ceiling |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A managed policy sets a lower value | Low for one person | High: conversations deleted while shown as resumable | `get_settings` read after each spawn | The `settings_ignored` notice in the session |
| A process starts in an account home without the flag | Medium (sign-in) | High without the home file | Review of every spawn path | The same value in the home's `settings.json` |
| A new Claude Code build adds a kind of per-session file | Medium | Files outlive their purged session | The pinned build's cleanup list, read on every pin move | Session files join the purge list; the rest follow the diagnostic bound |
| The purge misses a home a session ran in | Low | A conversation file outlives its session | The integration run across an account switch (Success Criteria) | The purge walks every account home the session ran in |

## Reversibility Assessment

- **Reversal cost:** Hours. Remove the flag value and the home files' key, and drop the provider-file step from the purge.
- **Blast radius:** Claude Code would sweep again at its own default, and kept sessions older than it would stop being resumable.
- **Migration path:** None needed; the value is written at each spawn and read by nothing else.
- **Point of no return:** None; a file the sweep deletes after a reversal cannot be brought back, which is the reason for this record.

## Consequences

### Positive

- A kept session can always be resumed, however long it has been kept.
- No repository's settings file can delete conversations in a home the app manages.
- Deletion stays one act, `Delete old data`, which removes the product's rows and the provider's files together.

### Negative (accepted trade-offs)

- The value is home-wide and keeps every kind of file the sweep would have removed; accepted because the purge and the diagnostic bound delete what the sweep would have.
- The purge must reach every account home a session ran in; accepted because the purge already runs per session.

### Unknowns

- The sweep was measured on macOS only; the same probe runs on Linux and Windows before the provider unit ships there.
- Whether Claude Code adds a maximum for the value in a later build.

---

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| A conversation file older than Claude Code's default cleanup period survives a new process's start in a managed account home | Kept | Planted-file probe with the daemon's spawn settings | Each Claude Code pin bump |
| The same, under a repository whose `.claude/settings.json` sets `cleanupPeriodDays` to 1 | Kept | Same probe with the repository file | Each Claude Code pin bump |
| A managed value below 36500 | `settings_ignored` shown | Probe with a managed settings file | When the provider unit lands |
| After `Delete old data`, the purged session's provider files in every account home it ran in | None left; a terminal session's Codex conversation untouched | Integration run across an account switch | When the purge lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Claude Code settings reference | Vendor docs | `cleanupPeriodDays`, 30 days by default; zero fails validation, use a large value | https://code.claude.com/docs/en/settings-reference#cleanupperioddays |
| The `.claude` directory | Vendor docs | What Claude Code cleans up automatically | https://code.claude.com/docs/en/claude-directory |
| Claude Code settings | Vendor docs | Settings precedence: managed, command line, local, project, user | https://code.claude.com/docs/en/settings |
| Probe of the sweep, Claude Code 2.1.281 | Measurement | The findings table under Context | This machine, throwaway homes |
| Codex 0.156.0 app-server schema | Vendor protocol | `thread/delete` is the only delete; nothing by age | The pinned Codex build |

### Related ADRs

- [ADR-031: One Claude Code Process Per Session, One Codex Service Per Account](031-one-claude-process-per-session-one-codex-service-per-account.md) — the processes that carry the flag.
- [ADR-026: Provider Credential Custody Posture](026-provider-credential-custody-posture.md) — the account homes the daemon manages.
