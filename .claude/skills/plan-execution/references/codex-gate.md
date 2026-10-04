# codex-gate

`node .claude/skills/plan-execution/scripts/codex-gate.mjs <pr> [--repo owner/name] [--advisory]` reads the Codex review state of one pull request and prints a single `GATE …` line plus the open threads. It never merges anything.

## Verdicts

| `verdict=` | What it means |
| --- | --- |
| `ack_clean` | Codex reviewed this exact head and reported nothing. The only mergeable verdict. |
| `ack_with_findings` | Codex reviewed this head and left findings. Read the threads. |
| `ack_findings_no_threads` | A findings review landed but its threads have not appeared yet. Re-run in a minute. |
| `ack_without_verdict` | Codex spoke about this head without saying clean or not. Read what it said. |
| `ack_unsettled` | The acknowledgement is too fresh to trust; later threads may still land. |
| `ack_unattributable` | Something acknowledged the head but the author could not be confirmed as Codex. |
| `ack_baseline_unavailable` | No first-sighting timestamp, so an old acknowledgement cannot be told from a new one. |
| `ack_predates_baseline` | The only acknowledgement is older than the gate's first sighting of the PR. |
| `no_ack_yet` | Codex has not looked at this head. Wait, or ask it to. |
| `head_moved` | The branch advanced while the gate was reading. Every other signal is stale; re-run. |
| `draft_not_eligible` | The PR is a draft. |
| `rate_limited` | The API throttled the read; the answer is unknown, not negative. |
| `signal_truncated` | A thread or check page was cut off, so the reading is incomplete. |

`merge_ok=1` requires `ack_clean`, an open PR, an unchanged head, green CI, no open threads, and a mergeable merge state. Anything else prints `merge_ok=0`.

## Three facts about the data

- **A clean verdict is a thumbs-up reaction, not a review object.** When Codex finds nothing it reacts `+1` on the pull request and submits no review. Waiting for a review object to appear would wait forever on every clean pass.
- **REST appends `[bot]` to logins; GraphQL does not.** The same account reads as `chatgpt-codex-connector[bot]` through one API and `chatgpt-codex-connector` through the other. Both spellings are accepted; matching only one silently drops half the signal.
- **Threads are paged newest-first.** A truncated page therefore hides the OLDEST threads, which are the ones most likely still unresolved. That is why truncation is its own verdict rather than a missing thread.

## `--advisory`

With `--advisory`, the CI conjunct is dropped when no check on the branch is marked required — the gate reports `advisory=1` on its output line. Every check is then informational, so a red one is read and fixed forward instead of blocking the merge.

It does not weaken anything else: with a required check present, a red CI still refuses the merge even under `--advisory`, and every other conjunct (ack, threads, head, merge state) is unchanged.

Use `--advisory` on a `develop` PR, where a red check lands and is fixed forward. Omit it on a `main` PR and merge only on `merge_ok=1`.
