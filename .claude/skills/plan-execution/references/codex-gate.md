# codex-gate

`node .claude/skills/plan-execution/scripts/codex-gate.mjs <pr> [--repo owner/name] [--advisory]` reads the Codex review state of one pull request and prints a single `GATE …` line plus the open threads. It never merges anything.

## Verdicts

| `verdict=` | What it means |
| --- | --- |
| `ack_clean` | Codex reviewed this exact head and reported nothing. The only mergeable verdict. |
| `ack_with_findings` | Codex reviewed this head and left findings. Read the threads. |
| `ack_findings_no_threads` | Codex filed findings for this head in a comment body, with no review threads. There is nothing to resolve, so GitHub will not block the merge; read the comment and fix. |
| `ack_without_verdict` | Codex spoke about this head without saying clean or not. Read what it said. |
| `ack_unsettled` | The acknowledgement is too fresh to trust; later threads may still land. |
| `ack_unattributable` | The only acknowledgement is bound to the head by its timestamp alone, and a Codex run for an older commit published after the push, so the acknowledgement may belong to that run. |
| `ack_baseline_unavailable` | No first-sighting timestamp, so an old acknowledgement cannot be told from a new one. |
| `ack_predates_baseline` | The only acknowledgement is older than the gate's first sighting of this head. |
| `no_ack_yet` | Codex has not looked at this head. Wait, or ask it to. |
| `head_moved` | The branch advanced while the gate was reading. Every other signal is stale; re-run. |
| `draft_not_eligible` | The PR is a draft. |
| `rate_limited` | Since the push, Codex posted that it has reached its usage limits for code reviews. Not an acknowledgement; stop polling. |
| `signal_truncated` | A thread or check page was cut off, so the reading is incomplete. |

## `merge_ok`

`merge_ok=1` requires every one of these; anything else prints `merge_ok=0`:

- the verdict is `ack_clean`;
- the PR is open;
- the head the gate re-reads after its last probe is the head it started with;
- a check suite dates the push, so the time an acknowledgement must post-date does not rest on the author's commit clock;
- CI is green, or, under `--advisory`, red while no check on the branch is marked required (see [`--advisory`](#--advisory));
- no unresolved Codex thread, outdated or not;
- neither the thread list nor the check list was cut off;
- if the only acknowledgements are bound to the head by timestamp alone, no Codex run for an older commit published after the push;
- if the only acknowledgements are bound to the head by timestamp alone, the gate has a usable first sighting of this head;
- at least one acknowledgement survives, rather than every one being refused for predating the first sighting;
- GitHub's merge state is `CLEAN`, `HAS_HOOKS` or `UNSTABLE`.

## How Codex acknowledges a head

Any one of these acknowledges the head. A sha-bound one names the commit itself, so no timestamp can make it stale; a timestamp-bound one counts only when it was posted at or after the ack anchor.

| Shape | Bound by | What it says |
| --- | --- | --- |
| A Codex review whose `commit_id` is the head | sha | Codex reviewed this commit; its findings arrive as review threads. |
| A Codex `+1` reaction on the pull request | timestamp | No suggestions. |
| A Codex comment whose `Reviewed commit:` line names the head | sha | Codex reviewed this commit. Clean only if the same comment says "Didn't find any major issues". |
| A Codex comment saying "Didn't find any major issues" with no `Reviewed commit:` line | timestamp | Clean. A clean comment whose `Reviewed commit:` line names another commit is a verdict on that commit and acknowledges nothing here. |
| A Codex findings summary (a `### 💡 Codex Review` heading or a `P1`-style badge) whose links name the head | sha | Findings, delivered in the comment body instead of as threads. |

A Codex comment saying it has reached its usage limits for code reviews is not an acknowledgement: it ends the poll as `rate_limited`. A limit notice for security reviews does not, because that quota does not stop the code review.

The ack anchor is the latest of three times: the head commit's timestamp, the earliest check suite GitHub created for the sha, and the gate's own first sighting of the sha as this PR's head, which it stores under `.cache/codex-gate/`. The usage-limits notice and the check for a run on an older commit use only the first two, because both ask about the push, not about when the gate first looked.

A review or comment acknowledgement younger than two minutes, with no open threads yet, is held as `ack_unsettled`, because its threads may still be appearing. An acknowledgement with no usable timestamp is treated as one that just landed.

## Three facts about the data

- **A clean pass is usually not a review object.** When Codex finds nothing it reacts `+1` or posts a clean-verdict comment and submits no review. Waiting for a review object to appear would wait forever on every clean pass.
- **REST appends `[bot]` to logins; GraphQL does not.** The same account reads as `chatgpt-codex-connector[bot]` through one API and `chatgpt-codex-connector` through the other. The gate matches each API with its own spelling: the `[bot]` form for reviews, reactions and comments (REST), the bare form for review-thread authors (GraphQL). The wrong spelling for an API matches nothing, silently.
- **Every thread and every check is read.** The gate pages through review threads and checks 100 at a time until none are left. If the reading stops short — the server reports more items than it returned, sends no total, repeats a page cursor, or the 20-page limit is reached with pages left — the count cannot be trusted, since a missing thread could be an unresolved finding. That is why truncation is its own verdict and never mergeable.

## `--advisory`

Which checks count as CI: when any check on the branch is marked required, only the required ones; when none is, every check.

`--advisory` excuses exactly one case: CI is red and no check on the branch is marked required. Every check is then informational, so a red one is read and fixed forward instead of blocking the merge. It never excuses CI that is pending or that reported no checks, and never a red required check. Every other `merge_ok` condition is unchanged.

`advisory=1` on the `GATE` line means the flag was passed, not that it excused anything; `advisory=0` means it was not.

Use `--advisory` on a `develop` PR, where a red check lands and is fixed forward. Omit it on a `main` PR and merge only on `merge_ok=1`.
