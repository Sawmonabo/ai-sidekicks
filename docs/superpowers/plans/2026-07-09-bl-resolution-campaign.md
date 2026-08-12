# Backlog-Resolution Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

| Field | Value |
| --- | --- |
| Status | approved (2026-07-10 — owner directed landing after the multi-round hardening review; recorded in PR-0's body) |
| Drafted | 2026-07-09 |
| Design | [2026-07-09-bl-resolution-campaign-design.md](../specs/2026-07-09-bl-resolution-campaign-design.md) |
| Owner | user (a.sawmon@gmail.com) |
| Tracker | **this plan** — per-task checkboxes; the five BLs move to the archive as their code lands (Design §6) |

**Goal:** Resolve BL-141, BL-133, BL-131, BL-123, BL-122 to shipped, tested code — each doc-gated unit as amendment → promotion → code, each ungated unit as one PR — and move every completed BL to the archive with a whole-corpus coherence scan.

**Architecture:** Ten PRs across three lane classes (Design §5). Units A (P1 authz) and B (P2 invite preview + wire transport) are lane-4→lane-1: a governance-doc PR amends the covering spec/plan (flipping it to `review`), a two-line promotion micro-PR restores `approved`, then a lane-1 code PR ships under the plan's now-new manifest tasks. Units C (lane 2 tests), D (lane 3 coverage tooling), E (lane 3 cache) are single ungated PRs. A closure task scans the whole corpus.

**Tech Stack:** TypeScript across `packages/` + `apps/` (pnpm@10.33.2 / Node ≥22.12.0, never npm; Turbo; Vitest 4.x + PGlite; tRPC v11; Zod); Markdown governance under prettier + docs-corpus-gate; GitHub Actions CI; git worktrees under `.worktrees/`; `gh` + the Codex review bot.

## Global Constraints

Every task inherits all of these. Values copied verbatim from the Design and the repo's governing docs.

- **The Design is the content contract.** Each task cites its Design section (§4.A–§4.E, §3 ground truth, §5 lane matrix); this plan sequences, shows code, and gates. On any ambiguity the Design governs.
- **Build to done (Design R1).** Every unit ends in tested code, not a plan entry. No slice is deferred except the named gates in Design §1.2 (Plan-021 rate-limit wiring; Plan-023 Tier-8 E2E + IPC; V1.1 thresholds), each with its gate named in the BL closure note.
- **Lane discipline (Design R2 / §5).** Classify before branching per [CONTRIBUTING.md §How Code Lands](../../../CONTRIBUTING.md). Lane-1 PRs carry the `Plan-NNN` title token + a plan-scoped branch (`<type>/plan-NNN-*`) + preflight; lane-2/3 PRs MUST NOT carry the token and MUST NOT use a plan-scoped branch (the `lane-boundary` CI job fails both mislabels). Tier order binds lane 1 only.
- **Status-flip mechanics (Design R3 / [runbook:233](../../operations/plan-implementation-readiness-audit-runbook.md)).** A behavior-changing spec/plan amendment flips `approved → review` at landing and re-earns `approved` via a promotion micro-PR (citing runbook §Spec-Status Promotion Gate by name + the audit-delta evidence carried in the amendment PR body) BEFORE its lane-1 code PR. Note-only / clarification edits stay `approved` (declare the classification in the PR body per the runbook default rule).
- **Durable cites (AGENTS.md §Citation Standard).** Committed docs never cite `.agents/tmp/**` or ephemeral namespaces. Code→doc cites use `path#symbol` anchors, never raw `file:line` into `packages/` (gate-denied). Backtick every underscore-bearing identifier in `.md` prose (prettier corrupts bare `foo_bar` near `_italics_`).
- **Secrets (executor-run; never silently blocked):** PR-E sets the repo secret itself — `openssl rand -hex 32 | gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY` (the `gh` CLI is owner-authenticated; 32 random bytes, hex-encoded, piped via stdin so the value never enters argv) — so the cache is live from the first post-merge run. Only a `gh` permission refusal (HTTP 403 — token lacks repo admin) downgrades this to an owner ACTIONABLE surfaced in the PR body; until set, the cache is inert (uploads/downloads no-op safely). No other manual or secret step exists in this campaign.
- **Toolchain.** `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (Turbo-driven); `pnpm format:check`. Full `pnpm typecheck` pre-push (lefthook skips `tsconfig.test.json`; test files typecheck only in the full turbo pass). `@ai-sidekicks/contracts` exported consts need explicit type annotations (`--isolatedDeclarations`, TS9010).
- **Branch/commit/PR conventions** ([CONTRIBUTING.md](../../../CONTRIBUTING.md)): branches off `develop`; Conventional Commits, `<type>(repo): …` (or package-noun scope for code), ≤72-char subject, body lines ≤100; footer trailers `Refs: ADR-NNN, BL-NNN, Plan-NNN` + a `Co-Authored-By:` trailer naming **the running model's harness-provided identity** (per [AGENTS.md](../../../AGENTS.md) §Model Policy: attribution strings derive from the running model; no committed file may require a model by name — do **not** copy a model name out of this plan); squash-merge with explicit `--subject`/`--body-file`, **never `--auto`**; merge only on CLEAN (CI green ∧ HEAD-anchored Codex ack ∧ zero unresolved non-outdated threads); reply-before-resolve on every review thread.
- **Worktree lanes** (CLAUDE.md §Worktrees): each PR in its own `.worktrees/<name>/`; `git worktree add .worktrees/<name> -b <branch> develop`; doc-only gates may run the MAIN checkout's binaries against the worktree's files; **code gates run inside the worktree after its one-time `pnpm install`** (SPP-3 — a fresh worktree has no `node_modules`, and a main-checkout turbo pass validates the unchanged main tree, not the edits); occupancy-checked removal; never edit the main checkout from worktree work.
- **advisor-after-edits** (standing feedback): after each substantive project-file edit, run the review check before the next reply (no advisor tool this session → the plan-execution reviewer subagents in SBP-Reviews stand in).

## Task DAG

| Task | PR | Lane | Depends on |
| --- | --- | --- | --- |
| 1 | PR-0 — campaign docs land | governance | — |
| 2 | PR-A1 — Unit A docs | governance | 1 |
| 3 | PR-A1p — Spec-003 + Plan-003 re-promotion | governance | 2 |
| 4 | PR-A2 — Unit A code + BL-141 archive | lane 4→1 | 3 |
| 5 | PR-B1 — Unit B docs | governance | 1 (merge-serialize census vs Task 2) |
| 6 | PR-B1p — Spec-002 + Spec-021 + Plan-002 re-promotion | governance | 5 |
| 7 | PR-B2 — Unit B code + BL-133 archive | lane 1 | 6 |
| 8 | PR-C — Unit C tests + BL-131 rewrite + BL-134 note | lane 2 | 1 |
| 9 | PR-D — Unit D coverage substrate + BL-123 update | lane 3 | 1 |
| 10 | PR-E — Unit E cache + BL-122/ADR-023 fixes | lane 3 | 1 |
| 11 | Closure — whole-corpus coherence scan | governance | 2–10 |

**Binding edges:** 1→2→3→4 and 1→5→6→7 only. Tasks 8/9/10 have no doc or tier gate — parallel worktrees, any time after Task 1. Priority (recommendation): A → B → C → D → E. Census-touching PRs (2, 5) serialize at merge.

## Standard PR Procedure (SPP)

Every task's final steps run this with its own branch/subject/files. Doc-only gates may borrow the main checkout's binaries (`pnpm exec` / `node_modules/.bin` invoked against the worktree's files); **code gates must execute inside the worktree** — see SPP-3.

- **SPP-1 · Lane.** `git worktree add .worktrees/<name> -b <branch> develop`. Work inside `.worktrees/<name>/`. Lefthook may not fire inside worktrees — the explicit gates + CI are the real enforcement.
- **SPP-2 · Author.** Write deliverables per the task's Design section. Re-verify every `:NNN` anchor and relative link against the live worktree.
- **SPP-3 · Gates (local).**
  - Docs: `node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts <touched .md>` + `lychee --offline --no-progress --config .lychee.toml <touched .md>`; `pnpm exec prettier --check --ignore-path=.prettierignore <touched files>` (the `--ignore-path` override is load-bearing — prettier 3.x skips gitignored `.worktrees/` files otherwise). Set-quantifier/census edits: re-derive each total by counting rows; run `/ripple-check` on the diff.
  - Code: **from the worktree root** (`cd .worktrees/<name>`), first a one-time `pnpm install` — a fresh worktree has **no `node_modules`**, and pnpm hardlinks from the machine's content-addressable store so this is seconds, not a re-download — then `pnpm typecheck && pnpm lint && pnpm test` (full turbo pass — test files only typecheck here) and the touched package's `vitest run`. Running turbo from the **main checkout** instead validates the unchanged main tree, not your edits — a green main-checkout pass on a worktree-authored code PR is a lie (this is the code-gate analogue of the prettier `--ignore-path` trap above).
  - `echo "<subject>" | pnpm exec commitlint` → zero problems.
  - Ephemeral-namespace grep over the diff's **added** lines: `git -C .worktrees/<name> diff develop... | grep -E '^\+[^+]' | grep -E '\.agents/tmp|F-[0-9]{4}|agent-brain' | grep -vF 'Ephemeral-namespace grep'`. Review each surviving hit: a backtick-quoted _mention_ of the rule (as in this plan's Durable-cites bullet) is allowed; a live _citation_ — a markdown link, a `Refs:`/References entry, or a bare path used as a source — into an ephemeral namespace is the violation to remove. The `^\+[^+]` prefilter scopes to added content (not context or `+++` headers); the trailing `grep -vF` drops this guard's own bullet from its own diff so the check never self-trips on the pattern literals it must name.
- **SPP-4 · Reviews.** Dispatch `plan-execution-code-reviewer` + `plan-execution-code-quality-reviewer` (+ `plan-execution-spec-reviewer` for doc/contract tasks) in parallel on the diff. Fix ACTIONABLE; apply POLISH in-PR; record VERIFICATION as no-op.
- **SPP-5 · PR.** Commit (subject + `Refs:` + `Co-Authored-By:` trailers), push, `gh pr create --base develop` with the lane classification declared in the body (code PRs include a Test Plan). Wait on `ci-gate` + `docs-corpus-gate` + the Codex round-trip: reply to every thread before resolving; re-push fixes.
- **SPP-6 · Merge.** Poll `gh pr view <PR#> --json mergeStateStatus,headRefOid` until `mergeStateStatus` reads `CLEAN`, then merge the head that same poll observed: `gh pr merge --squash --subject "<explicit subject>" --body-file <body> --match-head-commit <headRefOid>` (never the default title). Both fields come out of ONE `gh pr view` call and the pin is not optional — naming `CLEAN` without pinning the head it was read from is precisely the check-then-act window this step used to leave open: `CLEAN` is a claim about a moment, not about a commit, so a push landing between the read and the merge lands an unchecked HEAD. A rejected pin means the branch moved mid-poll, so re-poll rather than re-fire. Then `git worktree remove .worktrees/<name>` (occupancy-checked).

---

### Task 1: PR-0 — Land campaign docs

**Files:** Create (commit pre-written): `docs/superpowers/specs/2026-07-09-bl-resolution-campaign-design.md`, `docs/superpowers/plans/2026-07-09-bl-resolution-campaign.md`.

**Interfaces:** Produces the Design + Plan every later PR cites. Consumes nothing.

- [x] **Step 1:** **Record the campaign-start SHA** — `git rev-parse develop` before branching — and note it in this plan's §Progress Log (Task 11 Step 4's `/ripple-check --target=<SHA>` needs it; by closure time `develop` already contains every campaign change, so a `--target=develop` diff would be empty). Then SPP-1 name=`bl-campaign-docs`, branch=`docs/bl-resolution-campaign`.
- [x] **Step 2:** Land both files; flip both Status fields `draft → approved` on recorded owner approval (PR body records it).
- [x] **Step 3:** SPP-3 docs gates on both files.
- [x] **Step 4:** SPP-4/5/6 — subject `docs(repo): add bl-resolution campaign design + plan`, trailer `Refs: BL-141, BL-133, BL-131, BL-123, BL-122`.

> **Task 1 is complete** — it is the PR that lands this plan. The boxes are ticked in that same commit so a fresh session reading the plan does not re-open PR-0 or treat Task 2+ as blocked. See §Progress Log for the merge record.

---

### Task 2: PR-A1 — Unit A docs (BL-141)

**Design contract:** §4.A (decisions 1–9), §3.1 ground truth.

**Files:**

- Create: `docs/decisions/025-runtime-node-control-plane-caller-authorization.md` (from `docs/decisions/000-adr-template.md`; Type 2 — complete every section). _(2026-08-12: filename corrected — the ADR's title is "Runtime-Node Control-Plane Caller Authorization", which slugs to the path above; the bullet previously named `025-runtime-node-caller-authorization.md`, which is not the file that landed.)_
- Modify: `docs/specs/003-runtime-node-attach.md` (already `review` since the 2026-08-03 V1 product-vision reconciliation flip — this amendment lands with no status transition; §Interfaces And Contracts + §Required Behavior authorization precondition for all five procedures — including **attach's session-membership precondition** (axis a); the four behavior changes recorded; dated Amendment block).
- Modify: `docs/architecture/contracts/error-contracts.md` (§Runtime Node — add **two** rows: `runtimenode.not_found` (404) + `runtimenode.permission_denied` (403); **and narrow** `runtimenode.capabilityupdate_conflict`'s description to the I-003-2 state guard. Per Step 4).
- Modify: `docs/plans/003-runtime-node-attach.md` (already `review` since the 2026-08-03 reconciliation flip — no status transition; new Phase-3 tasks T3.10/T3.11/T3.12; re-open the audit checkbox for the new tasks; §Progress Log note). **§Invariants takes two amendments:** (i) **I-003-3 amended** — its Verification note records that the runtime-node domain now _reads_ `session_memberships` for authorization under a `FOR SHARE` lock while still never mutating it; its two normative sentences (`RuntimeNodeAttach` MUST NOT modify `session_memberships`; `MembershipUpdate` MUST NOT trigger runtime-node detach as a side effect) are **unchanged and explicitly re-affirmed** — the `owner_inactive_member` detach carve-out exists so the second one can hold without stranding nodes. (ii) **I-003-6 added** — _any transaction touching both `session_memberships` and `runtime_node_attachments` MUST lock in the order `sessions` → `session_memberships` → `runtime_node_attachments`, counting implicit FK locks (an INSERT takes `FOR KEY SHARE` on each FK-parent row)_ — the counting clause is load-bearing: it is why `attach`'s upsert forces an explicit level-1 `sessions … FOR KEY SHARE` first (Task 4 Step 10), extending I-002-4; verified by the `lock-ordering.test.ts` runtime-node block.
- Modify: `docs/plans/008-control-plane-relay-and-session-join.md` (I-008-4 endpoint list adds the five runtimenode procedures; Plan-008 promoted `approved` 2026-07-21 (W2.5 re-audit #239) — re-adjudicate the amendment under the Status Flip Rule in the PR, presumptively a flip: extending the security invariant's covered-endpoint set is a plan-body behavior change, a named flip trigger, so run flip → targeted re-audit → re-promotion with the PR's user pause as final arbiter).
- Modify: `README.md` (**both** §Project Status censuses — the plan-census and spec-census bullets carry **different totals**, so each takes its own delta. The **plan** bullet: Plan-003 `approved` → `review` — as of this writing `20 approved` → 19, `6 … in review` → 7, Plan-003 added to the named list. The **spec** bullet: Spec-003 `approved` → `review` — `21 approved` → 20, `6 … in review` → 7, Spec-003 added to the named list. Re-derive every count by counting, not arithmetic — the counting rule governs if intervening merges moved either census).

**Interfaces:** Produces ADR-025 (the caller-ownership decision) + the Spec-003 authorization preconditions + the two new `runtimenode.*` contract rows that PR-A2's code and reviews are conducted against.

**Corrections (2026-08-12, applied when this task's doc legs landed).** Four premises above were overtaken by the corpus and are superseded here rather than left to mislead whoever dispatches the code leg:

1. **The uniform negative is 403, not 404.** Steps 2 / 4 / 5 and the Files bullets were originally written against Design §3.1 decision 4's new `runtimenode.not_found` (404). ADR-025 ratified **Reading 1** on 2026-08-10: the uniform negative is the already-contracted `runtimenode.permission_denied` (403). No `runtimenode.not_found` row is added, the `NOT_FOUND`-reservation sentence in `error-contracts.md §Runtime Node` stands unamended, and `roster` keeps its single-statement, lock-free shape. Reasoning is not restated here — see [ADR-025](../../decisions/025-runtime-node-control-plane-caller-authorization.md) §Adjudication Record — Resolved At Ratification. Step 4's narrowing of `runtimenode.capabilityupdate_conflict` survives unchanged and did land.
2. **Step 6's Plan-008 premise was false.** Plan-008 was not `approved` at write time — the 2026-08-03 V1 product-vision reconciliation flipped it `review`, and its own restore vehicle (PR #323, 2026-08-11) landed without this leg. Step 6 was therefore executed in the same vehicle as Steps 2–5, with Plan-008 flip-and-restored `approved` in that swap, rather than as a separate flip → re-audit → re-promotion cycle.
3. **Step 7's and the Files bullet's census arithmetic is not usable as written.** Several sibling deltas moved both censuses between authoring and landing, so the counts were re-derived by counting at landing, per the counting rule the steps themselves state.
4. **Neither Spec-003 nor Plan-003 took a `review` flip from this task.** Both were already `review` from the 2026-08-03 reconciliation, and the BL-141 growth was folded into the scope of that pair's restoring targeted readiness-audit delta — which is the vehicle these steps landed in — so the pair flipped once, to `approved`, rather than down and back up.
5. **Task 4's body below is rewritten in place, not overlaid (Codex PR #327 round 1).** The still-open code task originally carried the decision-4 contract in its executable text — `RUNTIME_NODE_NOT_FOUND_CODE`, `RuntimeNodePermissionDeniedException`, `NOT_FOUND` catch-arms, 404 assertions, a locked two-statement roster, and a blanket attachment `FOR UPDATE` — which, followed as written, would have produced code contradicting ADR-025, Spec-003, and the error registry. Every step, snippet, and table below now carries the ratified contract directly: the uniform 403, the single-statement lock-free roster (D7), per-procedure level-3 modes (D8 — `capabilityupdate`/`detach` `FOR NO KEY UPDATE`, `heartbeat` `FOR SHARE`), `detach`'s ratified negative split (`member_not_owner` → 403; every invisible cause → the idempotent `null`), and the router self-check mapped through the typed refusal (D5/D9).
6. **Round-2 refinements (Codex PR #327 round 2, 2026-08-12).** Three additions recorded across the corpus and mirrored below: the ADR-025 §Uniform-Negative Scope residual now names known-id post-detach squatting for roster-disclosed ids — pinned by an accepted-residual test in Plan-003 T3.12 and Step 7 below, closing mechanism the V1.1 node-identity trust anchor (ADR-017); Plan-008's `T-008r-1-5` gains the host-wiring leg (the throwing `resolveCurrentParticipantId` swap + per-route verified-token tests) so I-008-4's runtimenode rows have an owned path to production-live; and Spec-003's under-lock mandate is scoped to the four mutations, stating the D7 lock-free roster exemption at the source. The design spec's §4.A carries a supersession note pointing at ADR-025 and this block.

- [x] **Step 1:** SPP-1 name=`a1-authz-docs`, branch=`docs/bl-141-authz`. _(2026-08-12: executed on the merged vehicle's branch `docs/plan-003-caller-auth-delta` instead — the Plan-003/Spec-003 restoring targeted readiness-audit delta, which carries this task's doc legs and Task 3's promotion legs in one PR under the Dual-flip gate.)_
- [x] **Step 2:** Author ADR-025 recording Design §4.A decisions 1–9 (decision 9 — extending Plan-008's I-008-4 gated-endpoint invariant to the five runtime-node procedures — is _recorded_ here as part of the authorization-hardening rationale; its file-level _implementation_, the Plan-008 I-008-4 list edit, lands in Step 6) with antithesis (row-loading middleware — rejected for TOCTOU/double-fetch; Cedar now — rejected per cedar#1226 + ADR-012 approval-scope, with the named relational-growth revisit criterion; flat-404 everywhere — rejected where the corpus already discloses to members) + synthesis (transaction-interior predicate **plus the classify-then-mutate locking contract**, Design §4.A decision 1 §Locking discipline; two-tier `NOT_FOUND`/403; first-attacher-owns-`node_id`; **attach's two authorization axes — the shipped node-identity axis (b) and the newly-enforced session-membership axis (a), decision 5**; heartbeat/roster hardening). Include a **§Lock Order** subsection recording the new **I-003-6** canonical order (`sessions` → `session_memberships` → `runtime_node_attachments`, **counting implicit FK locks** — an INSERT takes `FOR KEY SHARE` on each FK-parent row, which is why `attach` opens with an explicit level-1 `sessions … FOR KEY SHARE` rather than letting its upsert acquire it after the membership lock, the ABBA inverse of `updateMembership`'s shipped order) as an extension of I-002-4, the two-phase resolve it forces on the `nodeId`-keyed procedures, and the per-level lock modes: `FOR KEY SHARE` on `sessions` (attach only), `FOR SHARE` — not `FOR UPDATE`, and never `FOR KEY SHARE` — on the membership row, `FOR UPDATE` on the attachment. Record the **`owner_inactive_member` detach carve-out** with its rejected antithesis: reaping attachments from `MembershipService.updateMembership` is forbidden by Plan-003 I-003-3 (`MembershipUpdate` MUST NOT trigger a runtime-node detach) and would usurp the ADR-012 Cedar-gated `revoked` authority producer that `attach-service.ts` explicitly defers. Include a **§Uniform-Negative Scope** subsection recording, as an accepted residual with mitigation + revisit criterion, that `attach`'s 409 `attach_conflict` discloses one bit about a guessed `node_id` (Design §4.A decision 4 §Scope) — a Type-2 ADR must carry its own counterexample. Cite OWASP API1:2023, ASVS v5 8.2.2/8.3.1/8.3.3, cedar#1226, Matrix MSC3266 (Design §9 URLs). _(2026-08-12: ADR-025 landed `accepted` with eleven decision parts D1–D11 covering everything this step names — the transaction-interior predicate, the classify-then-mutate locking contract as D8 plus the new I-003-6, both attach axes, the heartbeat/roster hardening, the `owner_inactive_member` detach carve-out with its rejected reaping antithesis, and the `attach_conflict` one-bit residual with a named revisit criterion. Two deviations, both recorded in the ADR: the negative is 403 per correction 1 above, not the two-tier `NOT_FOUND`/403 this step names; and the `cedar#1226` citation is carried as **stale-and-corrected** (closed, resolved by PR #1256) rather than as a live blocker, with the rejection re-grounded on atomicity. Lock modes shipped as `FOR NO KEY UPDATE` on the attachment rather than `FOR UPDATE` — weakest-sufficient per PostgreSQL Table 13.3, the partial index excluding `state` from the escalation set. Matrix MSC3266 is not cited: no leg of the decision rests on it.)_
- [x] **Step 3:** Amend Spec-003 with the authorization preconditions and **all four behavior changes** (Design §4.A doc deliverables): a per-procedure precondition sentence for attach/heartbeat/capabilityupdate/detach (caller == active-node owner; cross-session → uniform not-found) + roster (session-membership predicate) + **attach's session-membership precondition (axis a)**. Record the four behavior changes explicitly: (1) attach's session-membership precondition is now **enforced** with a typed 404 (was required-but-unenforced — a non-member attach previously succeeded, a nonexistent-session attach raised a raw FK-500); (2) the heartbeat presence-forgery close; (3) the roster empty-for-unknown-session supersession; (4) `capabilityupdate`'s 409→404 split for the no-active-row arm. Add the I-003-3 read-vs-mutate note: attach/roster now **read** `session_memberships` for authorization while still never **mutating** it. Dated Amendment block (Spec-003/Spec-006 block precedent). Status is already `review` (2026-08-03 reconciliation flip) — record this amendment's flip reason in the dated Amendment block rather than a second transition. _(2026-08-12: executed as three in-place tail extensions under Spec-003's zero-net-line rule — §Required Behavior line 46 carries the substantive precondition, §Interfaces And Contracts line 90 the refusal contract, and the §Default Behavior blockquote the dated amendment record; `wc -l` is 174 before and after, so none of the 75 live `Spec-003 line NNN` cites moved. Behavior change (1) lands as a typed 403 refusal, not a 404, per correction 1; changes (2)–(4) as written. The read-vs-mutate note lands on Plan-003 I-003-3 itself, which is where the invariant text lives.)_
- [x] **Step 4:** Amend error-contracts §Runtime Node per Design §4.A: add the `runtimenode.not_found` (404) and `runtimenode.permission_denied` (403) rows verbatim from the Design's table (the `not_found` description covers roster/attach non-member/nonexistent-session too), and **narrow** `runtimenode.capabilityupdate_conflict`'s description to the I-003-2 `registering→online` state guard (its no-active-attachment arm moves to the new 404). Re-derive the §Runtime Node row count by counting. _(2026-08-12: the narrowing landed as written. The two-row addition did not: per correction 1 no `runtimenode.not_found` row exists, and the existing `runtimenode.permission_denied` row was extended with the four attach-surface call sites instead of a new row being added — so the §Runtime Node row count is unmoved and no re-derivation was owed.)_
- [x] **Step 5:** Add Plan-003 Phase-3 tasks (acceptance criteria tracing to ADR-025 + the Spec-003 rows): **T3.10** (the `classifyRuntimeNodeCaller` predicate + the two typed errors `RuntimeNodePermissionDeniedException`/`RuntimeNodePermissionDeniedException` + the `participant_id` SELECT-column extension on `updateCapabilities` + per-procedure negatives across heartbeat/capabilityupdate/detach), **T3.11** (the two session-scoped membership checks — **attach's axis-a session-membership guard AND the roster membership predicate**), **T3.12** (the two-account IDOR suite across the service / router / HTTP-envelope layers + the attach node-identity (axis-b) regression tests); Status already `review` (2026-08-03 reconciliation flip — no transition); re-open the audit checkbox scoped to the new tasks (Plan-014 precedent wording); fold the scoped audit-delta evidence into a §Progress Log note for PR-A1p to cite. _(2026-08-12: T3.10–T3.12 landed with the acceptance criteria this step names, minus the `RuntimeNodePermissionDeniedException` half of T3.10's typed-error pair, which correction 1 removes. Placed in Phase 3 rather than a new phase, with the `partially_shipped` transition recorded in the Phase-3 preamble. The audit checkbox was re-opened **and re-checked in the same commit** — growth and audit land together — so the evidence sits in the box text and in the §Preconditions record rather than in a §Progress Log note for a separate promotion PR, Task 3 having merged into this same vehicle.)_
- [x] **Step 6:** Amend Plan-008 I-008-4 to add `runtimenode.attach` / `heartbeat` / `capabilityupdate` / `detach` / `roster` to the gated-endpoint list (one-line rationale: the runtime-node guard consumes the same R1 middleware output). _(2026-08-12: executed in this same vehicle per correction 2, with Plan-008 flip-and-restored `approved` in the same swap and its §Preconditions plan-readiness box re-opened-and-re-checked scoped to this single leg. Spec-008 untouched — the leg is plan-body only.)_
- [x] **Step 7:** Update **both** README censuses: the plan line (Plan-003 → `review`) **and** the spec line (Spec-003 → `review`: `21 approved` → 20, `6 … in review` → 7, Spec-003 added to the named list — README tracks a spec census beside the plan census; flipping only one lands a README that contradicts Spec-003's own header). Counts re-derived by counting. Then `grep -rn "Plan-003\|Spec-003" README.md CLAUDE.md docs/` for any other status claim. _(2026-08-12: executed as the **restore**-side census per correction 4 — both bullets move Plan-003 and Spec-003 `review → approved` and drop them from the named lists, not into them. Counts re-derived by counting; the ADR census moved too, ADR-025 being a new file. The grep sweep additionally discharged the 2026-08-03 flip-cohort clauses in README.md and CLAUDE.md, this pair being the cohort's last member.)_
- [x] **Step 8:** SPP-3 docs gates + `/ripple-check` (heading/cite/set-quantifier risk). SPP-4 with `plan-execution-spec-reviewer`. SPP-5/6 — subject `docs(repo): adr-025 runtime-node caller-ownership authorization`, body declares the Spec-003 + Plan-003 amendments (both already `review` per the 2026-08-03 reconciliation flip) + the Plan-008 I-008-4 fix + the census ripple; trailer `Refs: ADR-025, Spec-003, Plan-003, Plan-008, BL-141`. _(2026-08-12: the merged vehicle's subject — `docs(repo): restore Spec/Plan-003 approved via dual-scope caller-authorization delta` — **supersedes** the subject prescribed here, because the vehicle is the dual-scope restoring delta rather than a standalone ADR-025 PR. The trailer landed as prescribed.)_

---

### Task 3: PR-A1p — Spec-003 + Plan-003 re-promotion

**Design contract:** §5 (promotion leg); [runbook §Spec-Status Promotion Gate](../../operations/plan-implementation-readiness-audit-runbook.md).

**Files:** Modify: `docs/specs/003-runtime-node-attach.md` (`review` → `approved`); `docs/plans/003-runtime-node-attach.md` (`review` → `approved`; tick the re-opened audit checkbox); `README.md` (**both** census lines restored — plan + spec).

**Interfaces:** Produces the `approved` Spec-003 + Plan-003 that PR-A2's lane-1 preflight (Gate 7) requires.

- [x] **Step 1:** SPP-1 name=`a1p-authz-promote`, branch=`docs/bl-141-promote`. _(2026-08-12: no separate branch — Task 2 and Task 3 merged into one vehicle, `docs/plan-003-caller-auth-delta`, exactly as this task's Dual-flip gate permits.)_
- [x] **Step 2:** Flip Spec-003 + Plan-003 to `approved`; tick the audit checkbox. PR body cites runbook §Spec-Status Promotion Gate by name and the PR-A1 audit-delta evidence (Spec-027/NS-13b promotion-PR precedent): the new Plan-003 tasks trace to ADR-025 + the amended Spec-003 rows; dep-closure terminal (ADR-025 accepted in PR-A1; ADR-010/012 accepted); no open questions gating Required Behavior. For the Plan-003 half, also satisfy the **plan-side** §Status Promotion Gate elements (runbook:210–214): cite the Tier-3 audit-completion date + the `plan-readiness-audit-tier-3-complete` tag. **Dual-flip gate (2026-08-03):** Spec-003 + Plan-003 also carry the V1 product-vision reconciliation's `review` flip, whose restoring targeted readiness-audit delta is independent of BL-141's — flip to `approved` only after BOTH restoring deltas have landed, or land one combined targeted delta whose PR body declares coverage of both amendment scopes. _(2026-08-12: the **combined** arm was taken — one restoring targeted readiness-audit delta covering both amendment scopes, the 2026-08-03 reconciliation growth and the BL-141 growth, with the PR body declaring both. Spec-003 and Plan-003 flipped `review → approved` and all four Plan-003 §Preconditions boxes read `- [x]`; the plan-readiness box was re-opened by this PR's own growth and re-checked by this PR's audit in the same commit. The plan-side §Status Promotion Gate elements are satisfied by the Tier-3 audit landed via NS-15, cited in that box.)_
- [x] **Step 3:** Restore **both** README §Project Status censuses — per census, never one delta applied to both: the **plan** bullet returns Plan-003 to `approved` (`19 approved` → 20, `7 … in review` → 6, Plan-003 dropped from the named list) and the **spec** bullet returns Spec-003 to `approved` (`20 approved` → 21, `7 … in review` → 6, Spec-003 dropped from the named list). Counts re-derived by counting. _(2026-08-12: executed. The literal figures above are stale — sibling deltas moved both censuses between authoring and landing — so both bullets were re-derived by counting, as the step's own rule requires, and the ADR census was re-derived alongside them for the new ADR-025 file.)_
- [x] **Step 4:** SPP-3/4/5/6 — subject `docs(repo): re-promote spec-003 + plan-003 (adr-025 audit delta)`, trailer `Refs: Spec-003, Plan-003, BL-141`. _(2026-08-12: the merged vehicle's subject — `docs(repo): restore Spec/Plan-003 approved via dual-scope caller-authorization delta` — **supersedes** the subject prescribed here, and its trailer is the union `Refs: ADR-025, Spec-003, Plan-003, Plan-008, BL-141`, since one PR carries both tasks.)_

---

### Task 4: PR-A2 — Unit A code + BL-141 archive (lane 4 → lane 1)

**Design contract:** §4.A code deliverables; §3.1 seams.

**Files:**

- Modify: `packages/contracts/src/error.ts` (add `RUNTIME_NODE_PERMISSION_DENIED_CODE` — **only if** Plan-006 T4.10 has not already landed it, per ADR-025 D10's first-lander rule).
- Modify: `packages/control-plane/src/runtime-nodes/errors.ts` (add `RuntimeNodePermissionDeniedException`; narrow `RuntimeNodeCapabilityUpdateConflictException`'s doc comment to the surviving state-conflict arm).
- Create: `packages/control-plane/src/runtime-nodes/classify-caller.ts` (`classifyRuntimeNodeCaller`).
- Modify: `packages/control-plane/src/runtime-nodes/heartbeat-service.ts` (`ingest` gains a caller param + transaction: resolve active attachment, classify, then upsert).
- Modify: `packages/control-plane/src/runtime-nodes/attach-service.ts` — **all four methods gain `callerParticipantId` as the first parameter** (and the file imports `canonicalizeUuid` from `@ai-sidekicks/contracts`). **`attach` gains a service-level identity pre-guard** (Design §4.A decision 5): before the transaction, `canonicalizeUuid(callerParticipantId) !== canonicalizeUuid(validated.participantId)` → `RuntimeNodePermissionDeniedException` — the trusted-layer enforcement (ASVS 8.3.1) of what the router self-check also does, because the exported service is called directly by the service-level tests and any future non-router caller. `updateCapabilities` / `detach` / `readRoster` gain the classification/membership predicate (Design §4.A decisions 3/4/6/7). **`attach` gains the axis-a session-membership guard (Design §4.A decision 5)**: inside the existing `this.#querier.transaction`, the shipped floor read becomes the **level-1 lock acquisition** — `SELECT min_client_version FROM sessions WHERE id = $1 FOR KEY SHARE`, running FIRST (0 rows → `RuntimeNodePermissionDeniedException`, superseding the raw FK-500 a nonexistent session used to raise); the membership guard runs second — the caller holds an `active` `session_memberships` row for `validated.sessionId`, absent → the **same exception with the byte-identical message** (non-member and nonexistent-session must be indistinguishable, superseding the silent non-member success). The explicit `FOR KEY SHARE` is deadlock-load-bearing: the upsert's INSERT implicitly takes `FOR KEY SHARE` on the FK-referenced `sessions` row, so without the explicit level-1 acquisition attach would lock level 2 then level 1 — the ABBA inverse of `MembershipService.updateMembership`'s shipped `sessions FOR UPDATE → memberships` order (I-002-4; `FOR UPDATE` conflicts with `FOR KEY SHARE`, PostgreSQL Table 13.3). The axis-b node-identity guard (owner-immutability `WHERE … participant_id = EXCLUDED.participant_id` + the `23505` → `attach_conflict` path) is already shipped and unchanged — PR-A2 adds regression tests for it. **The floor-read comment inside `attach`, which currently reads "session existence/authorization is the router's gate (T3.8), not this service's," is corrected** — the service now enforces the membership precondition itself. `updateCapabilities`' `FOR UPDATE` SELECT (`AttachService.updateCapabilities`) gains **`participant_id`** in its column list (absent today; `classifyRuntimeNodeCaller` needs it — Design §4.A code deliverables). **Two shipped I-003-3 comments become false and must be corrected in this PR:** the file header's claim that attach "acquires NO `session_memberships` lock — it never references, SELECTs FOR UPDATE, or UPDATEs that table", and `detach`'s docstring mirror "It NEVER references, SELECTs FOR UPDATE, INSERTs, UPDATEs, or DELETEs `session_memberships`". Both are restated as **reads for authorization under `FOR SHARE`; never mutates** — the invariant governs mutation, and the byte-for-byte no-mutation tests (T3.2 / P8) still pass unchanged.
- Modify: `packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts` (resolve `callerParticipantId` per procedure and pass it down to all five, including `attach`; FORBIDDEN catch-arms on the four mutations + the roster query — ADR-025 Reading 1 mints no `NOT_FOUND` mapping anywhere on this surface; `attach` retains its self-check — **canonicalized in this PR and mapped through `RuntimeNodePermissionDeniedException`** rather than its shipped plain `UNAUTHORIZED` (ADR-025 D5/D9 — a bare 401 carries no `aisError` on the public transport): the raw `!==` would falsely refuse a legitimate same-participant attach whose body UUID differs only by case once the service pre-guard canonicalizes (Step 9)).
- Test: `packages/control-plane/src/runtime-nodes/__tests__/runtime-node-router.test.ts` (extend `buildHarness` with real helpers; router-level IDOR asserting tRPC `.code` + `.cause instanceof`) + `attach-service.test.ts` + `heartbeat-service.test.ts` (service-level IDOR: direct service calls with a stranger id; row-byte-unchanged). **`runtime-node-router.test.ts` is not only extended — it is migrated:** four shipped tests assert superseded postures (Step 12 item 7).
- Modify: `packages/control-plane/src/server/__tests__/host-runtime-node.test.ts` (HTTP-layer envelope oracle: byte-identical `data.aisError` + `data.httpStatus` for the not-visible vs no-active-row negatives — the only surface where `aisError` materializes, Design §3.1). **Also migrated:** its `capabilityupdate_conflict` projection test seeds nothing and expects 409; that arm is now the uniform 403 (Step 12 item 8).
- Modify: `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts` (**I-003-6 regression block** — extend the shipped logging-proxy `Querier` technique that already pins I-002-4, with **per-procedure assertions matching Step 7's breakdown, not one blanket order**: the two-phase order — unlocked attachment pre-read < `session_memberships … FOR SHARE` < the level-3 attachment lock in that procedure's D8 mode (`FOR NO KEY UPDATE` for `detach` / `updateCapabilities`, `FOR SHARE` for `heartbeat.ingest`) — for the three `nodeId`-keyed procedures **only**; `attach` separately (`sessions … FOR KEY SHARE` first, membership `FOR SHARE` second, both before any `runtime_node_attachments` statement; it creates the row via upsert, so it has **no** unlocked pre-read and **no** attachment `FOR UPDATE` — asserting the blanket order against `attach` would fail the correct implementation); `readRoster` separately (a **single `READ COMMITTED` statement** with **no lock and no transaction** — ADR-025 D7; assert no lock clause ever appears). Cross-directory but correct: this file is the canonical home of the lock-ordering invariant, and forking a second one would fracture it).
- Modify: `packages/client-sdk/test/runtimeNodeClient.integration.test.ts` (the `OTHER_SESSION` roster-isolation leg now seeds the caller's membership so the roster returns instead of refusing with the uniform 403 — runs on `test-node22`, so a miss reddens `ci-gate`; Design §4.A code deliverables §Cross-package ripple) + `packages/client-sdk/src/runtimeNodeClient.ts` (comment sweep: any comment asserting cross-session roster visibility is now membership-scoped).
- Modify: `docs/backlog.md` + `docs/archive/backlog-archive.md` (move BL-141).

**Interfaces:**

- Consumes: `resolveCurrentParticipantId(ctx): ParticipantId` (existing dep on `RuntimeNodeRouterDeps`); `session_memberships` (Plan-001-created table; `state IN ('pending','active','suspended','revoked')` — the predicate keys on `'active'`); the `AisWireException` errorFormatter path.
- Produces:
  - `RUNTIME_NODE_PERMISSION_DENIED_CODE: "runtimenode.permission_denied"` (created here only under ADR-025 D10's first-lander rule).
  - `class RuntimeNodePermissionDeniedException extends AisWireException`.
  - `type RuntimeNodeCallerVerdict = "owner_active_member" | "owner_inactive_member" | "member_not_owner" | "not_visible"` — **four** verdicts, because node-identity ownership and active session membership are independent facts (Design §4.A decision 3).
  - `classifyRuntimeNodeCaller(transaction: Querier, callerParticipantId: ParticipantId, row: { participant_id: string; session_id: string }): Promise<RuntimeNodeCallerVerdict>` — used by `detach` / `updateCapabilities` / `heartbeat` (which have an existing row to classify), each after an **unlocked** pre-read of that row and before the level-3 re-resolve in that procedure's D8 mode (I-003-6 lock order). It takes the level-2 `session_memberships … FOR SHARE` lock internally. `attach` instead runs a **direct `active`-membership SELECT `FOR SHARE`** inside its existing transaction (no existing node row to classify — it is creating one), AFTER its level-1 `sessions … FOR KEY SHARE` floor read (Step 10's deadlock note); `readRoster` calls neither this helper nor a separate membership SELECT — its membership predicate folds into the roster read as **one `READ COMMITTED` statement, no lock, no transaction** (ADR-025 D7: one statement is one snapshot, so no revocation can interleave and the authorization is atomic with the enumeration by construction). (`Querier` is the transaction-callback type — `migration-runner.ts` passes a connection-bound `Querier` to `transaction(fn)`, not a narrower type; there is no `Queryable`.)
  - All five service methods (`attach` / `updateCapabilities` / `detach` / `readRoster` / `HeartbeatService.ingest`) take `callerParticipantId: ParticipantId` as the **first** parameter.
  - Test-harness helpers on `buildHarness`'s return (Design §3.1 — none exist in `runtime-node-router.test.ts` today): `callerAs(participantId, ctx?)` (rebuilds the router over the same querier with `resolveCurrentParticipantId: () => participantId`), `rawAttachmentRow(nodeId)` / `rawPresenceRow(nodeId)` (direct `querier.query` row reads), `seedMembership({ sessionId, participantId, role?, state? })` — matching the field-name shape of the file-scope `seedMembership(querier, { … })` that ALREADY exists in `attach-service.test.ts`. (**Do not assume the same shape in `host-runtime-node.test.ts`** — its existing helper is **positional**, `seedMembership(querier, sessionId, participantId)`, with `'collaborator'`/`'active'` hardcoded; item 8 uses it as-is.)

**Uniform-negative rule (Design §4.A decision 4 — the oracle-closing invariant this task implements).** `not_visible` MUST produce each procedure's own no-active-row response, never a distinct one:

| Procedure | no-active-row / no-visible-session | `not_visible` | `member_not_owner` | `owner_inactive_member` |
| --- | --- | --- | --- | --- |
| `detach` | `null` (idempotent no-op — retry-safety) | `null` | 403 | **proceed** (self-service release) |
| `heartbeat` | 403 `runtimenode.permission_denied` | 403 (identical) | 403 (identical) | 403 (identical) |
| `capabilityupdate` | 403 `runtimenode.permission_denied` (**split out of the shipped 409**) | 403 (identical) | 403 (identical) | 403 (identical) |
| `roster` | 403 `runtimenode.permission_denied` (supersedes `{nodes: []}` for an unknown/invisible session; a **member of a visible-but-empty** session still gets `{nodes: []}`) | 403 (identical) | n/a — membership is the predicate | 403 (membership is the predicate) |
| `attach` | 403 `runtimenode.permission_denied` for a **non-member or nonexistent** session (axis a, **NEW** — supersedes silent success + the FK-500); 409 `attach_conflict` stays for the node-identity axis (axis b, shipped) | 403 (non-member) | n/a — attach has no pre-existing row to classify by membership; the caller's own membership is the predicate | 403 (membership is the predicate) |

`capabilityupdate` keeps its 409 **only** for the I-003-2 `registering→online` state guard, which is reachable only by the node's owner. `attach`'s axis-a 403 (membership) and axis-b 409 (`attach_conflict`, cross-owner / cross-session-active) are distinct refusals on distinct axes — the membership guard runs first, so a non-member never reaches the node-identity conflict path.

**Why `detach` alone carves out `owner_inactive_member` (Design §4.A decision 3).** `idx_node_attachments_active` is globally unique on `node_id`, so refusing a revoked owner's detach strands that node for **every** session, permanently — and Plan-003 I-003-3 forbids the obvious cleanup (`MembershipUpdate` MUST NOT trigger a runtime-node detach as a side effect). Detach is a **release** of the caller's own row: it writes only the two runtime-node tables, grants no session authority, and is unreachable by a non-owner (a stranger classifies `not_visible`). The other three procedures **drive** a node inside a session, which an inactive member has no standing to do. This yields the daemon recovery protocol: `409 attach_conflict` elsewhere → `detach` own node → re-attach.

**Scope of the invariant (Design §4.A decision 4 §Scope — do NOT overstate it).** Uniformity binds the four `nodeId`-keyed rows above. It does **not** bind `attach`'s 409 `attach_conflict`: `idx_node_attachments_active` is globally unique on `node_id`, so a caller who IS a member of their own session can probe a guessed `node_id` and distinguish "attached somewhere I can't see" (409) from "free" (success). That one-bit channel is inherent to the shipped I-003-5 global node identity, is **accepted and recorded in ADR-025 with its mitigation (high-entropy `node_id`; Tier-6 rate limit) and revisit criterion (node-id squatting observed, or `node_id` becomes user-authored → re-open I-003-5 for per-session uniqueness + server-minted ids)**. Write the ADR to say this; do not write "the guard never discloses cross-session node existence" without the `nodeId`-keyed qualifier — the shipped `attach_conflict` row description refutes the unqualified claim.

- [ ] **Step 1:** SPP-1 name=`a2-authz-code`, branch=`feat/plan-003-caller-authz`.

- [ ] **Step 2: Write the failing contracts test.** In `packages/contracts/src/__tests__/error.test.ts` (or the existing error test file):

```ts
import { RUNTIME_NODE_PERMISSION_DENIED_CODE } from "../error.js";

it("exports the runtimenode authorization wire code", () => {
  expect(RUNTIME_NODE_PERMISSION_DENIED_CODE).toBe("runtimenode.permission_denied");
});
```

- [ ] **Step 3:** Run `pnpm --filter @ai-sidekicks/contracts test` → FAIL (not exported).

- [ ] **Step 4: Add the constant** to `packages/contracts/src/error.ts` (skip if Plan-006 T4.10 landed it first — D10), matching the sibling `*_CODE` export shape with explicit type annotations (TS9010, `--isolatedDeclarations`):

```ts
export type RuntimeNodePermissionDeniedCode = "runtimenode.permission_denied";
export const RUNTIME_NODE_PERMISSION_DENIED_CODE: RuntimeNodePermissionDeniedCode =
  "runtimenode.permission_denied";
```

(The type+const pair is the shipped sibling shape throughout `error.ts` — every existing `*_CODE` pairs an exported type alias with the annotated const.)

- [ ] **Step 5:** Run the contracts test → PASS. Commit `feat(contracts): add runtimenode authorization wire codes`.

- [ ] **Step 6: Add the exception subclass** to `packages/control-plane/src/runtime-nodes/errors.ts` (mirror the code+message-only 409 siblings; no `details`), and narrow `RuntimeNodeCapabilityUpdateConflictException`'s doc comment to the surviving `registering→online` state-guard arm:

```ts
import { RUNTIME_NODE_PERMISSION_DENIED_CODE } from "@ai-sidekicks/contracts";
// ...existing imports...

/**
 * The uniform caller-authorization negative (ADR-025 Reading 1): thrown for
 * every non-permitted verdict on the runtimenode.* surface — cross-owner,
 * non-member, inactive-owner (detach's D3 permit excepted), unknown node,
 * unknown session — with a byte-identical message per procedure, so no arm
 * discloses existence. The one negative that is NOT this exception: detach
 * where no attachment is visible to the caller, which stays the idempotent
 * `null` no-op (D4). Code+message-only.
 */
export class RuntimeNodePermissionDeniedException extends AisWireException {
  readonly code: typeof RUNTIME_NODE_PERMISSION_DENIED_CODE = RUNTIME_NODE_PERMISSION_DENIED_CODE;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodePermissionDeniedException";
  }
}
```

- [ ] **Step 6b: Create `classify-caller.ts`** — the single predicate every procedure shares:

```ts
import { canonicalizeUuid, type ParticipantId } from "@ai-sidekicks/contracts";

import type { Querier } from "../sessions/migration-runner.js";

export type RuntimeNodeCallerVerdict =
  | "owner_active_member"
  | "owner_inactive_member"
  | "member_not_owner"
  | "not_visible";

/**
 * Transaction-interior caller classification (ADR-025). Runs INSIDE the caller's
 * transaction, after the target row is resolved, and returns a verdict about THAT
 * row — no double-fetch.
 *
 * CALLER CONTRACT 1 — LOCK ORDER (I-003-6, extends I-002-4): the canonical order is
 * `sessions` -> `session_memberships` -> `runtime_node_attachments`. This helper takes
 * the level-2 membership lock. A caller must therefore NOT already hold a
 * `runtime_node_attachments` row lock when it calls this — the three `nodeId`-keyed
 * mutators use the two-phase resolve (unlocked pre-read of the attachment to learn
 * `session_id`, then this call, then the level-3 attachment lock in that procedure's
 * D8 mode — `FOR NO KEY UPDATE` for detach/updateCapabilities, `FOR SHARE` for
 * heartbeat — with a re-verify). Calling this while holding the attachment lock inverts the order and
 * deadlocks against `attach`, which locks membership before inserting.
 *
 * CALLER CONTRACT 2 — RE-VERIFY (load-bearing): the verdict describes `row` as of the
 * unlocked pre-read. After taking the attachment lock the caller MUST re-check that
 * `(participant_id, session_id)` still equal the values passed here; under READ
 * COMMITTED an unlocked row can be retired and replaced by a different participant's
 * attachment in between, so applying a stale verdict is a TOCTOU hole (wrong-owner
 * detach / presence forgery), not a guard. A mismatch yields the procedure's uniform
 * negative. `readRoster` never calls this helper at all — its membership predicate
 * folds into its single-statement roster read (ADR-025 D7).
 *
 * `FOR SHARE`, not `FOR UPDATE` (the row is read, never written) and not `FOR KEY
 * SHARE` (which does NOT conflict with the `FOR NO KEY UPDATE` that
 * `UPDATE session_memberships SET state = 'revoked'` takes, and would be a silent
 * no-op guard). See PostgreSQL Table 13.3.
 *
 * The membership query gates EVERY verdict, including the owner's: the attachment row
 * keeps its creator's `participant_id` forever, so an owner short-circuit here would
 * let a `suspended`/`revoked` participant keep driving nodes in a session they left.
 * `MembershipService.updateMembership` ships `suspend`/`revoke` today.
 *
 * UUID canonicalization is REQUIRED on the owner comparison. `row.participant_id` is
 * the Postgres `uuid`-typed column (emitted lowercase), while `callerParticipantId`
 * flows from `resolveCurrentParticipantId(ctx)` and may be upper/mixed-case — ids in
 * this codebase are branded by bare `as` casts at DB-row reads, NOT normalized through
 * a schema (see `canonicalizeUuid`'s scope note). The SQL `WHERE participant_id = $2`
 * still matches (the `uuid` type compares case-insensitively), so a raw `===` would
 * classify the true owner as `member_not_owner` — silently refusing their own
 * heartbeat/capabilityupdate/detach. Canonicalize both sides before comparing.
 */
export async function classifyRuntimeNodeCaller(
  transaction: Querier,
  callerParticipantId: ParticipantId,
  row: { readonly participant_id: string; readonly session_id: string },
): Promise<RuntimeNodeCallerVerdict> {
  const membership = await transaction.query<{ one: number }>(
    `SELECT 1 AS one FROM session_memberships
      WHERE session_id = $1 AND participant_id = $2 AND state = 'active'
      FOR SHARE`,
    [row.session_id, callerParticipantId],
  );
  const isOwner = canonicalizeUuid(row.participant_id) === canonicalizeUuid(callerParticipantId);
  if (membership.rows[0] === undefined) {
    return isOwner ? "owner_inactive_member" : "not_visible";
  }
  return isOwner ? "owner_active_member" : "member_not_owner";
}
```

**Verdict → response, per procedure** (the table an implementer follows; `owner_inactive_member` is the decision-3 carve-out that keeps a revoked owner's node from being permanently stranded by the global `node_id` unique index):

| Verdict | `detach` | `heartbeat` | `capabilityupdate` | `attach` / `roster` |
| --- | --- | --- | --- | --- |
| `owner_active_member` | proceed | proceed | proceed | proceed |
| `owner_inactive_member` | **proceed** (self-service release) | 403 | 403 | 403 |
| `member_not_owner` | 403 | 403 | 403 | n/a (membership-keyed) |
| `not_visible` | `null` no-op | 403 | 403 | 403 |

- [ ] **Step 6c: Extend `buildHarness` with the real helpers the suite needs.** Design §3.1 verified that NONE of `callerAs` / `rawAttachmentRow` / `rawPresenceRow` / `invoke` exist in `runtime-node-router.test.ts` today, that `harness.caller` is a **pre-built property** (`harness.caller.runtimenode.attach(...)`, NOT `harness.caller({ requestId })`), and that the router closed over a **fixed** `resolveCurrentParticipantId: () => PARTICIPANT_ID`. So `callerAs` must rebuild the router over the SAME services with a different identity stub. Preserve the existing `{ pg, querier, router, caller }` keys; add the services + helpers. Also add `const STRANGER_PARTICIPANT_ID` (a third participant, seeded but never made a member) beside the existing `PARTICIPANT_ID` / `OTHER_PARTICIPANT_ID` constants. **Note:** a file-scope `seedMembership(querier, { sessionId, participantId, role, state })` ALREADY exists in `attach-service.test.ts` — this harness helper matches that field-name shape; `host-runtime-node.test.ts` has its own helper too, but **positional** (`seedMembership(querier, sessionId, participantId)`, `'collaborator'`/`'active'` hardcoded — Step 12 item 8 uses it as-is; do not copy that shape here) (the querier is closed over; `role`/`state` default), it does not invent a new one.

```ts
async function buildHarness() {
  const pg = new PGlite();
  const querier = adaptPGlite(pg);
  await applyMigrations(querier);
  const attachService = new AttachService(querier);
  const heartbeatService = new HeartbeatService(querier);
  const makeCaller = (
    asParticipantId: ParticipantId,
    ctx: { requestId: string } = { requestId: "test-rn-1" },
  ) =>
    t.createCallerFactory(
      createRuntimeNodeRouter({
        attachService,
        heartbeatService,
        resolveCurrentParticipantId: () => asParticipantId,
      }),
    )(ctx);
  const router = createRuntimeNodeRouter({
    attachService,
    heartbeatService,
    resolveCurrentParticipantId: () => PARTICIPANT_ID,
  });
  return {
    pg,
    querier,
    router,
    attachService,
    heartbeatService,
    caller: t.createCallerFactory(router)({ requestId: "test-rn-1" }), // ctx-current = PARTICIPANT_ID (unchanged surface)
    callerAs: (participantId: ParticipantId, ctx?: { requestId: string }) =>
      makeCaller(participantId, ctx),
    rawAttachmentRow: async (nodeId: string) =>
      (await querier.query("SELECT * FROM runtime_node_attachments WHERE node_id = $1", [nodeId]))
        .rows[0],
    rawPresenceRow: async (nodeId: string) =>
      (await querier.query("SELECT * FROM runtime_node_presence WHERE node_id = $1", [nodeId]))
        .rows[0],
    seedMembership: async (args: {
      sessionId: SessionId;
      participantId: ParticipantId;
      role?: string;
      state?: string;
    }) => {
      await querier.query(
        `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
         VALUES ($1, $2, $3, $4, now()) ON CONFLICT (session_id, participant_id) DO NOTHING`,
        [args.sessionId, args.participantId, args.role ?? "viewer", args.state ?? "active"],
      );
    },
  };
}
```

- [ ] **Step 7: Write the failing SERVICE-LEVEL IDOR tests** (the bulk — Design §3.1: the guard lives in the service methods, which now take `callerParticipantId` first, so tests call the service directly with a stranger id; no router, no `aisError`). **In `attach-service.test.ts` / `heartbeat-service.test.ts`, each using its OWN file idiom — `ctx = { pg, querier, service }` (fresh PGlite per test via `beforeEach`) + that file's file-scope helpers. Do NOT use the router suite's `buildHarness`/`harness.*` here — that harness exists only in `runtime-node-router.test.ts` (Step 6c).** Add a file-local `STRANGER_PARTICIPANT_ID` constant beside each file's existing ids. In `attach-service.test.ts` (helpers verified: `seedParticipant(querier, participantId)`, `seedSession(querier, sessionId, minClientVersion?)`, `seedMembership(querier, { sessionId, participantId, role, state })`, `buildAttachRequest(overrides?)`, `readAttachmentRow(querier, nodeId, sessionId)`):

```ts
it("refuses a same-session non-owner detach at the service layer, row byte-unchanged", async () => {
  await seedParticipant(ctx.querier, PARTICIPANT_ID);
  await seedParticipant(ctx.querier, OTHER_PARTICIPANT_ID);
  await seedSession(ctx.querier, SESSION_ID);
  await seedMembership(ctx.querier, {
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_ID,
    role: "viewer",
    state: "active",
  });
  await seedMembership(ctx.querier, {
    sessionId: SESSION_ID,
    participantId: OTHER_PARTICIPANT_ID,
    role: "viewer",
    state: "active",
  });
  await ctx.service.attach(PARTICIPANT_ID, buildAttachRequest()); // owner attaches
  const before = await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID);
  await expect(
    ctx.service.detach(OTHER_PARTICIPANT_ID, { nodeId: NODE_ID }), // member, not owner
  ).rejects.toBeInstanceOf(RuntimeNodePermissionDeniedException);
  expect(await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID)).toEqual(before);
});

// Attach axis-a (NEW guard): a non-member attach writes no row and refuses uniformly.
it("refuses a non-member attach with the uniform 403 and writes no attachment row", async () => {
  await seedParticipant(ctx.querier, STRANGER_PARTICIPANT_ID);
  await seedSession(ctx.querier, SESSION_ID); // session exists; caller holds NO membership
  await expect(
    ctx.service.attach(
      STRANGER_PARTICIPANT_ID,
      buildAttachRequest({ participantId: STRANGER_PARTICIPANT_ID }),
    ),
  ).rejects.toBeInstanceOf(RuntimeNodePermissionDeniedException);
  expect(await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID)).toBeUndefined();
});

// Attach axis-a: a nonexistent session yields the SAME uniform 403 (superseding the raw
// FK-500). SESSION_ID is deliberately never seeded — beforeEach gives each test a
// fresh PGlite, so the default buildAttachRequest() targets a nonexistent session.
it("refuses an attach to a nonexistent session with the same uniform 403, no FK-500", async () => {
  await seedParticipant(ctx.querier, PARTICIPANT_ID);
  await expect(ctx.service.attach(PARTICIPANT_ID, buildAttachRequest())).rejects.toBeInstanceOf(
    RuntimeNodePermissionDeniedException,
  );
});
```

In `heartbeat-service.test.ts` (helpers verified 2026-07-10: `seedAttachment(querier, { sessionId, participantId, nodeId, state })` and `readPresence(querier, nodeId)`; duplicate `attach-service.test.ts`'s `seedParticipant`/`seedSession`/`seedMembership` file-scope helpers into this file for the owner-path/member-path tests — per-file duplicated helpers are the standing test idiom).

> **`seedAttachment` is FK-backed — seed its parents first.** `runtime_node_attachments.session_id` and `.participant_id` are `NOT NULL REFERENCES sessions(id)` / `participants(id)` (migration `0003-runtime-nodes.ts`). The suite's own helper comment reads _"Seed a runtime_node_attachments row (FK-backed)"_, and its one existing call site seeds both parents inline first. **Any `seedAttachment` call without a prior `seedParticipant` + `seedSession` fails with an FK violation before the assertion is reached.** Every new test below that seeds an attachment therefore seeds `participants` → `sessions` → (`session_memberships` where the caller must be active) → `runtime_node_attachments`, in that order. The two negative tests that assert on a **never-attached** node seed nothing — that is the point of them:

```ts
// Presence-forgery close (service layer): today ingest upserts for ANY node_id.
it("refuses a heartbeat on a never-attached node and writes no presence row", async () => {
  await expect(
    ctx.service.ingest(STRANGER_PARTICIPANT_ID, { nodeId: NODE_ID, healthState: "online" }),
  ).rejects.toBeInstanceOf(RuntimeNodePermissionDeniedException);
  expect(await readPresence(ctx.querier, NODE_ID)).toBeUndefined();
});

// Oracle: a stranger heartbeating a REAL attachment gets the identical refusal, no row.
it("refuses a stranger's heartbeat on an existing attachment identically to never-attached", async () => {
  // seedAttachment is FK-backed (note above) — parents FIRST, or the INSERT
  // throws before the assertion is reached. The STRANGER seeds nothing: the
  // absent membership row is exactly what makes the verdict `not_visible`.
  await seedParticipant(ctx.querier, PARTICIPANT_ID);
  await seedSession(ctx.querier, SESSION_ID);
  await seedAttachment(ctx.querier, {
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_ID,
    nodeId: NODE_ID,
    state: "online",
  });
  await expect(
    ctx.service.ingest(STRANGER_PARTICIPANT_ID, { nodeId: NODE_ID, healthState: "online" }),
  ).rejects.toBeInstanceOf(RuntimeNodePermissionDeniedException);
  expect(await readPresence(ctx.querier, NODE_ID)).toBeUndefined();
});
```

**Locking regression tests (Design §4.A decision 1 §Locking discipline; I-003-6).** PGlite is single-connection, so a true concurrent interleave is not directly expressible. **Do not invent a raw-source string scan** — this repo already has the right technique and a canonical home for it: `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts` wraps the test `Querier` in a **logging proxy** that captures every SQL statement, recursively re-wrapping the in-transaction `tx` and tagging it with a tx-scoped `querierId`, so assertions can pin both the **ordering** of lock statements and the fact that they ran through the in-tx `Querier` (gripping the held client rather than a side-checked-out connection). It already pins I-002-4 for `InviteService.acceptInvite` and `MembershipService.updateMembership` this way.

Extend that file with a runtime-node block asserting, per procedure, inside a single transaction:

1. `attach` — the `sessions … FOR KEY SHARE` floor read is the FIRST lock statement, the `session_memberships … FOR SHARE` follows it, and both precede any `runtime_node_attachments` statement (the full three-level canonical order); no `sessions … FOR UPDATE` is ever taken.
2. `detach` / `heartbeat.ingest` / `updateCapabilities` — the attachment **pre-read carries no lock clause**, the `session_memberships … FOR SHARE` follows it, and the level-3 attachment lock follows that in the procedure's D8 mode — `FOR NO KEY UPDATE` for `detach` / `updateCapabilities`, `FOR SHARE` for `heartbeat.ingest` (order: unlocked pre-read < membership `FOR SHARE` < the level-3 lock; assert the **mode** too — a membership `FOR KEY SHARE` is the silent no-op guard). An attachment lock appearing before the membership `FOR SHARE` is the deadlock-inducing inversion and must fail the test.
3. `detach`'s mutation carries `participant_id` in its `WHERE` (assert on the captured statement, not the source file).
4. **Negative control** (per standing practice — prove the checker can fail): temporarily hoist the attachment lock above the membership `FOR SHARE` in a scratch edit and confirm the ordering assertion fails before landing the real implementation. Do not commit the scratch edit.

`readRoster` asserts: exactly **one** statement, carrying **no lock clause and no transaction wrapper** — the membership predicate and the enumeration are one `READ COMMITTED` snapshot (ADR-025 D7). Semantic two-connection interleave tests remain the Tier-5 integration-suite follow-up (named, not silently skipped).

Add the rest of the §Uniform-negative table at the service layer: same-session non-owner → `RuntimeNodePermissionDeniedException` for `updateCapabilities` (row + presence byte-unchanged); cross-session (non-member) `detach` returns the shipped idempotent `null` (byte-identical to detaching a never-attached node — the oracle), row byte-unchanged, while a same-session non-owner `detach` refuses with `RuntimeNodePermissionDeniedException` (the ratified decision-3 arm), row byte-unchanged; `readRoster` by a non-member of an existing session throws `RuntimeNodePermissionDeniedException`, identical to `readRoster` on an unknown `sessionId`; a member of a **visible-but-empty** session gets `{ nodes: [] }`; `updateCapabilities` by the owner on a `registering` node without a capability declaration → the surviving `RuntimeNodeCapabilityUpdateConflictException`; attach cross-owner reconnect + attach cross-session second-active → `RuntimeNodeAttachConflictException` (axis-b regression, shipped); the known-id squat pin (ADR-025 §Uniform-Negative Scope accepted residual): with owner A's attachment detached, active member B of another session attaches A's remembered `nodeId` there and **succeeds** with the row attributing B, and A's reattach under that id refuses `RuntimeNodeAttachConflictException` — asserted as the deliberately accepted shape. Every owner happy-path stays green.

- [ ] **Step 7b: Write the ROUTER-LEVEL IDOR tests** in `runtime-node-router.test.ts` — the in-process `createCaller` path surfaces a thrown `TRPCError` with `.code` + `.cause instanceof <Exception>`, and does **NOT** populate `data.aisError` (Design §3.1). Assert the tRPC-code mapping and, for the oracle, that hidden vs absent are indistinguishable in `.code` + `.cause`:

```ts
it("maps a same-session non-owner detach to tRPC FORBIDDEN with the typed cause", async () => {
  const harness = await buildHarness();
  await seedParticipant(harness.querier, PARTICIPANT_ID);
  await seedParticipant(harness.querier, OTHER_PARTICIPANT_ID);
  await seedSession(harness.querier, SESSION_ID);
  await harness.seedMembership({ sessionId: SESSION_ID, participantId: PARTICIPANT_ID });
  await harness.seedMembership({ sessionId: SESSION_ID, participantId: OTHER_PARTICIPANT_ID });
  await harness.caller.runtimenode.attach(buildAttachRequest()); // owner (ctx-current PARTICIPANT_ID)
  const caught = await harness
    .callerAs(OTHER_PARTICIPANT_ID)
    .runtimenode.detach({ nodeId: NODE_ID })
    .catch((e) => e);
  expect(caught).toBeInstanceOf(TRPCError);
  expect(caught.code).toBe("FORBIDDEN");
  expect(caught.cause).toBeInstanceOf(RuntimeNodePermissionDeniedException);
});

// Router-level oracle: cross-session heartbeat is tRPC-indistinguishable from a nonexistent node.
it("maps cross-session and nonexistent-node heartbeats to the identical FORBIDDEN / typed cause", async () => {
  const harness = await buildHarness();
  await seedParticipant(harness.querier, PARTICIPANT_ID);
  await seedSession(harness.querier, SESSION_ID);
  await harness.seedMembership({ sessionId: SESSION_ID, participantId: PARTICIPANT_ID });
  await harness.caller.runtimenode.attach(buildAttachRequest());
  const stranger = harness.callerAs(STRANGER_PARTICIPANT_ID); // member of no session
  const hidden = await stranger.runtimenode
    .heartbeat({ nodeId: NODE_ID, healthState: "online" })
    .catch((e) => e);
  const absent = await stranger.runtimenode
    .heartbeat({ nodeId: "never-attached-node", healthState: "online" })
    .catch((e) => e);
  expect(hidden.code).toBe("FORBIDDEN");
  expect(absent.code).toBe("FORBIDDEN");
  expect(hidden.cause).toBeInstanceOf(RuntimeNodePermissionDeniedException);
  expect(absent.cause).toBeInstanceOf(RuntimeNodePermissionDeniedException);
});
```

The `capabilityupdate` router-oracle case is identical modulo its input (construct per the shipped `RuntimeNodeCapabilityUpdateRequestSchema`); do not invent its shape — read it from the router factory's `.input(...)`.

- [ ] **Step 7c: Write the HTTP-LAYER envelope oracle** in `host-runtime-node.test.ts` — the ONLY surface where `aisError` materializes (the `errorFormatter` runs over the fetch handler; the suite already asserts `body.error.data.aisError.code` + `body.error.data.httpStatus` on its existing cases). **Add a `postRuntimeNode(procedure, input, asParticipantId)` helper — none exists today** — mirroring the suite's existing scaffolding: it constructs `buildControlPlaneFetchHandler` with the injected services and a `resolveCurrentParticipantId` stub returning `asParticipantId`, POSTs the single tRPC call, and returns the parsed response. For a cross-session `heartbeat` and `capabilityupdate`, assert the wire envelope is byte-identical to the nonexistent-node request:

```ts
// (postRuntimeNode = the NEW helper added above, POSTing one tRPC call through
//  buildControlPlaneFetchHandler with the caller stub set to its third argument)
const hidden = await postRuntimeNode(
  "heartbeat",
  { nodeId: NODE_ID, healthState: "online" },
  STRANGER_PARTICIPANT_ID,
);
const absent = await postRuntimeNode(
  "heartbeat",
  { nodeId: "never-attached-node", healthState: "online" },
  STRANGER_PARTICIPANT_ID,
);
expect(hidden.body.error.data.aisError.code).toBe("runtimenode.permission_denied");
expect(hidden.body.error.data.httpStatus).toBe(403);
expect(hidden.body.error.data.aisError.code).toBe(absent.body.error.data.aisError.code);
expect(hidden.body.error.data.httpStatus).toBe(absent.body.error.data.httpStatus);
// The `message` is NOT asserted equal: it echoes the caller's own chosen nodeId, which
// reveals no server-side fact — the leak-relevant fields (code + httpStatus) are identical.
```

(The suite's existing idiom is a module-level `buildControlPlaneFetchHandler(...)` + per-procedure request construction — the new helper wraps that idiom so caller identity varies per call; `host-runtime-node.test.ts` also already carries its own file-scope `seedMembership` for the seeding these cases need — **positional**, `seedMembership(querier, sessionId, participantId)` with `'collaborator'`/`'active'` hardcoded, NOT the object-arg shape `attach-service.test.ts` uses; see Step 12 item 8.)

- [ ] **Step 8:** Run `pnpm --filter @ai-sidekicks/control-plane test` → FAIL. Confirm the failures are the _expected_ ones — the service-level tests demonstrate the live IDORs before the fix (the negative control for this task): today the non-owner detach **succeeds**, the stranger's heartbeat **creates a presence row**, and a **non-member attach writes an attachment row** (the write-IDOR the axis-a guard closes). A zero-findings run here would mean the tests don't actually exercise the vulnerable paths — they must go red first.

- [ ] **Step 9: Thread the caller identity through the router.** In `runtime-node-router.factory.ts`, each mutating procedure resolves the caller once and passes it to the service; add the FORBIDDEN catch-arm (Reading 1 mints no `NOT_FOUND` mapping). Example for `detach`:

```ts
detach: runtimeNodeProcedure
  .input(RuntimeNodeDetachRequestSchema)
  .output(RuntimeNodeDetachResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const callerParticipantId = deps.resolveCurrentParticipantId(ctx);
    try {
      return await deps.attachService.detach(callerParticipantId, input);
    } catch (err) {
      if (err instanceof RuntimeNodePermissionDeniedException) {
        throw new TRPCError({ code: "FORBIDDEN", message: err.message, cause: err });
      }
      throw err;
    }
  }),
```

Apply the same shape to `heartbeat`, `capabilityupdate` (its surviving CONFLICT arm rides beside the FORBIDDEN arm), and `roster` (`.query`, FORBIDDEN on no-visible-session). **`attach` needs no extra arm for axis a** — the membership guard raises the same `RuntimeNodePermissionDeniedException` → FORBIDDEN. It is now threaded `callerParticipantId` and retains its self-check, **canonicalized in this step and re-thrown through `RuntimeNodePermissionDeniedException` → FORBIDDEN** (ADR-025 D5/D9 — the shipped plain `UNAUTHORIZED` is superseded: a bare 401 carries no `aisError` on the public transport, a refusal shape distinct from the uniform 403). The shipped check also compares raw `!==`; the branded schema admits mixed-case UUIDs while `resolveCurrentParticipantId` returns the canonical form, so once the service pre-guard canonicalizes, the raw router check would falsely refuse the true owner's mixed-case attach **before** the service could admit it — the same false-rejection class as the decision-3 owner check. Router-level pins: mismatched participant → FORBIDDEN with the typed cause (superseding the shipped UNAUTHORIZED pin — a deliberate, recorded contract change, not drift), same-participant case-varied `input.participantId` → **succeeds** (the canonicalization regression). It keeps its axis-b `attach_conflict` (409) path. So `attach`'s catch-arm carries FORBIDDEN (self-check + axis-a, one typed refusal) + CONFLICT (axis-b, shipped).

The exception extends `AisWireException`, so the shared `errorFormatter` projects `shape.data.aisError` with **no formatter change** — the router's only job is the tRPC status mapping (`FORBIDDEN`).

- [ ] **Step 10: Classify inside each service transaction, in canonical lock order.** All three `nodeId`-keyed mutators use the **two-phase resolve** (Design §4.A decision 1). `detach` is the reference implementation; `heartbeat.ingest` and `updateCapabilities` follow the identical shape:

```ts
async detach(callerParticipantId: ParticipantId, request: RuntimeNodeDetachRequest): Promise<null> {
  const validated = RuntimeNodeDetachRequestSchema.parse(request);
  return this.#querier.transaction(async (transaction) => {
    // PHASE 1 — UNLOCKED pre-read, purely to learn the session this node is in.
    // It MUST NOT lock: the canonical order (I-003-6) is
    //   sessions -> session_memberships -> runtime_node_attachments,
    // and `attach` locks membership before inserting an attachment. Locking the
    // attachment here would invert that order and deadlock against a concurrent
    // attach on the same node_id.
    const preRead = await transaction.query<{ participant_id: string; session_id: string }>(
      `SELECT participant_id, session_id FROM runtime_node_attachments
        WHERE node_id = $1 AND state IN ('registering','online','degraded')`,
      [validated.nodeId],
    );
    const snapshot = preRead.rows[0];
    if (snapshot === undefined) {
      return null; // shipped idempotent no-op — unchanged
    }

    // PHASE 2 — level-2 lock: classify under `SELECT … FOR SHARE` on the caller's
    // membership row (inside classifyRuntimeNodeCaller).
    const verdict = await classifyRuntimeNodeCaller(transaction, callerParticipantId, snapshot);
    if (verdict === "member_not_owner") {
      throw new RuntimeNodePermissionDeniedException(
        `Caller does not own runtime node ${String(validated.nodeId)}.`,
      );
    }
    if (verdict === "not_visible") {
      // ADR-025 uniform negative: byte-identical to the no-active-row branch above,
      // so detach never reveals that this node exists in a session the caller
      // cannot see. The row is NOT touched.
      return null;
    }
    // `owner_active_member` AND `owner_inactive_member` both proceed here — detach is
    // a self-service RELEASE of the caller's own node. Denying a revoked owner would
    // strand the node forever: `idx_node_attachments_active` is globally unique on
    // node_id, and I-003-3 forbids MembershipUpdate from detaching as a side effect.

    // PHASE 3 — level-3 lock + RE-VERIFY. Re-resolve the row FOR NO KEY UPDATE (D8's
    // mutator mode — `state` sits only in a partial unique index) and confirm
    // it is still the row the verdict was computed from. A concurrent detach +
    // re-attach can have swapped in a different participant's attachment between
    // phase 1 and here; applying the stale verdict would retire someone else's row.
    const locked = await transaction.query<{ participant_id: string; session_id: string }>(
      `SELECT participant_id, session_id FROM runtime_node_attachments
        WHERE node_id = $1 AND state IN ('registering','online','degraded')
        FOR NO KEY UPDATE`,
      [validated.nodeId],
    );
    const lockedRow = locked.rows[0];
    if (
      lockedRow === undefined ||
      lockedRow.participant_id !== snapshot.participant_id ||
      lockedRow.session_id !== snapshot.session_id
    ) {
      return null; // uniform negative — never the stale verdict
    }

    // ...existing UPDATE ... SET state='offline' + presence retire — with the
    // ownership predicate joined to the WHERE clause (defence in depth beside the
    // lock, and what Design §4.A decision 1 specifies):
    //   UPDATE runtime_node_attachments SET state='offline'
    //    WHERE node_id = $1 AND participant_id = $2 AND state IN (...)
  });
}
```

**Locking discipline (Design §4.A decision 1 — read it before writing any of this step).** Three rules, all load-bearing:

1. **Canonical order (I-003-6, new):** `sessions` → `session_memberships` → `runtime_node_attachments` — counting **implicit FK locks**: an INSERT takes `FOR KEY SHARE` on each FK-parent row, so `attach`'s upsert acquires a `sessions` lock whether or not the code says so. That is why `attach` takes its level-1 `sessions … FOR KEY SHARE` explicitly and FIRST (the floor read doubles as the acquisition): membership-then-upsert would be a level-2 → level-1 acquisition — the ABBA inverse of `MembershipService.updateMembership`'s shipped `sessions FOR UPDATE → session_memberships` order (I-002-4), and `FOR UPDATE` conflicts with `FOR KEY SHARE` (Table 13.3), so an attach racing a suspend/revoke in the same session could deadlock. `detach` / `heartbeat.ingest` / `updateCapabilities` may still skip level 1 — skipping is safe only because nothing in them acquires a `sessions` lock implicitly either (their UPDATEs never touch FK key columns; the presence upsert's FK parent is the attachment row the transaction already holds). **Inverting the order deadlocks** — any procedure that locks the attachment first and then reads membership closes the same cycle one level down.
2. **`FOR KEY SHARE` on `sessions` (attach only), `FOR SHARE` on membership, and per-procedure on the attachment — `FOR NO KEY UPDATE` for the mutator paths (`detach` / `updateCapabilities`), `FOR SHARE` for `heartbeat.ingest`, whose mutation targets `runtime_node_presence` (ADR-025 D8) — the modes are per-level, never interchangeable.** Sessions: KEY SHARE is the weakest mode the upsert's FK check needs; it conflicts with `updateMembership`'s `FOR UPDATE` (the level-1 ordering handshake) but NOT with the `FOR NO KEY UPDATE` a plain sessions-field update takes, so floor edits never serialize behind attaches. Membership: the row is read, not written, so an exclusive lock would needlessly serialize one participant's concurrent node calls; `FOR SHARE` still blocks a concurrent revoke, because a plain `UPDATE session_memberships SET state = …` takes `FOR NO KEY UPDATE`, which conflicts with `FOR SHARE` (PostgreSQL Table 13.3). **Never `FOR KEY SHARE` on the membership row** — it does _not_ conflict with `FOR NO KEY UPDATE` and would be a silent no-op against the exact revoke race it exists to block.
3. **Re-verify after the level-3 lock.** The phase-1 pre-read is unlocked by construction, so the verdict is only valid for the row it saw. Phase 3 re-reads under the procedure's level-3 mode and compares `(participant_id, session_id)`; a mismatch takes the uniform negative.

`readRoster` sits outside the lock order entirely — one `READ COMMITTED` statement folds the membership predicate into the enumeration (ADR-025 D7), so there is nothing to lock and no second statement for a revoke to interleave before; the 404-model design needed a locked two-statement transaction here, and its absence now is a consequence of the ratified Reading 1, not an omission. **Do not "simplify" the nodeId-keyed mutators' phase-1 attachment pre-read into a locked read** — that is exactly the order inversion rule 1 forbids.

`attach` — gains `callerParticipantId` as its first param, opens the existing `this.#querier.transaction` with the **level-1 `sessions … FOR KEY SHARE` floor read** (rule 1's implicit-FK deadlock note — this statement subsumes the shipped unlocked floor read AND delivers the nonexistent-session typed 403), and runs the **axis-a membership guard** second. The change supersedes the floor-read comment that currently says session authorization "is the router's gate (T3.8), not this service's" — correct that comment to record that the service now enforces membership:

```ts
async attach(callerParticipantId: ParticipantId, request: RuntimeNodeAttachRequest): Promise<RuntimeNodeAttachResponse> {
  const validated = RuntimeNodeAttachRequestSchema.parse(request);
  // ADR-025 axis-a PRE-GUARD (trusted-layer identity binding, ASVS 8.3.1): the
  // server-resolved `callerParticipantId` is authoritative; `validated.participantId`
  // is body-controlled. They MUST be the same participant, else an active member could
  // satisfy the membership check with their OWN id while writing an attachment owned by
  // someone else (the router self-check does NOT cover direct service callers — this
  // method is exported and the service-level tests call it directly). Canonicalize
  // before comparing (finding 7 — resolver may return mixed-case, DB emits lowercase).
  if (canonicalizeUuid(callerParticipantId) !== canonicalizeUuid(validated.participantId)) {
    throw new RuntimeNodePermissionDeniedException(
      `Runtime-node attach caller may not act on behalf of another participant.`,
    );
  }
  return this.#querier.transaction(async (transaction) => {
    // I-003-6 LEVEL-1 ACQUISITION — deadlock-load-bearing, not decorative. The upsert
    // below INSERTs a row whose session_id FK makes PostgreSQL take an IMPLICIT
    // `FOR KEY SHARE` on the parent `sessions` row. Without this explicit first lock,
    // attach would acquire level 2 (membership FOR SHARE) and THEN level 1 — the ABBA
    // inverse of MembershipService.updateMembership's shipped order (`sessions FOR
    // UPDATE` first, then the membership write; I-002-4), and FOR UPDATE conflicts
    // with FOR KEY SHARE (PostgreSQL Table 13.3) — so an attach racing a suspend or
    // revoke in the same session could deadlock. KEY SHARE is the deliberate mode:
    // the weakest the FK check needs, it handshakes with updateMembership's FOR
    // UPDATE, yet does NOT conflict with the FOR NO KEY UPDATE a plain sessions-field
    // update takes — floor edits never serialize behind attaches. This statement
    // doubles as the shipped floor read (step 1) AND the nonexistent-session typed 403
    // (superseding the raw FK-500 the old floor-read comment deferred to).
    const sessionRow = await transaction.query<{ min_client_version: string | null }>(
      `SELECT min_client_version FROM sessions WHERE id = $1 FOR KEY SHARE`,
      [validated.sessionId],
    );
    if (sessionRow.rows[0] === undefined) {
      throw new RuntimeNodePermissionDeniedException(
        `No visible session for the requested runtime-node attach.`,
      );
    }
    // ADR-025 axis-a: the caller (now proven == validated.participantId by the
    // pre-guard above) must be an ACTIVE member of the target session before any
    // attachment row is created. A non-member yields the uniform 403 with the
    // BYTE-IDENTICAL message of the session-absent branch above — non-member and
    // nonexistent-session must be indistinguishable, or the pair becomes a
    // session-existence oracle.
    //
    // `FOR SHARE` is REQUIRED, not decorative. This is the one classify-then-mutate
    // window whose artifact is DURABLE: an unlocked read lets a concurrent revoke
    // commit between the check and the upsert, so a stale authorization creates a
    // real attachment row that outlives the transaction. FOR SHARE conflicts with the
    // FOR NO KEY UPDATE that `UPDATE session_memberships SET state=...` takes, so the
    // revoke serializes behind us (PostgreSQL Table 13.3). FOR KEY SHARE would NOT
    // conflict here and would be a silent no-op — KEY SHARE is right for the sessions
    // row above and wrong for this one; the lock modes are per-level, never
    // interchangeable. It is a SHARED lock, so two of this participant's concurrent
    // attaches do not serialize against each other.
    //
    // Lock order so far: sessions KEY SHARE (level 1) < membership FOR SHARE (level
    // 2) < the upsert's attachment write (level 3) — the full I-003-6 order; it is
    // why the nodeId-keyed mutators must pre-read their attachment row UNLOCKED.
    // I-003-3 still holds: a FOR SHARE row lock reads, it does not modify
    // session_memberships.
    const membership = await transaction.query<{ one: number }>(
      `SELECT 1 AS one FROM session_memberships
        WHERE session_id = $1 AND participant_id = $2 AND state = 'active'
        FOR SHARE`,
      [validated.sessionId, callerParticipantId],
    );
    if (membership.rows[0] === undefined) {
      throw new RuntimeNodePermissionDeniedException(
        `No visible session for the requested runtime-node attach.`,
      );
    }
    // ...readOnly derivation (step 2, consuming sessionRow's min_client_version) +
    //    upsert (step 3, axis-b conflict/revoked classification) — unchanged; the
    //    old separate unlocked floor read (step 1) is SUBSUMED by the KEY SHARE
    //    statement above...
  });
}
```

`capabilityupdate` — apply the same three-phase shape as `detach`. Phase 1: an **unlocked** pre-read of `participant_id, session_id` for the active `node_id` (new statement — it must precede the membership lock, so it cannot be the shipped `FOR UPDATE` SELECT). Phase 2: `classifyRuntimeNodeCaller`; every non-permitted verdict (`member_not_owner`, `not_visible`, `owner_inactive_member`) and the no-active-row branch → `RuntimeNodePermissionDeniedException` with **one byte-identical message** (that branch changes from `RuntimeNodeCapabilityUpdateConflictException` to the uniform 403; the 409 survives only for the `registering→online` guard below it). Phase 3: the **existing** `SELECT … FOR UPDATE` (`AttachService.updateCapabilities`; it selects `id, state, client_version, session_id` today) — **add `participant_id` to its column list** (absent today), **narrow `FOR UPDATE` to `FOR NO KEY UPDATE`** (ADR-025 D8 — `state` sits only in a partial unique index, outside the escalation set), and re-verify `(participant_id, session_id)` against the phase-1 snapshot before any mutation; it now sits **below** the membership lock, per I-003-6.

`heartbeat.ingest` — wrap the body in `this.#querier.transaction` and apply the same three phases. Phase 1: unlocked pre-read (`SELECT participant_id, session_id FROM runtime_node_attachments WHERE node_id = $1 AND state IN ('registering','online','degraded')`); no row → `RuntimeNodePermissionDeniedException`. Phase 2: classify — every non-permitted verdict → the identical `RuntimeNodePermissionDeniedException` (an inactive-membership owner may not drive a node; only `detach` is carved out). Phase 3: re-resolve **`FOR SHARE`** — heartbeat's attachment access is read-only authorization, its mutation targeting `runtime_node_presence`, so `FOR SHARE` is D8's weakest-sufficient mode: it still conflicts with a concurrent detach's `FOR NO KEY UPDATE` while concurrent heartbeat retries proceed unserialized — re-verify against the snapshot, then run the existing presence upsert. **Both locks are required** (see §Locking discipline above): without the level-3 lock + re-verify, a concurrent detach + re-attach by a different participant can land between the classify and the upsert, letting a stale verdict authorize a presence write against an attachment the caller no longer owns — re-opening the presence-forgery hole this change closes. Without the level-2 `FOR SHARE`, a concurrent revoke does the same.

`readRoster` — gains `callerParticipantId` first and becomes **one `READ COMMITTED` statement, no lock, no transaction** (ADR-025 D7): the enumeration is driven from the caller's own membership row (`FROM session_memberships m LEFT JOIN runtime_node_attachments … LEFT JOIN sessions … LEFT JOIN runtime_node_presence … WHERE m.session_id = $1 AND m.participant_id = $2 AND m.state = 'active'`), so the membership predicate and the projection share one snapshot and no revoke can interleave between them — the atomicity the 404-model design bought with a locked two-statement transaction falls out of the statement boundary for free. Zero rows → `RuntimeNodePermissionDeniedException` (identical for an unknown session and a session the caller isn't in); rows with a `NULL` attachment id → a **visible-but-empty** session → `{ nodes: [] }`, superseding the shipped `{nodes: []}`-for-unknown-session posture. `readRoster` classifies by membership only — there is no per-row owner question for an enumeration — and the `readOnly` derivation keeps reading `sessions.min_client_version` in the same statement. Comment the statement to record the I-003-3 read-vs-mutate distinction: roster now **references** `session_memberships` for authorization but never **mutates** it (the byte-unchanged property the I-003-3 test asserts still holds; Step 12.5).

- [ ] **Step 11:** Run `pnpm --filter @ai-sidekicks/control-plane test` → PASS (all IDOR + uniformity cases green; every owner happy-path still green). Then full `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 12: Migrate the existing suites to the new signatures + superseded postures.** This is the widest blast radius in the task; enumerate each in the PR body as a ratified Spec-003 contract change (PR-A1), not regression masking. The five service methods gained a `callerParticipantId` first parameter, so **every existing call site updates** — these are build-breaking (TS + runtime), not optional:
  1. **Signature migration (mechanical, all call sites).** `attach-service.test.ts` uses its own `ctx = { pg, querier, service: new AttachService(querier) }` (the file-scope `beforeEach` ctx factory); ~15 `ctx.service.attach(req)` calls → `ctx.service.attach(PARTICIPANT_ID, req)`, and the `updateCapabilities` / `detach` / `readRoster` call sites likewise. `heartbeat-service.test.ts` `ctx.service.ingest(req)` → `ctx.service.ingest(PARTICIPANT_ID, req)`. **Seed the owner's membership** so the happy-paths clear axis-a: add `seedMembership(ctx.querier, { sessionId: SESSION_ID, participantId: PARTICIPANT_ID, role: "viewer", state: "active" })` per-test where the session is seeded (the file-scope helper — attach-service.test.ts already has it; heartbeat-service.test.ts gains its duplicate in Step 7). `buildAttachRequest`'s participant defaults to `PARTICIPANT_ID`, so the owner is the ctx caller.
  2. **Attach happy-paths now require membership** (attach-service.test.ts: the P9 reconnect pair, the cross-owner refusals, the response-shape tests, etc.). Each already `seedSession`s — add the matching `seedMembership(ctx.querier, { sessionId: SESSION_ID, participantId: PARTICIPANT_ID, role: "viewer", state: "active" })`. The cross-owner-reconnect tests attach as `OTHER_PARTICIPANT_ID` — seed **that** participant's membership too, so the refusal is the axis-b `attach_conflict` (the intended assertion), not an axis-a not-found.
  3. **Heartbeat ingest presence-forgery close** — every successful `ctx.service.ingest` call site in the file, not only the ingest describe block. Four call sites migrate: the ingest suite's "creates a presence row … on first heartbeat (P6)" and "updates the SAME row …", **plus the two staleness/hysteresis recovery tests** — "restores a sweep-demoted degraded node to online …" and "resurrects a sweep-declared offline node to online …" — which today seed only `runtime_node_presence` before ingesting and would fail with `RuntimeNodePermissionDeniedException` instead of exercising liveness recovery. Each must first `seedParticipant` + `seedSession` + `seedMembership` + `seedAttachment` (active) for `NODE_ID` owned by `PARTICIPANT_ID`, then `ingest(PARTICIPANT_ID, …)`. (The invalid-`healthState` parse test needs no seeding — Zod rejects before the resolve.) Add a NEW negative test: `ingest(STRANGER_PARTICIPANT_ID, …)` on a never-attached node → `RuntimeNodePermissionDeniedException`, no presence row (moved from Step 7 if colocated).
  4. **capabilityupdate no-active-row 409 → 403** (attach-service.test.ts): the three no-active-row assertions flip `RuntimeNodeCapabilityUpdateConflictException` → `RuntimeNodePermissionDeniedException` — "no active attachment", "never attached", "revoked … active-band excludes revoked". The **state-guard** test "refuses driving a registering attachment online (I-003-2 guard)" and the version-floor refusals `describe` block **stay 409** — do not flip them.
  5. **Roster posture split** (attach-service.test.ts roster describe, T5.0c). The combined test "returns an empty roster for a session with no attachments AND for a non-existent session" splits: a **member** of an empty session still gets `{ nodes: [] }`; a **non-member or non-existent** session now → `RuntimeNodePermissionDeniedException` (403). The "isolates sessions" test seeds the caller's membership in the session it reads. The I-003-3 "writes NOTHING — … session_memberships byte-for-byte unchanged across a roster read" test **stays green** — `readRoster` now SELECTs `session_memberships` for authorization but never mutates it (a read is not a write); keep the assertion, and correct any code/comment claiming roster "never references" `session_memberships` to "never **mutates**" (the I-003-3 read-vs-mutate distinction the Spec-003 amendment records).
  6. **Client-SDK cross-package ripple** (`packages/client-sdk/test/runtimeNodeClient.integration.test.ts`, `OTHER_SESSION` roster-isolation leg): seed the caller's membership so the roster returns rather than refusing with the uniform 403; sweep `runtimeNodeClient.ts` comments for any cross-session-roster-visibility claim (now membership-scoped). Runs on `test-node22` → a miss reddens `ci-gate`.
  7. **Router-suite migration** (`runtime-nodes/__tests__/runtime-node-router.test.ts`) — **four** shipped tests assert postures this task supersedes; skipping this file lands control-plane red. (a) `"runtimenode.heartbeat mounts and resolves to null (void -> null wire mapping)"` — its comment says _"No seeding needed: the first heartbeat upserts the presence row"_; heartbeat now 404s on a never-attached node, so it must seed participant → session → membership → active attachment for the stub caller. (b) `"runtimenode.capabilityupdate maps the no-active-attachment refusal to CONFLICT"` — that arm is now `FORBIDDEN`; re-point the test at the surviving `registering→online` state guard so the CONFLICT-mapping property it proves survives, and add a sibling asserting the no-active-row arm now maps to `FORBIDDEN`. (c) the attach test whose comment reasons _"an unseeded one would FK-throw INTERNAL_SERVER_ERROR"_ — that premise is superseded by the typed 403; reword and assert the 403. (d) **Membership seeding is required by every test that must reach a post-guard branch, refusal paths included — the file has zero `session_memberships` references today.** The axis-a guard and the classify run **before** axis-b, the version floor, and the state guard, so without an active membership for the stub caller these tests now die at the uniform 403 instead of exercising their intended branch: the attach **cross-session conflict** test ("maps the cross-session conflict … to CONFLICT") and the attach **revoked-row refusal** test — seed the caller's membership in the session they attach into; the **capabilityupdate version-floor** test and the re-pointed `registering→online` state-guard 409 — seed the owner's membership; and every attach happy-path. Only the axis-a negatives themselves (non-member / nonexistent-session → the uniform 403) stay membership-free by design. Note the harness's `caller` is a **single pre-built** caller over a fixed `resolveCurrentParticipantId` stub — the `callerAs(participantId)` helper from Step 6c is what varies identity here.
  8. **HTTP-suite migration** (`server/__tests__/host-runtime-node.test.ts`) — `"projects runtimenode.capabilityupdate_conflict as {code, message} (no details) — the T3.8-deferred sibling now projects via the base"` seeds nothing and expects `409` + `RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE`; under the 409→403 split that request now yields the uniform 403. **Do not delete the test** — it is the sibling-projection oracle for the whole `AisWireException` family. Re-point it at the surviving `registering→online` 409 arm (seed an active `registering` attachment owned by the stub caller), and add a **new** HTTP-layer test asserting the no-active-row arm projects `403` + `RUNTIME_NODE_PERMISSION_DENIED_CODE` with `data.httpStatus === 403`. **The same membership-seeding rule as item 7(d) applies here:** the version-floor projection test, the attach cross-session-conflict projection, the attach revoked-refusal projection, and the re-pointed state-guard 409 each seed the caller's active membership first, or they now project the uniform 403 instead of the branch they exist to prove. Use the file's **existing** `seedMembership` helper — note its signature is **positional**, `seedMembership(querier, sessionId, participantId)` with `'collaborator'`/`'active'` hardcoded (unlike `attach-service.test.ts`'s object-arg form). This file is also where the byte-identical uniform-negative envelope oracle lives (Step 7).

- [ ] **Step 13: Move BL-141 to the archive.** Remove the BL-141 entry from `docs/backlog.md`; append to `docs/archive/backlog-archive.md` under `## Completed: <merge date>` with a closure note: exit (a)–(d) met via ADR-025 + Spec-003 rows + Plan-003 T3.10–T3.12 + enforced code; production-live automatically at Plan-008 R1 (the identity substrate). **State the two refinements explicitly** (ADR-025 §Adjudication Record + D4/D7): (i) the unauthorized roster read returns the uniform `runtimenode.permission_denied` (403) as an enumeration-scoped negative, not a per-row 403 — there is no per-row authorization on that surface (D7's honesty note) — and the same code answers an unknown session, so no session-existence oracle opens; (ii) a `detach` naming a node with no attachment visible to the caller answers the shipped idempotent `null` no-op rather than a typed error — the per-procedure uniform negative, a typed error there being itself the oracle — while a fellow member's cross-owner `detach` refuses with the same 403 as the other mutators (the decision-3 rule). Both are deliberate readings of exit (c)/(d)'s "typed authorization error" letter, ratified in ADR-025, not silent narrowings. Cites PR-A1/PR-A1p/PR-A2.

- [ ] **Step 14:** SPP-3/4/5/6. Test Plan in the body enumerates, by name: the IDOR cases across the three layers (service / router / HTTP-envelope oracle); the uniform-negative oracle assertions (detach's invisible-arm `null` beside its cross-owner 403; heartbeat / capabilityupdate / roster / attach the uniform 403 — per procedure); and the Step-12 superseded-posture updates (the signature migration, the attach-happy-path membership seeding, the heartbeat ingest presence-forgery rewrite, the three capabilityupdate 409→403 flips, the roster split, the client-SDK leg) — flag each as the ratified Spec-003 contract change, not regression masking. Subject `feat(control-plane): enforce runtime-node caller-ownership (plan-003)`; trailer `Refs: Plan-003, ADR-025, BL-141`. Title carries the `Plan-003` token (lane 1).

---

### Task 5: PR-B1 — Unit B docs (BL-133)

> **Executed 2026-08-11 — merged vehicle (PR #322 / §6 node NS-57).** Tasks 5 and 6 were executed together in one PR — the Plan/Spec-002 restoring targeted readiness-audit delta — instead of the planned two-PR B1 → B1p sequence: the 2026-08-03 V1 product-vision reconciliation (PR #284) had already flipped Spec-002 / Plan-002 `review` before this task dispatched, so the flip steps below were moot, and the delta authored the §4.B amendments, audited them jointly with the reconciliation growth and the channel-directory ingest carrier (BL-149, outside this task's charter but the same vehicle), and restored `approved` in the same swap — Spec-021 flip-and-restored beside them. Per-step deviations are noted inline; everything else executed as written.

**Design contract:** §4.B (decisions 1–10), §3.2 ground truth.

**Files:**

- Modify: `docs/specs/002-invite-membership-and-presence.md` (Status → `review`; §Interfaces And Contracts `invite.preview` contract + two-tier error pin + the `create` inviter-binding note (`inviter` is server-bound to the authenticated caller, never trusted from the body — Design §4.B decision 10) + a note that the five invite refusals now project onto the `aisError` envelope with their error-contracts §Invite HTTP statuses; dated Amendment block).
- Modify: `docs/architecture/contracts/api-payload-contracts.md` (add `InvitePreviewRequest`/`InvitePreviewResponse` beside the Tier-2 invite trio; method-name registry note — flag the doc's `Invite*Request/Response` names vs code's `InviteCreate/InviteAccept/InviteRevoke` skew, don't silently reconcile).
- Modify: `docs/specs/021-rate-limiting-policy.md` (Status → `review`; add the `invite.preview` registry row).
- Modify: `docs/specs/023-desktop-shell-and-renderer.md` (§Deep-Link Invite Flow — one-line resolution pointer to Spec-002's new contract; stays `approved` — clarifying cross-ref).
- Modify: `docs/architecture/cross-plan-dependencies.md` (disambiguation lines: the invite **control-plane tRPC router** is Plan-002-owned and ships now; the **daemon-side invite leg** — IPC handlers + live control-plane caller — is Plan-008's Tier-5 join/relay handoff).
- Modify: `docs/plans/008-control-plane-relay-and-session-join.md` (I-008-4 gated-endpoint list gains `invite.create`/`invite.accept`/`invite.revoke` + `invite.preview`'s recorded anonymous exclusion; the Tier-5 scope bullet names the daemon invite IPC leg; Plan-008 `approved` since 2026-07-21 (W2.5 re-audit #239) — re-adjudicate under the Status Flip Rule, amendment declared in the PR body).
- Modify: `docs/architecture/contracts/error-contracts.md` (§Error Response Shape mechanism note: the `AIS_WIRE_HTTP_STATUS_OVERRIDES` delivery path for non-native HTTP statuses + the named future registrants).
- Modify: `docs/plans/002-invite-membership-and-presence.md` (Status → `review`; new Phase-2 tasks T2.6/T2.7/T2.8; new **CP-002-9** §Cross-Plan Obligations entry; re-open audit checkbox scoped to the new tasks; §Progress Log note).
- Modify: `README.md` (census: Plan-002 + Spec-002 + Spec-021 → `review`; re-derive counts).

**Interfaces:** Produces the `invite.preview` contract + response shape + error posture + the invite-router ownership disambiguation that PR-B2's code and reviews are conducted against.

- [x] **Step 1:** SPP-1 name=`b1-invite-docs`, branch=`docs/bl-133-invite-preview`. _(2026-08-11: executed on the merged vehicle's branch `docs/membership-002-readiness-delta` instead.)_
- [x] **Step 2:** Author the Spec-002 §Interfaces `invite.preview` contract: request `{ token }`; response `{ joinMode, expiresAt, sessionName: string | null, inviterDisplayName: string | null }` (raw UUIDs excluded; null fields documented Plan-018-fed / session-name-fed) — _deviation (2026-08-11, PR #322 Codex round 1): the landed response additionally carries `sessionId`; the Spec-023 confirmation step needs a target-session identity and V1 has no session-name producer, so an identifier-free response was unrenderable — the inviter id stays excluded_; explicitly non-consuming (idempotent — the single-use token survives); row-first-then-expiry error order matching accept (Design §4.B decision 1); two-tier errors reusing the §Invite vocabulary (uniform `invite.not_found` for garbage/unknown; distinct expired/revoked/already*accepted for MAC-valid). Add the `create` inviter-binding note: `InviteCreate.inviter` is authorization-checked against the resolved authenticated caller and never trusted from the body — the router passes `resolveCurrentParticipantId(ctx)` as the actor argument (Design §4.B decision 10). Add the note that the five invite refusals now project onto `aisError` (the migration to `AisWireException`) with their §Invite HTTP statuses, expired/revoked at 410 via the override map (Design §4.B decision 8). Dated Amendment block; flip Status `review`. *(2026-08-11: the flip was moot — Spec-002 already `review` since PR #284; the delta authored the amendment and restored `approved` in the same swap.)\_
- [x] **Step 3:** Add the api-payload-contracts `InvitePreviewRequest`/`InvitePreviewResponse` interfaces beside the existing invite trio (Design §4.B decision 3 shapes); note the `invite.preview` method under the already-reserved `invite` namespace root, **recorded POST-only (tRPC mutation kind, deliberately — non-consuming read whose input is the raw token; a query would ride GET `?input=` per the client convention and leak tokens into logs/history; Design §4.B decision 3)**. Add the error-contracts §Error Response Shape **mechanism note** (Design §4.B decision 8, fourth bullet): registry codes whose pinned HTTP status has no native tRPC code are delivered via `AIS_WIRE_HTTP_STATUS_OVERRIDES` (`@ai-sidekicks/contracts` `error.ts`) — the `errorFormatter` stamps `data.httpStatus`, and the transport lifts `response.status` from that stamp **natively** (tRPC's `getHTTPStatusCode` reads each response's `error.data.httpStatus`; a uniform batch gets that status, a mixed batch gets 207 — no `responseMeta` is registered), unmapped codes ride their carrier code's native status; name the future registrants (`artifact.relay_expired` with Plan-014 Tasks 7–10; `approval.request_expired` only if it gains a control-plane tRPC surface — its V1 surface is daemon JSON-RPC where §JSON-RPC Wire Mapping governs).
- [x] **Step 4:** Add the Spec-021 registry row (Design §4.B decision 5 values); flip Status `review`. Re-derive the registry row count. _(2026-08-11: executed as a flip-and-restore in the same swap — registry 24 → 25, with one flagged widening beyond decision 5's literal: `invite.redeem_ip` stacks on the preview path too, keeping preview at-least-as-strict-as-accept on both axes, recorded in Spec-021 as the one deliberate exception to the most-specific-row rule.)_
- [x] **Step 5:** Add the Spec-023 §Deep-Link resolution pointer (declare in the PR body: clarifying cross-ref, Spec-023 stays `approved` per the runbook default rule). Add the cross-plan-dependencies disambiguation line (declare: runbook:218 re-audit trigger does not fire — clarification, not an ownership change). Add the **Plan-008 edits** (Design §4.B decisions 6/9): the I-008-4 gated-endpoint list gains `invite.create`/`invite.accept`/`invite.revoke` (the §4.A decision-9 mirror — the three authenticated procedures PR-B2 makes reachable through the merged host), with `invite.preview` recorded in the invariant text as **deliberately excluded** (anonymous by design per §4.B decision 1; token entropy + the Spec-021 anonymous per-token-hash row carry its protection); widen the Tier-5 scope bullet ("Invite-acceptance handoff") to name the daemon-side invite IPC leg + live control-plane caller (decision 6 surface (c)). Declare in the PR body: invariant-list completion + scope naming, Plan-008 `approved` since 2026-07-21 (W2.5 re-audit #239) so the amendment carries its own Status Flip Rule adjudication — presumptively a flip (the invite triple extends I-008-4's covered-endpoint set; flip → targeted re-audit → re-promotion, the PR's user pause final); plus the observation for Plan-008's next readiness re-audit that the Tier-1 session-directory procedures' Tier-5 gating disposition rides I-008-1's allow-list-widening obligation (pre-existing, not adjudicated by this campaign). _(2026-08-11: this step's "Plan-008 `approved` since 2026-07-21" premise was stale — Plan-008 flipped `review` 2026-08-03 with the reconciliation bundle, so the Status Flip Rule adjudication resolved differently than written: the I-008-4 + Tier-5-scope edits land as growth on the already-open flip, audited by Plan-008's own queued restoring delta (its audit box's owed scope widened to name them), with no flip performed by this vehicle — the superseded-instruction disposition recorded in Plan-002's audit box.)_
- [x] **Step 6:** Add Plan-002 Phase-2 tasks (acceptance criteria tracing to the Spec-002 rows), matching PR-B2's task decomposition (Design §4.B doc deliverables): **T2.6** (relocate `INVITE_*_CODE` to `contracts/src/error.ts` + the `AIS_WIRE_HTTP_STATUS_OVERRIDES` map + the `InvitePreview{Request,Response}` schemas + `previewInvite`), **T2.7** (migrate the five invite exceptions to `AisWireException` + `invite-router.factory.ts` + host merge + the `errorFormatter` 410 stamp — transport status lifts natively from `data.httpStatus`, no `responseMeta`), **T2.8** (test suite incl. the HTTP-layer envelope oracle + the mixed-batch 207 control). Append **CP-002-9** to §Cross-Plan Obligations (the established CP-002-1..8 pattern): the daemon-side invite leg — the `invite.*` IPC handlers under `packages/runtime-daemon/src/ipc/handlers/`, the live control-plane caller they delegate to, and `membershipClient.preview` — is consumed from Plan-008-remainder Tier 5 (join/relay handoff); Plan-002's T2.6–T2.8 own the control-plane tRPC transport only; the renderer's `NotImplementedAtTier1Error` posture stands until that leg lands; cross-ref the cross-plan-dependencies disambiguation lines. The daemon IPC handlers + live control-plane caller are **not** Plan-002 tasks here — they are Plan-008 Tier-5. Flip Status `review`; re-open the audit checkbox scoped to the new tasks; fold audit-delta evidence into a §Progress Log note. _(2026-08-11: the flip/re-open halves were moot — both already open since PR #284; the delta re-checked the audit box with the three-growth-body scope enumeration and the restore record instead.)_
- [x] **Step 7:** README census (Plan-002 + Spec-002 + Spec-021 → `review`; counts re-derived). Merge-serialize vs PR-A1 (rebase census lines if PR-A1 landed first). _(2026-08-11: executed as the restore-side census — plans 21 `approved` / 5 `review`, specs 25 `approved` / 3 `review` — since flip and restore landed in one vehicle; no PR-A1 serialization arose.)_
- [x] **Step 8:** SPP-3 docs gates + `/ripple-check`. SPP-4 with `plan-execution-spec-reviewer`. SPP-5/6 — subject `docs(repo): spec-002 non-consuming invite.preview + wire contract`, body declares the three `review` flips + the two clarifying-only edits + the Plan-008 amendment (already `review`) + the error-contracts mechanism note + census ripple; trailer `Refs: Spec-002, Spec-021, Spec-023, Plan-002, Plan-008, BL-133`. _(2026-08-11: shipped under the merged vehicle's subject `docs(repo): restore Spec/Plan-002 approved via membership targeted delta`, its body carrying this task's declarations.)_

---

### Task 6: PR-B1p — Spec-002 + Spec-021 + Plan-002 re-promotion

> **Executed 2026-08-11 — merged into Task 5's vehicle (PR #322 / §6 node NS-57).** The separate promotion PR dissolved: the restoring targeted readiness-audit delta is itself the delivery-and-promotion vehicle (the Plan-006 PR #282 flip-and-restore-in-one-swap shape), so every step below executed inside PR #322.

**Files:** Modify: `docs/specs/002-…` + `docs/specs/021-…` + `docs/plans/002-…` (`review` → `approved`; tick Plan-002's re-opened audit checkbox); `README.md` (census restore).

- [x] **Step 1:** SPP-1 name=`b1p-invite-promote`, branch=`docs/bl-133-promote`. _(2026-08-11: no separate branch — merged vehicle.)_
- [x] **Step 2:** Flip all three to `approved`; tick the audit checkbox. PR body cites runbook §Spec-Status Promotion Gate by name + PR-B1 delta evidence (T2.6–T2.8 trace to the amended Spec-002 rows; dep-closure terminal; no gating open questions). For the Plan-002 half, also satisfy the **plan-side** §Status Promotion Gate elements (runbook:210–214): cite the Tier-2 audit-completion date + the `plan-readiness-audit-tier-2-complete` tag.
- [x] **Step 3:** Restore README census.
- [x] **Step 4:** SPP-3/4/5/6 — subject `docs(repo): re-promote spec-002 + spec-021 + plan-002 (invite delta)` (68 chars — `commitlint` `header-max-length` is 72; do not re-expand to `invite.preview delta`), trailer `Refs: Spec-002, Spec-021, Plan-002, BL-133`. _(2026-08-11: shipped under the merged vehicle's subject and trailer.)_

---

### Task 7: PR-B2 — Unit B code + BL-133 archive (lane 1 under Plan-002)

**Design contract:** §4.B code deliverables; §3.2 seams.

**Files:**

- Modify: `packages/contracts/src/error.ts` (relocate the five `INVITE_*_CODE` from `invite-service.ts` as `export type InviteXxxCode` + `export const INVITE_XXX_CODE` pairs, beside the `RUNTIME_NODE_*_CODE` siblings; add `AIS_WIRE_HTTP_STATUS_OVERRIDES` — Design §4.B decision 8).
- Modify: `packages/contracts/src/invites.ts` (add `InvitePreviewRequestSchema`/`InvitePreviewResponseSchema` + inferred types).
- Verify-only: `packages/contracts/src/index.ts` — the barrel is `export * from "./error.js"` / `"./invites.js"`, so the relocated codes, the override map, and the two schemas re-export automatically; **no edit expected** (confirm the star-exports still cover them, consistent with Task 4 needing no `index.ts` edit).
- Modify: `packages/contracts/src/__tests__/error.test.ts` (invite-code literals + `startsWith("invite.")` block; `AIS_WIRE_HTTP_STATUS_OVERRIDES` completeness — every key is a real code, every value matches error-contracts §Invite).
- Modify: `packages/control-plane/src/invites/invite-service.ts` (migrate the five exceptions `extends Error` → `extends AisWireException`, importing the codes from contracts; add `previewInvite`).
- Modify: `packages/control-plane/src/sessions/trpc.ts` (`errorFormatter`: set `data.httpStatus` from `AIS_WIRE_HTTP_STATUS_OVERRIDES` when the `AisWireException`'s code is a key — map-guarded, no effect on non-key codes).
- Create: `packages/control-plane/src/invites/invite-router.factory.ts` (`t.router({invite: {create, accept, revoke, preview}})`; per-exception catch-arms per the Design §4.B decision-4 table).
- Modify: `packages/control-plane/src/server/host.ts` (merge the invite router; `ControlPlaneDeps` gains `InviteRouterDeps`; wire a placeholder invite service in the production default export — **no `responseMeta`**: the transport status lifts natively from the formatter's `data.httpStatus` stamp, Step 8).
- Modify: `packages/control-plane/src/server/__tests__/_helpers.ts` — **build-breaking ripple of the `ControlPlaneDeps` change**: both factories are typed `ControlPlaneDeps` (`makeRefusalAssertingDeps()` and `makePassThroughDeps(...)`), so the moment the type gains the invite service every existing server suite fails typecheck before the new router tests even run. The refusal-asserting factory wires a throws-if-called invite stub (the file's existing pattern for un-exercised deps); the pass-through factory wires the real `new InviteService(querier, keyRing)` — the one-random-key `KeyRing` fixture idiom already lives in `invite-service.test.ts` (`@ai-sidekicks/crypto-paseto`).
- Modify: `packages/control-plane/src/index.ts` — **export `InviteService`** beside the existing `AttachService`/`HeartbeatService` export lines (it is not exported today, and the client-sdk fixtures below must construct it across the package boundary); export the invite router factory too if the session router is exported similarly.
- Modify: the three client-sdk `ControlPlaneDeps` fixture files — **the same deps-growth typecheck ripple as `_helpers.ts`, but across the package boundary on `test-node22`** (a miss reddens `ci-gate`): `packages/client-sdk/test/sessionClient.integration.test.ts` (`buildSubscribeOnlyDeps` + `buildCrudOnlyDeps`), `packages/client-sdk/test/transport/sse-roundtrip.test.ts` (`makeIntegrationDeps`), and `packages/client-sdk/test/runtimeNodeClient.integration.test.ts` (its deps factory) each return a `ControlPlaneDeps` object literal, so the type's new invite field fails all three suites' typecheck. None of them exercises `invite.*`, so each wires the field in its file's documented "services throw on use" posture — `new InviteService(throwingQuerier, keyRing)` with a one-random-key `KeyRing` fixture (the `invite-service.test.ts` idiom, `@ai-sidekicks/crypto-paseto`) — importing `InviteService` from `@ai-sidekicks/control-plane` (the barrel export this task adds).
- Test: `packages/control-plane/src/invites/__tests__/invite-router.test.ts` (create → preview → accept round trip; router-level exception→tRPC-code mapping) + `invite-service.test.ts` (the `INVITE_*_CODE` import-path fix + preview cases).
- Create: `packages/control-plane/src/server/__tests__/host-invite.test.ts` (HTTP-layer envelope oracle: per refusal `response.status` + `data.httpStatus` + `data.aisError.code`; expired/revoked at **410 on both**).
- Modify: `docs/backlog.md` + `docs/archive/backlog-archive.md` (move BL-133).

**Deliberately NOT in this task (Design §4.B decisions 4/6 — Plan-008 Tier-5 relay leg):** the daemon IPC invite handlers (`packages/runtime-daemon/src/ipc/handlers/invite-*.ts`) and `membershipClient.preview`. No daemon invite handler exists today and the daemon has no live control-plane caller; building a handler now only relocates the renderer's `NotImplementedAtTier1Error` to a handler delegating to a deferred caller (no usable capability, plus renderer-test churn). They land with the live caller at Tier-5.

**Interfaces:**

- Consumes: `InviteService` (shipped), the file-scope `decryptV4Local` / `decodeClaims` / `isExpiredClaim` + the inline `createHash("sha256")…` idiom (shipped in `invite-service.ts`), the `AisWireException` base + `errorFormatter`, the runtime-node router + host-merge precedents.
- Produces: `previewInvite(request: InvitePreviewRequest): Promise<InvitePreviewResponse>` (anonymous — **no** caller param, unlike `acceptInvite(participantId, request)`); `createInviteRouter(deps): InviteRouter`; the five invite exceptions now `extends AisWireException`; the relocated `INVITE_*_CODE` + `AIS_WIRE_HTTP_STATUS_OVERRIDES` in `@ai-sidekicks/contracts`; the `InviteService` class export from the `@ai-sidekicks/control-plane` barrel (consumed by the client-sdk fixtures).

- [ ] **Step 1:** SPP-1 name=`b2-invite-code`, branch=`feat/plan-002-invite-preview`.

- [ ] **Step 2: Relocate the invite codes + add the override map (Design §4.B decision 8).** Write the failing `error.test.ts` block first (invite-code literals + `startsWith("invite.")` + `AIS_WIRE_HTTP_STATUS_OVERRIDES` completeness), run → FAIL, then add to `contracts/src/error.ts` the five `export type InviteXxxCode = "invite.xxx"` + `export const INVITE_XXX_CODE: InviteXxxCode = "invite.xxx"` pairs (explicit annotations, TS9010) beside the runtime-node siblings, plus:

```ts
// Domain codes whose error-contracts.md §Invite HTTP status is NOT expressible
// as a native tRPC error-code key (tRPC has no 410 Gone member). The control-
// plane errorFormatter stamps this onto the envelope (data.httpStatus); tRPC's
// transport then lifts response.status from that stamp natively (getHTTPStatusCode
// reads error.data.httpStatus per response; mixed batches get 207), so the
// envelope and the transport status cannot diverge and no responseMeta exists.
// Every entry MUST match error-contracts.md §Invite.
export const AIS_WIRE_HTTP_STATUS_OVERRIDES: Readonly<Record<string, number>> = {
  [INVITE_EXPIRED_CODE]: 410,
  [INVITE_REVOKED_CODE]: 410,
};
```

Barrel-export from `index.ts`. Run → PASS. Commit `feat(contracts): relocate invite wire codes + http-status override map`.

- [ ] **Step 3: Migrate the five invite exceptions to `AisWireException`** (Design §4.B decision 8 — today they `extends Error`, so the `errorFormatter` never projects their `aisError`). In `invite-service.ts`: remove the five local `INVITE_*_CODE` consts; `import { INVITE_NOT_FOUND_CODE, … } from "@ai-sidekicks/contracts"` and `import { AisWireException } from "../ais-wire-exception.js"`; change each of the five classes `extends Error` → `extends AisWireException` (each already declares `readonly code = INVITE_*_CODE` and `constructor(message){ super(message); this.name = … }`, which satisfy the base's `abstract readonly code: string` unchanged). Update `invite-service.test.ts`'s `INVITE_*_CODE` import to `@ai-sidekicks/contracts`. Run `pnpm --filter @ai-sidekicks/control-plane test` → the existing `instanceof` / `.code` / `.message` assertions stay green (runtime behavior is byte-identical; `AisWireException extends Error`).

- [ ] **Step 4: Add the preview schemas.** Failing `invites.test.ts` first:

```ts
it("parses a preview response with null display fields", () => {
  const parsed = InvitePreviewResponseSchema.parse({
    joinMode: "viewer",
    expiresAt: "2026-07-10T00:00:00.000Z",
    sessionName: null,
    inviterDisplayName: null,
  });
  expect(parsed.joinMode).toBe("viewer");
});
```

→ FAIL. Add `InvitePreviewRequestSchema` (`{ token: z.string().min(1).max(INVITE_TOKEN_MAX_LEN) }`, `.strict()` — **reuse `INVITE_TOKEN_MAX_LEN` (4096), the exact cap `InviteAcceptSchema.token` already carries; do NOT accept an unbounded string**: `preview` is the anonymous public path and Tier-6 rate-limiting is deferred, so an unbounded token would let a caller force hashing/decrypting arbitrarily large input before any guard runs) / `InvitePreviewResponseSchema` (`joinMode` = the shared `JoinMode` schema from `presence.ts`; `expiresAt` = `z.string()`; `sessionName`/`inviterDisplayName` = `z.string().nullable()`; `.strict()`) + inferred types (explicit annotations). Import `INVITE_TOKEN_MAX_LEN` from the same module as `InviteAcceptSchema`. → PASS.

- [ ] **Step 5: Write the failing `previewInvite` tests** in `invite-service.test.ts`, using the REAL harness. **Verified fixture signatures (do not guess these):** `mintInviteToken(keyRing, { sessionId, inviterId, joinMode, expiresAt })` → `MintedInvite { token, tokenHash, jti }` — `expiresAt` is a **required argument** and `MintedInvite` carries **no** `expiresAt` field; `seedInvite(querier, { sessionId, inviterId, tokenHash, joinMode, state, expiresAt })` takes **`tokenHash`, not `token`**; `isoOffset(deltaMs)` builds the ISO expiry the existing call sites use. There is no `buildInviteService`; `acceptInvite`/`createInvite` take a caller-participant first, `previewInvite` does not.

```ts
it("previewInvite never consumes the token (accept still succeeds after N previews)", async () => {
  await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
  await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
  await seedSession(ctx.querier, SESSION_ID);
  const expiresAt: string = isoOffset(24 * 60 * 60 * 1000);
  const minted = mintInviteToken(ctx.keyRing, {
    sessionId: SESSION_ID,
    inviterId: OWNER_PARTICIPANT_ID,
    joinMode: DEFAULT_JOIN_MODE,
    expiresAt,
  });
  await seedInvite(ctx.querier, {
    sessionId: SESSION_ID,
    inviterId: OWNER_PARTICIPANT_ID,
    tokenHash: minted.tokenHash,
    joinMode: DEFAULT_JOIN_MODE,
    state: "pending",
    expiresAt,
  });
  for (let i = 0; i < 3; i++) {
    expect((await ctx.service.previewInvite({ token: minted.token })).joinMode).toBe(
      DEFAULT_JOIN_MODE,
    );
  }
  const accepted = await ctx.service.acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token }); // still spendable
  expect(accepted.state).toBe("active");
});

it("previewInvite collapses garbage and unknown-hash tokens to invite.not_found", async () => {
  // Tier 1 — not even MAC-valid: exits through the decrypt-failure arm.
  await expect(ctx.service.previewInvite({ token: "garbage" })).rejects.toBeInstanceOf(
    InviteNotFoundException,
  );
  // Tier 2 — MAC-valid but rowless: THE arm that pins row-first-before-expiry. The
  // claim below is ALREADY EXPIRED, so an implementation that checked claim expiry
  // before the row lookup would leak invite.expired for a token the DB has never
  // seen — the exact uniformity break decision 2 forbids. Mint with the ctx
  // KeyRing; seed NOTHING.
  const unknownRow = mintInviteToken(ctx.keyRing, {
    sessionId: SESSION_ID,
    inviterId: OWNER_PARTICIPANT_ID,
    joinMode: DEFAULT_JOIN_MODE,
    expiresAt: isoOffset(-60_000), // expired claim — must STILL answer not_found
  });
  await expect(ctx.service.previewInvite({ token: unknownRow.token })).rejects.toBeInstanceOf(
    InviteNotFoundException,
  );
});

// Posture parity with acceptInvite's persisted-`expired` reclassification rung.
// Seed state='expired' with a claim that has NOT yet expired, so the row rung —
// not the claim check — is what fires. Preview MUST answer invite.expired, never
// a healthy pending response (which would diverge from accept).
it("previewInvite reclassifies a persisted expired row to invite.expired", async () => {
  await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
  await seedSession(ctx.querier, SESSION_ID);
  const expiresAt: string = isoOffset(24 * 60 * 60 * 1000); // claim NOT yet expired
  const minted = mintInviteToken(ctx.keyRing, {
    sessionId: SESSION_ID,
    inviterId: OWNER_PARTICIPANT_ID,
    joinMode: DEFAULT_JOIN_MODE,
    expiresAt,
  });
  await seedInvite(ctx.querier, {
    sessionId: SESSION_ID,
    inviterId: OWNER_PARTICIPANT_ID,
    tokenHash: minted.tokenHash,
    joinMode: DEFAULT_JOIN_MODE,
    state: "expired",
    expiresAt,
  });
  await expect(ctx.service.previewInvite({ token: minted.token })).rejects.toBeInstanceOf(
    InviteExpiredException,
  );
});

it("previewInvite discloses revoked for a MAC-valid token", async () => {
  await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
  await seedSession(ctx.querier, SESSION_ID);
  const expiresAt: string = isoOffset(24 * 60 * 60 * 1000);
  const minted = mintInviteToken(ctx.keyRing, {
    sessionId: SESSION_ID,
    inviterId: OWNER_PARTICIPANT_ID,
    joinMode: DEFAULT_JOIN_MODE,
    expiresAt,
  });
  await seedInvite(ctx.querier, {
    sessionId: SESSION_ID,
    inviterId: OWNER_PARTICIPANT_ID,
    tokenHash: minted.tokenHash,
    joinMode: DEFAULT_JOIN_MODE,
    state: "revoked",
    expiresAt,
  });
  await expect(ctx.service.previewInvite({ token: minted.token })).rejects.toBeInstanceOf(
    InviteRevokedException,
  );
});
```

(The fixture field names above are the **verified** ones — `seedInvite` takes `tokenHash`, `mintInviteToken` requires `expiresAt`, and `DEFAULT_JOIN_MODE` is the suite's `JoinMode` constant, so the `joinMode` assertion tracks it rather than a hard-coded literal. Import `InviteExpiredException` alongside the other invite exceptions.) Run → FAIL (`previewInvite` missing).

- [ ] **Step 6: Implement `previewInvite`** mirroring `acceptInvite`'s EXACT order and symbols (Design §4.B decision 1 — row FIRST, expiry AFTER; NO consume-UPDATE, NO `FOR UPDATE` lock, NO transaction):

```ts
async previewInvite(request: InvitePreviewRequest): Promise<InvitePreviewResponse> {
  const validated: InvitePreviewRequest = InvitePreviewRequestSchema.parse(request);
  // (2) Decrypt under the ACTIVE key — same Tier-A collapse as acceptInvite.
  const activeKey: Uint8Array = this.#keyRing.active().key;
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = decryptV4Local(validated.token, activeKey);
  } catch (error: unknown) {
    if (error instanceof InvalidTokenError) {
      throw new InviteNotFoundException("InviteService.previewInvite: token did not decrypt to a valid invite envelope.");
    }
    throw error;
  }
  // (3) Recover claims; a foreign shape -> not-found.
  const claims: InviteTokenClaims | undefined = decodeClaims(payloadBytes);
  if (claims === undefined) {
    throw new InviteNotFoundException("InviteService.previewInvite: token payload did not match the invite claim shape.");
  }
  const tokenHash: string = createHash("sha256").update(validated.token).digest("hex");
  const now = new Date();
  // (4) Row FIRST — an unknown hash is not_found BEFORE expiry (mirrors acceptInvite;
  //     a pure read, so no session FOR UPDATE lock and no transaction).
  const probe = await this.#querier.query<{ join_mode: string; state: string }>(
    `SELECT join_mode, state FROM session_invites WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = probe.rows[0];
  if (row === undefined) {
    throw new InviteNotFoundException("InviteService.previewInvite: no invite matches the presented token.");
  }
  // (5) Expiry AFTER the row, claim-authoritative — matches acceptInvite.
  if (isExpiredClaim(claims.expires_at, now)) {
    throw new InviteExpiredException(`InviteService.previewInvite: invite expired at ${claims.expires_at} (Spec-002 §Token Security Properties).`);
  }
  // (6) State ladder in acceptInvite's order: revoked -> expired -> accepted.
  if (row.state === "revoked") throw new InviteRevokedException("InviteService.previewInvite: invite has been revoked (Spec-002 §Invite Revocation).");
  // A PERSISTED `expired` row reclassifies to expiry, never already-accepted — the
  // exact rung acceptInvite keeps "so the reclassification stays complete". Latent
  // today (the claim check above fires first) but NOT unreachable: a DB-side expiry
  // sweep running ahead of the app clock would otherwise make preview answer
  // healthy-pending for an invite accept refuses as expired — a posture divergence.
  if (row.state === "expired") throw new InviteExpiredException("InviteService.previewInvite: invite is in a persisted expired state (Spec-002 §Token Security Properties).");
  if (row.state === "accepted") throw new InviteAlreadyAcceptedException("InviteService.previewInvite: invite has already been accepted (Spec-002 §Token Security Properties).");
  // pending + non-expired: bounded metadata; display fields null until Plan-018 (display_name) / a session-name owner.
  return InvitePreviewResponseSchema.parse({
    joinMode: row.join_mode,
    expiresAt: claims.expires_at,
    sessionName: null,
    inviterDisplayName: null,
  });
}
```

Do NOT extract shared helpers unless `acceptInvite` already exposes them — the file-scope `decryptV4Local` / `decodeClaims` / `isExpiredClaim` are already shared; the inline decrypt+decode block is short and mirroring it verbatim keeps the two paths provably identical. Run → preview cases PASS.

- [ ] **Step 7: Create `invite-router.factory.ts`** mirroring `runtime-node-router.factory.ts`'s already-namespaced `t.router({ invite: { create, accept, revoke, preview } })` shape (hand-written router type for `--isolatedDeclarations`). Each procedure catch-arm maps its service exceptions to a tRPC code per the Design §4.B decision-4 table: `InviteNotFoundException`→`NOT_FOUND`, `InviteAlreadyAcceptedException`→`CONFLICT`, `InviteExpiredException`/`InviteRevokedException`→`CONFLICT` (carrier; the 410 override lifts the status), `InvitePermissionDeniedException`→`FORBIDDEN` — each `throw new TRPCError({ code, message: err.message, cause: err })` so the shared `errorFormatter` projects `aisError`.

  **Authenticated caller binding (wire the resolved caller in; do NOT re-implement the service's checks).** `createInvite` / `acceptInvite` / `revokeInvite` each take an authenticated participant as their **first argument** (`actorParticipantId` / `acceptingParticipantId` / `actorParticipantId`), and the service does **not** derive it from the body. The router's sole obligation is to resolve `deps.resolveCurrentParticipantId(ctx)` and pass it as that argument — **never `input.inviter` or any body field** — exactly as the runtime-node router does (`RuntimeNodeRouterDeps` already carries the resolver; `InviteRouterDeps` gains the same). **The service already closes the spoof — verify before adding anything:** `createInvite` authorizes the actor as an active session **owner** (the `createInvite` owner-probe — its active-owner membership SELECT) **and** binds the body `inviter` to the actor — `validated.inviter.toLowerCase() !== actorParticipantId.toLowerCase()` → `InvitePermissionDeniedException` (the `createInvite` inviter-bind guard, case-normalized on both sides because the `ParticipantId` brand admits either case). So the router MUST **not** add its own equality check — that would duplicate the shipped guard. The load-bearing risk is purely the **wiring**: `InviteCreate.inviter` is a caller-controlled body field stored verbatim as `inviter_id`, so an implementer who wired `createInvite(input.inviter, input)` (deriving the actor FROM the body) would run the owner-check and the bind against the **attacker-chosen** inviter — minting a token attributed to any active owner. Passing the resolved caller is the whole fix. Router-level **mismatch test**: authenticated caller A sending `input.inviter = B` (B ≠ A) → the service's existing bind throws → 403, no invite row written (this proves the router passes the resolved caller, not the body). `preview` stays anonymous — it takes no caller argument (Design §4.B decision 10).

  **`preview` is registered as a `.mutation()`, deliberately — the POST-only pin that keeps raw tokens out of URLs (Design §4.B decision 3).** Its wire input is the raw invite token, and this repo's client convention sends tRPC **queries as GET `?input=…`** (`runtimeNodeClient.ts` documents exactly this split: the four mutations POST a JSON body; `roster`, the one query, is a GET with `?input=`). A `.query()` preview would therefore place every previewed token into server/proxy access logs and client history — burning the secret before Tier-8 token confinement can rely on it. Registering the procedure as a mutation is the **server-enforceable** POST pin: tRPC maps the HTTP method to the procedure kind, so a GET `invite.preview` request is refused outright rather than quietly served. Kind ≠ semantics — preview remains non-consuming (no UPDATE anywhere in `previewInvite`), and the Step 9 non-consumption invariant is the proof.

  **`revoke` additionally maps a non-exception sentinel.** `InviteService.revokeInvite` returns `Promise<InviteRevokeResponse | null>` — `null` for a missing, cross-session, or already-terminal invite — and its own doc comment assigns the translation to the wire layer ("the wire layer surfaces a typed not-found"). Catch-arms alone therefore do not cover it: the procedure would emit `result: null` (or fail output validation as an `INTERNAL_SERVER_ERROR`). Add an explicit result branch **before** returning: `if (result === null) throw new TRPCError({ code: "NOT_FOUND", message: …, cause: new InviteNotFoundException(…) })` — constructing the typed exception as `cause` so the `errorFormatter` projects the same `invite.not_found` `aisError` envelope as the exception path, byte-identical (the uniformity oracle in Step 9 asserts this).

- [ ] **Step 8: Wire the 410 override + merge the router (Design §4.B decision 8).** In `sessions/trpc.ts` `errorFormatter`, inside the existing `cause instanceof AisWireException` branch, add `data.httpStatus` from the override map when present:

```ts
const override = AIS_WIRE_HTTP_STATUS_OVERRIDES[cause.code];
const data =
  override !== undefined
    ? { ...shape.data, aisError, httpStatus: override }
    : { ...shape.data, aisError };
return { ...shape, data };
```

In `host.ts`: `t.mergeRouters(createSessionRouter(deps), createRuntimeNodeRouter(deps), createInviteRouter(deps))`; add `InviteRouterDeps` to `ControlPlaneDeps`; wire a placeholder invite service in the production default export (beside the attach/heartbeat placeholders). **Do NOT add a `responseMeta` — the formatter stamp is the whole transport mechanism.** tRPC's fetch adapter computes the HTTP status from the _formatted_ error shapes: `getHTTPStatusCode` reads each response's `error.data.httpStatus` (the field the Step-7 `errorFormatter` stamps with the override) and returns that status when every response in the batch shares it, **207 Multi-Status when a mixed batch disagrees** (source-verified in `@trpc/server` 11.17.0, `resolveResponse` → `getHTTPStatusCode`; <https://trpc.io/docs/rpc>). So a single revoked-token preview is HTTP 410 and the runtime-node oracle's 409 is untouched, with zero host code. A hand-rolled `responseMeta` override (e.g. return-on-first-matching-error) would _mask_ the 207 mixed-batch contract — forcing a whole batch to 410 because one call gated — which is exactly the divergence the single-registration design exists to prevent. Honest limit: under a streaming link (`httpBatchStreamLink`/SSE) headers flush before results, so the transport status is not per-call there — the in-body `data.httpStatus` + `data.aisError` envelope is the durable contract; the buffered links the host tests and client-sdk use get the lifted status.

- [ ] **Step 9: Write the router test + the HTTP-layer envelope oracle.** In `invite-router.test.ts` (mirror the runtime-node router harness): a create → preview → accept round trip over the in-process tRPC caller against PGlite; assert preview returns the bounded shape and does not consume; assert a revoked-token preview throws `TRPCError` with `.cause instanceof InviteRevokedException`; assert **revoke of a nonexistent `inviteId` throws `TRPCError` with `.code === "NOT_FOUND"` and `.cause instanceof InviteNotFoundException`** (the Step-7 null-sentinel branch — without it the procedure emits `result: null` or an output-validation 500). In `host-invite.test.ts` (mirror `host-runtime-node.test.ts`): drive `buildControlPlaneFetchHandler`; assert an expired-token and a revoked-token preview each return `response.status === 410`, `body.error.data.httpStatus === 410`, and `body.error.data.aisError.code` = `invite.expired` / `invite.revoked`; assert a not-found preview returns 404, and a nonexistent-invite revoke returns the **byte-identical** `invite.not_found` envelope (the null-sentinel path and the exception path must be indistinguishable on the wire); assert a **batched** request mixing a successful call with a revoked-token preview returns `response.status === 207` while each in-body envelope keeps its own `data.httpStatus` (410 on the revoked leg) — the negative control proving no transport-level override masks tRPC's mixed-batch contract (Step 8); assert the **preview kind pin**: a GET `invite.preview?input=…` request is refused (tRPC method↔kind mismatch — preview is a mutation precisely so tokens never ride a URL, Step 7), while the POST path serves it. Run → PASS.

- [ ] **Step 10:** Full `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 11: Move BL-133 to the archive.** Remove from `backlog.md`; append to the archive with the closure note: exit (a) **met** (the Spec-002 contract, exceeded — full invite router + hardened `aisError`/410 envelope, not just the preview contract); exit (b) **met-as-refined** — the endpoint ships on the **control-plane tRPC transport**; its daemon-as-gateway clause (ADR-008 surface, mirroring the `invite.accept` wire registration) is reassigned to **Plan-008 Tier-5** via Plan-002 **CP-002-9** (an obligation entry; the implementation task lands with Plan-008's Tier-5 leg). Name the **two** remaining hand-offs, each another plan's own step: the daemon-integration leg (IPC handlers + live control-plane caller) is **Plan-008 Tier-5**; exit (c) (Plan-023 Tier-8 deep-link consumption + two-client smoke) is **Plan-023 Tier-8**. Cites PR-B1/PR-B1p/PR-B2.

- [ ] **Step 12:** SPP-3/4/5/6. Test Plan enumerates the non-consumption invariant, two-tier uniformity (tampered vs unknown-hash → `invite.not_found`), per-lifecycle-state preview, the HTTP-layer 410 envelope oracle, the mixed-batch 207 control, the preview POST-only kind pin (GET refused), and the now-reachable create/accept/revoke wire path. Subject `feat(control-plane): invite.preview + invite wire transport (plan-002)` (70 chars — `commitlint` `header-max-length` is 72, so "non-consuming" lives in the body, not the subject); body declares the non-consumption invariant, the Plan-008 Tier-5 daemon-leg deferral + the cross-plan `trpc.ts`/`host.ts` edits (map-guarded, zero shipped-behavior change). Trailer `Refs: Plan-002, Spec-002, BL-133`. Title carries `Plan-002` (lane 1).

---

### Task 8: PR-C — Unit C tests + BL-131 rewrite + BL-134 note (lane 2)

**Design contract:** §4.C; §3.3 ground truth.

**Files:**

- Create: `apps/desktop/src/renderer/src/runtime-node-attach/__tests__/NodeRoster.test.tsx` / `AttachFlow.test.tsx` / `CapabilityDeclaration.test.tsx` / `MixedVersionStatus.test.tsx`.
- Modify: `docs/backlog.md` (rewrite BL-131 to the gated remainder; annotate BL-134 dormancy).
- Modify: `docs/plans/003-runtime-node-attach.md` (all **seven** BL-131 mentions — the four T5 Test-field notes + two §Verification restatements record the component-test half shipped; line 847's Shipment-Manifest note narrows "component/E2E" → "E2E"; note-level, no status flip).

**Interfaces:** Consumes `SidekicksBridge` (`@ai-sidekicks/contracts`), the `installMockBridge` cast pattern (`session-members/__tests__/participant-roster.test.tsx`), the four shipped components. Produces no exported symbols (test files only).

- [ ] **Step 1:** SPP-1 name=`c-renderer-tests`, branch=`test/runtime-node-renderer-components` (NON-plan-scoped — lane 2).
- [ ] **Step 2: Write `MixedVersionStatus.test.tsx` first** (pure presentational, no mock) — the `data-write-refusal="version.floor_exceeded"` arm is the highest-value assertion:

```tsx
import { render } from "@testing-library/react";
import { MixedVersionStatus } from "../MixedVersionStatus.js";

// Props verified against `MixedVersionStatus.tsx#MixedVersionStatusProps` —
// { rosterEntry: RuntimeNodeRosterEntry | null; writeAttemptRejection: unknown }.
// The refusal is recognized by the file's `isVersionFloorExceededRejection`
// predicate as `code === "version.floor_exceeded" && typeof message === "string"`
// — a code+message WIRE ENVELOPE, NOT a `{ kind }` shape.
it("renders the version.floor_exceeded write-refusal arm", () => {
  const { container } = render(
    <MixedVersionStatus
      rosterEntry={null}
      writeAttemptRejection={{ code: "version.floor_exceeded", message: "below session floor 1.2" }}
    />,
  );
  expect(container.querySelector('[data-write-refusal="version.floor_exceeded"]')).not.toBeNull();
});
```

- [ ] **Step 3:** `pnpm --filter @ai-sidekicks/desktop test:renderer` → PASS (component ships this arm today; the test pins it). Add the empty/populated `CapabilityDeclaration` cases (props-only). For the `NodeRoster`/`AttachFlow` cases that need a populated roster, build a real `RuntimeNodeRosterEntry` from `@ai-sidekicks/contracts` (do not invent the shape — import the type and fill its fields).
- [ ] **Step 4: `NodeRoster.test.tsx`** — duplicate the `installMockBridge` typed-mock (per the T6.3 standing directive; no shared helper) for `{controlPlane: {call}, daemon: {subscribe}}`; assert loading/loaded/error render states + `version.floor_exceeded` recognition labeling. Run → PASS.
- [ ] **Step 5: `AttachFlow.test.tsx`** — mock `{controlPlane: {call}}`; assert idle/pending/resolved/rejected + `readOnly` verbatim surfacing. Run → PASS.
- [ ] **Step 6: Add the bridge-only import-scan** (reuse the CP-002-5 `import.meta.glob(…, {query:"?raw"})` pattern from `participant-roster.test.tsx`) asserting no `node:*`/`electron`/`@ai-sidekicks/runtime-daemon`/`control-plane` imports in the four component sources. Run → PASS.
- [ ] **Step 7:** Full `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Step 8: Rewrite BL-131** in `backlog.md`: correct the Summary rationale (the harness shipped via Plan-001 T5.2 + Plan-002 T6.3, not Plan-023); mark exit (b) + (d) DONE this PR with a completion note; exit (a)-IPC-clause + (c) stay gated on Plan-023 Tier 8 (zero `ipcMain` handlers). Update Status to reflect the slim remainder. Annotate BL-134: rc.4 = latest + npm `latest`, 22 months since upstream push, Yarn ships `^4.0.0-rc.2` in production — recalibrate the "within one week of stable" trigger.
- [ ] **Step 9: Update all seven Plan-003 BL-131 mentions** (lines 225/588/596/604/612/616/847 — §3.3 of the Design enumerates them): the four T5 Test-field notes (~588/596/604/612) + the two §Verification restatements (~225/616) record the component-test half shipped; line ~847's Shipment-Manifest note narrows "automated renderer component/E2E coverage backfills per BL-131" → "…E2E coverage…" (the component half now ships). Cite this PR by `Refs:` footer convention, not an in-doc ephemeral ref; the E2E half stays BL-131-gated. Note-level edits — no behavior row changes, so no status flip (declare in the PR body). `grep -n "BL-131" docs/plans/003-runtime-node-attach.md` → confirm exactly seven, all handled.
- [ ] **Step 10:** SPP-3 (docs gates on the `.md` edits + code gates on the tests) / SPP-4 / SPP-5 / SPP-6. Subject `test(desktop): runtime-node renderer component tests (bl-131 split)`; body declares lane 2 (no plan token; `Refs: Plan-003, BL-131, BL-134` footer). Branch is NON-plan-scoped and the title carries NO `Plan-NNN` token (lane-boundary compliance).

---

### Task 9: PR-D — Unit D coverage substrate + BL-123 update (lane 3)

**Design contract:** §4.D; §3.4 ground truth.

**Files:**

- Modify: `pnpm-workspace.yaml` (catalog `vitest: ^4.1.5` → exact `4.1.10`; add `@vitest/coverage-v8: 4.1.10`).
- Modify: each vitest-workspace `package.json` (add `@vitest/coverage-v8: catalog:testing` devDep) + `vitest.config.ts` (add the `coverage` block; desktop scopes to the `renderer` project).
- Modify: `.github/workflows/ci.yml` (new advisory `coverage` job — non-required; `--coverage`; davelosert action SHA-pinned once per package, each invocation with its own `working-directory` + `name`; one `actions/upload-artifact` per package with a unique artifact name).
- Modify: `turbo.json` (a `test:coverage` task or `outputs` for `coverage/**`, per §3.4 — keep the required `test` task fast/cached; coverage runs fresh).
- Modify: `docs/backlog.md` (BL-123 → `in_progress`; protocol + pointers).
- Modify: `docs/decisions/023-v1-ci-cd-and-release-automation.md` (§Decision Log entry: advisory coverage job design — the durable home once BL-123 archives).
- Modify: `.claude/skills/plan-execution/references/failure-modes.md` (ride-along: "CLAUDE.md doc-first" → AGENTS.md §Doc-First Discipline).

**Interfaces:** Consumes the workspace catalog + per-package vitest configs. Produces per-package `coverage/` artifacts + a PR-comment surface.

- [ ] **Step 1:** SPP-1 name=`d-coverage`, branch=`chore/coverage-measurement-substrate` (NON-plan-scoped — lane 3).
- [ ] **Step 2:** Bump the `testing` catalog to exact `4.1.10` + add `@vitest/coverage-v8: 4.1.10`; `pnpm install`; confirm `pnpm-lock.yaml` resolves both at `4.1.10` (peer-pin satisfied).
- [ ] **Step 3:** Add the `coverage` block to each package `vitest.config.ts` (`provider: 'v8'`, `reporter: ['text','json','json-summary','lcov']`, `reportOnFailure: true`, no `enabled`, no thresholds); desktop config scopes coverage to the `renderer` project only (exclude the `main` Electron-spawning project). Add the coverage devDep to each package `package.json`.
- [ ] **Step 4:** Verify locally: `pnpm --filter @ai-sidekicks/contracts exec vitest run --coverage` emits `coverage/coverage-summary.json` + `lcov.info`; the required `pnpm test` (no `--coverage`) is unchanged (control-plane PGlite timeouts untouched). **Desktop is special**: its `test` script nests `turbo run test:renderer test:smoke`, and the `main`/smoke project spawns a real Electron binary (not in-process-instrumentable). Invoke desktop coverage as `pnpm --filter @ai-sidekicks/desktop exec vitest run --project=renderer --coverage` — the renderer project only; never `pnpm --filter @ai-sidekicks/desktop test --coverage` (that would drag in the un-instrumentable smoke project).
- [ ] **Step 5:** Add the advisory `coverage` job to `ci.yml` (NOT in the `ci-gate` `needs` list — non-required). **Mirror the required suite's Node split** (`test-node22` runs `--filter='!@ai-sidekicks/control-plane'`; `test-node24` runs `--filter='@ai-sidekicks/control-plane...'`): the coverage job runs control-plane on Node 24 and every other package on Node 22, so instrumentation never changes a package's Node tier. `--coverage` (desktop via `--project=renderer`); `davelosert/vitest-coverage-report-action@<SHA>` once per package, each invocation with a unique `name` **and a per-package `working-directory`** — vitest writes each report into the PACKAGE-LOCAL `coverage/` directory, while the action reads `${working-directory}/coverage/coverage-summary.json` with `working-directory` defaulting to `./`; without the per-package value (or explicit `json-summary-path`/`json-final-path` inputs) every step looks for a nonexistent root report or collides on the same file, and the advisory job publishes nothing the BL-123 baseline can use. Matching rule for the artifact bank: one `actions/upload-artifact` per package, unique artifact name, package-local `coverage/lcov.info` + `coverage/coverage-final.json` paths. Job-level `permissions: { contents: read, pull-requests: write }` — `contents: read` MUST be restated: a job-level `permissions:` map **replaces** the workflow-level one (unspecified scopes drop to `none`, and ci.yml's workflow default is `contents: read` alone), so omitting it breaks the job's own `actions/checkout` before coverage ever runs; `actions/upload-artifact` for `lcov.info` + `coverage-final.json`. Verify `ci-gate`'s `needs` still lists only `[test-node22, test-node24, hook-tests-macos]` (coverage stays out).
- [ ] **Step 6:** Fix the `failure-modes.md:171` pointer (ride-along).
- [ ] **Step 7:** Update BL-123: Status `in_progress`; record the ≥5-PR baseline protocol (Overall per package + Delta per PR; floors = observed-min − buffer tiered by criticality; Google FSE 2019 + Testing Blog 2020 citations for the eventual threshold ADR) + durable artifact pointers; **reconcile exit (a)'s wording** — it says "installed in root `package.json` devDependencies," but the correct pnpm-workspace mechanism (what this PR ships) is the `testing` catalog pin + per-package `catalog:testing` devDeps; rewrite exit (a) to the catalog mechanism (same BL-wording-fix treatment as BL-122's `TURBO_TOKEN` correction). Add the **ADR-023 §Decision Log entry** recording the advisory coverage job's design (non-required advisory job mirroring the required suite's Node split; `davelosert` reporter action SHA-pinned; thresholds deliberately deferred pending the ≥5-PR baseline — BL-123 owns the protocol; the eventual threshold policy is a separate future decision, BL-123 exit (c)/(d)) — ADR-023 is the CI/CD architecture owner and the durable home once BL-123 archives (Design §4.D).
- [ ] **Step 8:** Full `pnpm typecheck && pnpm lint && pnpm test`; `.claude/**` eslint (subdir `.mjs` node globals). SPP-3/4/5/6. Subject `chore(repo): wire vitest v8 coverage measurement substrate`; body declares lane 3 + the flag-gated advisory-job design; `Refs: BL-123, ADR-023`. No plan token.

---

### Task 10: PR-E — Unit E remote-cache experiment + doc fixes (lane 3)

**Design contract:** §4.E; §3.5 ground truth.

**Files:**

- Modify: `turbo.json` (add `"remoteCache": { "signature": true }`).
- Modify: `.github/workflows/ci.yml` (SHA-pinned `rharkor/caching-for-turbo` step in both test jobs; `TURBO_REMOTE_CACHE_SIGNATURE_KEY` at job-level `env:` from secret; `--cache=local:rw,remote:r` appended to **all four** turbo invocations — build/typecheck/lint/test — in each job on `pull_request`; job-scoped `permissions: { contents: read, actions: write }` — restating `contents: read` because a job-level map replaces the workflow-level default, exactly as Step 3 writes it).
- Modify: `docs/backlog.md` (BL-122 References §Axis 2 → §Axis 1; record the measurement window).
- Modify: `docs/decisions/023-v1-ci-cd-and-release-automation.md` (§Decision Log entry: rharkor provider adjudication + "deployed" → decided-now-implemented correction).

**Interfaces:** Consumes GitHub Actions cache + `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (executor-set secret, Step 5). Produces a warm-cache CI path measurable against the 218–223s baseline.

- [ ] **Step 1:** SPP-1 name=`e-remote-cache`, branch=`chore/turbo-remote-cache-experiment` (NON-plan-scoped — lane 3).
- [ ] **Step 2:** Add `"remoteCache": { "signature": true }` to `turbo.json`.
- [ ] **Step 3:** Add the `rharkor/caching-for-turbo@<commit-SHA>` step (pin to a SHA, not `@v2.5.0`) before the first turbo run in `test-node22` (job at `.github/workflows/ci.yml:43`) + `test-node24` (`:225`); add job-scoped `permissions: { contents: read, actions: write }` to each. **Append the read-only switch to every turbo invocation in both jobs — not only `test`.** Each job runs four: `test-node22` at `:109` (build), `:147` (typecheck), `:150` (lint), `:153` (test); `test-node24` at `:255`/`:258`/`:261`/`:264` (same four) — eight sites in all. On a `pull_request` event append `--cache=local:rw,remote:r` to each (`${{ github.event_name == 'pull_request' && '--cache=local:rw,remote:r' || '' }}`); on `push` the expression is empty, the flag is absent, and the cache stays read-write. **Flagging only `test` is the exact hole this step closes:** build/typecheck/lint would keep `remote:rw` on PR events, so a fork PR could still write poisoned build/typecheck/lint artifacts into the shared cache — the fork-poisoning defence the switch exists for would cover one of four tasks and leak the other three.

  **Use the per-invocation `--cache` flag, not the job-level `TURBO_REMOTE_CACHE_READ_ONLY` env var.** The env var (<https://turborepo.dev/docs/reference/system-environment-variables>, documented as "Prevent writing to the Remote Cache - but still allow reading", verified 2026-07-10) is tempting because one job-level line would cover all four steps at once — but its parse of a _falsy_ string is undocumented, and that gap is a silent-failure trap. GitHub Actions renders `${{ github.event_name == 'pull_request' }}` as the string `"false"` on `push`; if Turborepo treats any non-empty value as truthy, `TURBO_REMOTE_CACHE_READ_ONLY=false` keeps the cache read-only on `push` too and disables **every** cache upload — a permanently cold cache with no error surfaced, which defeats the whole experiment. The `--cache` flag carries no such ambiguity: the conditional makes it either present (PR) or entirely absent (push), a binary with no string-truthiness question. Do not "simplify" this to the env var unless someone first proves both `"false"` and empty-string are falsy in the pinned `turbo` version.

  **On the flag's own history:** `--remote-cache-read-only` is **deprecated but still functional** in turbo 2.x — it emits `WARNING --remote-cache-read-only is deprecated and will be removed in a future major version. Use --cache=remote:r` (vercel/turborepo#9699) and no longer appears in the current `turbo run` reference. Turbo's own deprecation text is itself wrong: `--cache=remote:r` disables the **local** cache as a side effect (issue #9699); the local-preserving equivalent — used here — is `--cache=local:rw,remote:r` (this repo pins `turbo ^2.9.6`; <https://turborepo.dev/docs/reference/run> documents the per-source `rw`/`r`/`w` grants; #9699 confirms the local-preserving spelling — all verified 2026-07-10).

  **Declare `TURBO_REMOTE_CACHE_SIGNATURE_KEY` at `env:` on the JOB, not on the caching-action step.** GitHub Actions step-level `env:` is scoped to that one step and does not propagate forward, whereas the key is consumed later, by the `pnpm turbo run …` steps — Turborepo signs each uploaded artifact "using the value of the environment variable `TURBO_REMOTE_CACHE_SIGNATURE_KEY`" at run time (<https://turborepo.dev/docs/reference/configuration>, verified 2026-07-10). Putting it on the action step silently disables signing:

  ```yaml
  test-node24:
    permissions: { contents: read, actions: write }
    env:
      TURBO_REMOTE_CACHE_SIGNATURE_KEY: ${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}
    steps:
      - uses: rharkor/caching-for-turbo@<commit-SHA>
      # the read-only switch rides on EVERY turbo run, not just test — see prose above
      - run: pnpm turbo run build --filter='@ai-sidekicks/control-plane...' ${{ github.event_name == 'pull_request' && '--cache=local:rw,remote:r' || '' }}
      - run: pnpm turbo run typecheck --filter='@ai-sidekicks/control-plane...' ${{ github.event_name == 'pull_request' && '--cache=local:rw,remote:r' || '' }}
      - run: pnpm turbo run lint --filter='@ai-sidekicks/control-plane...' ${{ github.event_name == 'pull_request' && '--cache=local:rw,remote:r' || '' }}
      - run: pnpm turbo run test --filter='@ai-sidekicks/control-plane...' ${{ github.event_name == 'pull_request' && '--cache=local:rw,remote:r' || '' }}
  ```

- [ ] **Step 4:** Fix BL-122: References (§Axis 2 → §Axis 1) **and the Summary sentence's same miscite** ("ADR-023 §Axis 2 names Turborepo remote-cache…" — the cache text lives in §Axis 1; sweep both forms in one edit); **correct exit (a)'s `TURBO_TOKEN` reference** — `TURBO_TOKEN` is Vercel Remote Cache's bearer auth; the rharkor/GitHub-Actions-cache backend uses **only** the HMAC signature key `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (there is no `TURBO_TOKEN` in this design), so exit (a) names the wrong secret; **persist the 218–223s cache-cold baseline onto the BL** (today it lives only in these campaign docs — the measurement has no durable home otherwise); record the measurement window (≥5 PRs vs that baseline; <30% → revert + record). Add the ADR-023 §Decision Log entry (rharkor as the $0 GitHub-native provider; the "or equivalent" latitude is **ADR-022's** phrasing that the swap rides on, recorded here as a Decision Log entry; ducktors fails the $0 constraint; correct the "deployed" overstatement to decided-now-implemented).
- [ ] **Step 5:** **Set the repo secret (executor step, not an owner hand-off):** `openssl rand -hex 32 | gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY` (owner-authenticated `gh`; 32 random bytes hex-encoded; stdin keeps the value out of argv); verify with `gh secret list`. Only if GitHub refuses (HTTP 403 — token lacks repo admin) surface an owner ACTIONABLE in the PR body instead — until set, the cache is inert (uploads/downloads no-op safely). Then SPP-3 (docs gates on the `.md`; workflow YAML lints) / SPP-4 / SPP-5 / SPP-6. Subject `chore(repo): turbo remote-cache experiment via github actions cache`; body declares lane 3 + the fork-poisoning threat model + the keep-or-revert exit; `Refs: BL-122, ADR-023`. No plan token. **State the threat model honestly:** the controls that defend against fork cache-poisoning are GitHub withholding secrets from fork-originated workflows, the read-only `GITHUB_TOKEN` on `pull_request`, and `--cache=local:rw,remote:r` on PR events. The HMAC is **not** one of them — Turborepo documents `remoteCache.signature` as artifact **integrity** verification and states it "is not a security feature" (same source as Step 3). ADR-023 §Axis 1's "HMAC ≥32 bytes" requirement is still met; only the rationale is corrected. Do not credit the signature with a security property upstream disclaims.
- [ ] **Step 6: Measurement follow-up (post-merge, recorded on BL-122):** after ≥5 PRs, compare warm-cache medians to the 218–223s baseline; ≥30% reduction → keep + archive BL-122 with the data; <30% → revert PR-E's wiring and record the negative result.

---

### Task 11: Closure — whole-corpus coherence scan

**Design contract:** §7.

**Files:** Read-only scan; fix-in-place any residual drift found (lane-appropriate: doc-only → a small `docs(repo)` PR).

- [ ] **Step 1:** Per-BL sweep: `grep -rn "BL-141\|BL-133\|BL-131\|BL-123\|BL-122\|BL-134"` across `docs/`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.claude/` — every hit consistent with Design §6 end states (no archived item described as open; no stale "deferred to V1.1" for shipped work).
- [ ] **Step 2:** Status census: Spec-002/003/021 + Plan-002/003 back at `approved`; README counts re-derived by counting; cross-plan-dependencies §6 coherent.
- [ ] **Step 3:** Contract-surface coherence: error-contracts §Runtime Node ↔ `packages/contracts` codes ↔ ADR-025 enumerate the same set; api-payload invite quartet ↔ `invite-router.factory.ts` ↔ Spec-002 agree; `AIS_WIRE_HTTP_STATUS_OVERRIDES` keys/values ↔ error-contracts §Invite 410 rows ↔ the §Error Response Shape mechanism note agree; Spec-021 registry count re-derived. **Gated-endpoint completeness (Design §7.3):** Plan-008 I-008-4's list covers every authenticated procedure the campaign made reachable through the merged host (the five runtimenode + invite create/accept/revoke), with `invite.preview`'s anonymous exclusion recorded in the invariant text — no campaign-shipped procedure silently absent.
- [ ] **Step 4:** Deterministic layer over the cumulative campaign doc diff: `node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts <all touched .md>` + `lychee --offline`; a `/ripple-check --target=<campaign-start SHA>` set-quantifier + cross-doc pass. **Use the campaign-start SHA recorded in Task 1, NOT `--target=develop`** — by the time this closure task runs, every campaign PR has merged into `develop`, so `--target=develop` would diff against a tree that already contains the changes and see an **empty diff** (the skill halts on empty). The recorded start SHA makes ripple-check see the whole campaign's cumulative diff.
- [ ] **Step 5:** Append a dated closure row to the Design's Status table; tick this task. If Step 1–4 surfaced residual drift, land the one-line fixes as a `docs(repo)` closure PR (lane-appropriate; cite the campaign).

## File-structure ledger (closure proof)

| Surface | Created | Modified |
| --- | --- | --- |
| ADRs | `decisions/025-runtime-node-caller-authorization.md` | `decisions/023-…` (§Decision Log ×2: coverage job, Task 9; remote cache, Task 10) |
| Specs | — | `002`, `003`, `021` (amend + reflip), `023` (pointer) |
| Plans | — | `002` (tasks + CP-002-9 + reflip), `003` (tasks + reflip), `008` (I-008-4 runtimenode via Task 2 + invite via Task 5; Tier-5 scope bullet) |
| Architecture | — | `contracts/error-contracts.md`, `contracts/api-payload-contracts.md`, `cross-plan-dependencies.md`, `schemas/shared-postgres-schema.md` (only if a column note is owed — none expected) |
| contracts pkg | — | `src/error.ts` (invite-code relocation + `AIS_WIRE_HTTP_STATUS_OVERRIDES`), `src/invites.ts` (preview schemas), `src/__tests__/error.test.ts` (`src/index.ts` star-exports cover the new symbols — verify-only, no edit) |
| control-plane | `invites/invite-router.factory.ts`, `runtime-nodes/classify-caller.ts`, `server/__tests__/host-invite.test.ts` | `runtime-nodes/{errors,attach-service,heartbeat-service,runtime-node-router.factory}.ts`, `invites/invite-service.ts`, `sessions/trpc.ts` (errorFormatter 410 override), `server/host.ts` (merge; transport status lifts natively — no `responseMeta`), `index.ts`, tests (`runtime-nodes/__tests__/{runtime-node-router,attach-service,heartbeat-service}.test.ts`, `server/__tests__/host-runtime-node.test.ts`, `invites/__tests__/invite-service.test.ts`) |
| runtime-daemon | — (invite IPC handlers deferred to Plan-008 Tier-5, Design §4.B decision 6) | — |
| client-sdk | — | `test/runtimeNodeClient.integration.test.ts` + `src/runtimeNodeClient.ts` comment sweep (Unit A roster-membership ripple; `membershipClient.preview` is Plan-008 Tier-5) |
| desktop | `renderer/src/runtime-node-attach/__tests__/*.test.tsx` (×4) | — |
| CI/tooling | — | `turbo.json`, `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, per-package `vitest.config.ts` + `package.json`, `.claude/skills/plan-execution/references/failure-modes.md` |
| Backlog | — | `backlog.md` (remove BL-141/BL-133; rewrite BL-131; update BL-123/BL-122; annotate BL-134), `archive/backlog-archive.md` (add BL-141, BL-133) |
| README | — | plan-status census (×4 flips + restores) |

## Self-review (writing-plans checklist)

- **Spec coverage:** every Design §4 unit maps to a task (A→2/3/4; B→5/6/7; C→8; D→9; E→10; closure→11). Design §6 archive actions are Task 4 Step 13 / Task 7 Step 11 / Task 8 Step 8. Design §7 corpus scan is Task 11.
- **Placeholders:** code steps carry actual code (the predicate helper, the router shape, the preview method with real symbols, the test bodies against the real harness); doc steps name the exact file + section + status transition. No "TBD"/"handle edge cases".
- **Type consistency:** `RUNTIME_NODE_PERMISSION_DENIED_CODE` / `RuntimeNodePermissionDeniedException` (the sole new negative pair — correction 1; no `RUNTIME_NODE_NOT_FOUND_CODE` / `RuntimeNodeNotFoundException` exists under the ratified contract) / `RuntimeNodeCallerVerdict` / `classifyRuntimeNodeCaller` (typed `transaction: Querier`, the real transaction-callback type — there is no `Queryable`) / `previewInvite` / `InvitePreviewRequestSchema` / `InvitePreviewResponseSchema` / `createInviteRouter` / the five migrated invite exceptions (`extends AisWireException`) / `AIS_WIRE_HTTP_STATUS_OVERRIDES` used identically across their tasks. **All five runtime-node service methods take `callerParticipantId` as the first parameter; `previewInvite` takes NO caller (it is anonymous, unlike `acceptInvite(participantId, request)`).** The deferred daemon symbols (`register*` handlers, `membershipClient.preview`) are intentionally absent — Plan-008 Tier-5. (A pre-landing review pass replaced an earlier hedged `assertCallerOwnsNode` throw-helper with the `classifyRuntimeNodeCaller` verdict enum — a throw-helper cannot express per-procedure uniform negatives, the oracle-closing requirement.)
- **Adversarial pass (design defects caught pre-landing, recorded so they are not reintroduced):** (1) a global "cross-session → 404" rule would have left `capabilityupdate` answering 409-for-absent vs 404-for-hidden — an existence oracle on guessable `node_id`s; fixed by the per-procedure uniform-negative rule. (2) `detach`'s shipped idempotent `null` no-op means its uniform negative is `null`, not an error — an earlier draft's `NOT_FOUND` assertion would itself have been the oracle. (3) **`attach` was mis-scoped as "regression tests only."** It has two authorization axes: the node-identity axis (b, owner-immutability upsert) IS shipped, but the **session-membership axis (a) was never enforced** — a non-member attach silently created a row (write-IDOR) and a nonexistent-session attach raised a raw FK-500. The hardened plan builds the axis-a guard now (Task 4 Step 10) and keeps axis-b as regression tests. (4) **The invite exceptions `extends Error`, not `AisWireException`** — so the tRPC surface would project no `aisError` at all; the migration (Task 7 Step 3) is the fix, and error-contracts §Invite's 410 for expired/revoked is undeliverable by stock tRPC, so decision 8 adds the contracts-owned `AIS_WIRE_HTTP_STATUS_OVERRIDES` + the `errorFormatter` stamp (verified against tRPC v11; the separate `responseMeta` transport leg this item originally added was deleted in round 4 — tRPC lifts the stamped `data.httpStatus` natively, item 36). (5) **`previewInvite`'s error order** must be row-first-then-expiry (mirroring the shipped `acceptInvite`), and it uses the REAL file-scope symbols `decryptV4Local`/`decodeClaims`/`isExpiredClaim`/`createHash` — an earlier draft had expiry-before-row and invented `#decryptAndParseClaims`/`sha256Hex`. (6) **The IDOR test harness was fictional** — `callerAs`/`rawAttachmentRow`/`invoke` do not exist, and the in-process `createCaller` surfaces `.code`+`.cause`, NOT `data.aisError` (which only materializes over the HTTP handler); the plan now adds the real helpers (Task 4 Step 6c) and asserts per layer (service/router/HTTP). Its service-level blocks were also written against the router suite's harness while targeting `attach-service.test.ts`/`heartbeat-service.test.ts`, which use a different `ctx = { pg, querier, service }` idiom — restated per destination file (Step 7). (7) **`classify`-then-mutate was a TOCTOU hole on two procedures.** `detach` and `heartbeat.ingest` resolved their attachment row **unlocked**; under READ COMMITTED a concurrent detach+re-attach can swap in another participant's row between the classify and the mutation, so the stale verdict authorizes a wrong-owner retire / forged presence write — re-opening the exact holes this campaign closes. Both now `SELECT … FOR UPDATE` (and `detach` carries `participant_id` in its UPDATE `WHERE`), and `classifyRuntimeNodeCaller`'s doc comment states the lock as a **caller contract** rather than claiming a universal "no TOCTOU window." (8) **The uniform-negative invariant was overstated and self-refuting.** `idx_node_attachments_active` is globally unique on `node_id`, so `attach`'s surviving 409 `attach_conflict` discloses one bit about any guessed `node_id` — the shipped error-contracts row for it says so in plain text. The invariant is now scoped to the four `nodeId`-keyed procedures and the residual channel is recorded in ADR-025 with its mitigation and revisit criterion; a Type-2 ADR must carry its own counterexample. (9) **`previewInvite` omitted the persisted-`expired` rung** that `acceptInvite` keeps deliberately — a swept-but-unexpired-claim row would have previewed as healthy-pending while accept refused it, the precise posture divergence decision 1 forbids. (10) **The invite fixtures were mis-typed**: `seedInvite` takes `tokenHash`, not `token`; `mintInviteToken` requires `expiresAt`; `MintedInvite` has no `expiresAt`. All three corrected against the live suite. (11) **README carries a spec census beside the plan census** — flipping only the plan line would land a README contradicting Spec-003's own header (Tasks 2/3 now flip and restore both). (12) **The owner verdict short-circuited the membership check.** `classifyRuntimeNodeCaller` returned `"owner"` on `row.participant_id === callerParticipantId` _before_ querying `session_memberships`, so a `suspended`/`revoked` participant kept heartbeating, updating capabilities, and detaching in a session they had left — the attachment row carries its creator's `participant_id` forever, and `MembershipService.updateMembership` ships `suspend`/`revoke` today. The membership query now gates every verdict, and the verdict is 4-valued. (13) **Fixing (12) naively would strand nodes permanently.** `idx_node_attachments_active` is globally unique on `node_id`, so denying a revoked owner `detach` leaves the slot occupied for all sessions, forever, with no actor able to free it. The tempting reaper — retiring attachments inside `MembershipService.updateMembership` — is **forbidden by shipped Plan-003 I-003-3** ("`MembershipUpdate` MUST NOT trigger runtime-node detach as a side effect") and would usurp the deferred Cedar-gated `revoked` producer. Resolved inside the runtime-node domain instead: `owner_inactive_member` may `detach` (self-service release) and nothing else, giving daemons a `409 → self-detach → re-attach` recovery path. (14) **Adding attach's membership lock naively would deadlock.** With `detach`/`heartbeat`/`capabilityupdate` locking the attachment row first and then reading membership, while `attach` locks membership then inserts the attachment, the two orders form an ABBA cycle on a shared `node_id`. The repo already pins a canonical order (I-002-4: `sessions` → `session_memberships`, enforced by `lock-ordering.test.ts`); this campaign extends it to a third level (I-003-6) and pays for it with a two-phase resolve plus a post-lock re-verify. (15) **`FOR KEY SHARE` would have been a silent no-op.** It does not conflict with the `FOR NO KEY UPDATE` that `UPDATE session_memberships SET state = 'revoked'` acquires, so it would have "locked" nothing against the exact race it was added to close; `FOR SHARE` is the weakest mode that conflicts (PostgreSQL Table 13.3). (16) **The migration list omitted two suites that assert superseded contracts** — `runtime-node-router.test.ts` ("No seeding needed: the first heartbeat upserts the presence row"; `capabilityupdate` no-active-row → `CONFLICT`) and `host-runtime-node.test.ts` (unseeded `capabilityupdate` → 409 + `capabilityupdate_conflict`). Both are now enumerated (Step 12 items 7-8), and the projection oracle is **re-pointed, not deleted**. (17) **`seedAttachment` is FK-backed**, contradicting the plan's own "needs no parent rows today" — the suite's helper comment and its one call site both seed `participants` + `sessions` first. (18) **The signature key was scoped to the wrong workflow step** (GitHub step `env:` does not propagate), and the HMAC was credited with a fork-poisoning defense that Turborepo's own docs disclaim ("not a security feature"). Both corrected. (19) **Refusal-path tests gate on membership too.** The migration list initially seeded membership only for happy paths — but the axis-a guard and the classify run _before_ axis-b, the version floor, and the state guard, so the attach conflict/revoked and capabilityupdate version-floor tests (router AND host layers) would die at 404 instead of reaching the branch they exist to prove; Step 12 items 7(d)/8 now enumerate them, and only the axis-a negatives stay membership-free. (20) **Two heartbeat recovery tests were missed by the ingest migration** — the staleness/hysteresis "restores…"/"resurrects…" tests ingest with only a presence row seeded; item 3 now lists all four successful-ingest call sites. (21) **The plan's own FK warning was contradicted two lines below it** — the stranger-oracle snippet called `seedAttachment` without seeding parents; fixed, with the stranger's zero seeding kept deliberate. (22) **`revokeInvite`'s `null` sentinel had no wire mapping** — the service returns `InviteRevokeResponse | null` and delegates not-found translation to the wire layer, so catch-arms alone would emit `result: null` or an output-validation 500; Step 7 adds the explicit `null → NOT_FOUND` branch with `InviteNotFoundException` as `cause`, and Step 9 asserts byte-identity with the exception path. (23) **The turbo read-only switch had to be stated precisely.** `--remote-cache-read-only` is **deprecated but still functional** in turbo 2.x (repo pins `^2.9.6`) — it emits a removal warning whose own suggested replacement `--cache=remote:r` wrongly disables the _local_ cache (vercel/turborepo#9699); the local-preserving supported form `--cache=local:rw,remote:r` is used instead (env-var alternative `TURBO_REMOTE_CACHE_READ_ONLY` recorded but not used — see item 29). (Round 2 first mis-stated the flag as "does not exist"; round 3 corrected it to "deprecated" — the `--cache` choice was right for a different reason, and the correction is recorded so the false framing is not reintroduced.) (24) **The host suite's `seedMembership` is positional** (`(querier, sessionId, participantId)`, `'collaborator'`/`'active'` hardcoded) — the plan claimed both files carried the object-arg shape; corrected before an implementer tripped on it. (25) **The owner check compared UUIDs raw.** `classifyRuntimeNodeCaller` (and the invite `create` bind) used `participant_id === callerParticipantId`; Postgres emits `uuid` lowercased while a branded/caller-supplied `ParticipantId` may be mixed-case, so the **true owner** would classify `member_not_owner` and 403 out of their own node (and a self-authored invite would false-reject). Both comparisons now canonicalize via `canonicalizeUuid` (`packages/contracts/src/uuid-canonical.ts`). (26) **`attach` bound the stored owner to the caller only at the router.** The service persists `input.participantId` verbatim as the attachment's `participant_id`, so a session member calling the exported service directly (as the service-level tests and any future non-router caller do) could mint an attachment **attributed to another participant** — an ownership-spoof write-IDOR. `attach` now runs a service-level identity pre-guard (`canonicalizeUuid(caller) !== canonicalizeUuid(validated.participantId)` → `RuntimeNodePermissionDeniedException`, ASVS 8.3.1) before the transaction; this is also what makes axis-b's `participant_id`-keyed ownership predicate trustworthy downstream. (27) **A router that derives the invite actor from the body would spoof ownership.** `InviteCreate.inviter` is a caller-supplied body field stored verbatim as `inviter_id`, so wiring `createInvite(input.inviter, input)` would run the shipped checks against the attacker-chosen inviter. The fix is purely wiring: the router passes `resolveCurrentParticipantId(ctx)` as the actor, never a body field. **The shipped service already enforces the rest** — active-owner authorization (the `createInvite` owner-probe) and the inviter-to-actor bind `validated.inviter.toLowerCase() === actorParticipantId.toLowerCase()` — so the router must NOT re-implement the equality check. (A round-3 self-verification pass against the live service corrected the plan's earlier claim that `createInvite` "never cross-checks actor === inviter" and its prescription to add that check in the router — both were false; the service's inviter-bind guard does it.) Router mismatch test: authenticated caller A with `input.inviter = B` → 403, no row (Design §4.B decision 10). (28) **`invite.preview` accepted an unbounded token on the anonymous path.** The preview request was `{ token: string }` with no length cap, but preview hashes/decrypts the token before any guard and Tier-6 rate-limiting is deferred — an unbounded-input vector. The schema now reuses the shipped `INVITE_TOKEN_MAX_LEN` (4096) cap, exactly as `InviteAcceptSchema.token`. (29) **The read-only cache switch covered only `test`.** `ci.yml`'s two jobs each run four turbo invocations (build/typecheck/lint/test); flagging only `test` left build/typecheck/lint writing to the remote cache on PR events, so a fork PR could still poison three of four caches. The flag now rides all eight invocations. The DRY-er job-level `TURBO_REMOTE_CACHE_READ_ONLY` env var was rejected because its parse of the `"false"` GitHub Actions emits on `push` is undocumented (silent cold-cache risk if `"false"` reads as truthy); the per-invocation flag is a binary presence, not a truthiness gamble. (30) **The closure `/ripple-check` command contradicted its own start-SHA rule.** The design named `--target=develop` beside the closure-pass description, but by closure every campaign PR has merged into `develop`, so that diff is empty and the skill halts. The design now distinguishes per-PR audits (`--target=develop`, correct pre-merge) from the closure pass (`--target=<campaign-start SHA>`), matching the SHA the plan records in Task 1 Step 1. (31) **The SPP ephemeral-namespace gate self-tripped.** Its grep pattern (`\.agents/tmp|F-[0-9]{4}|agent-brain`) matches this plan's own Durable-cites policy prose _and_ the guard line itself, so "expect no output" could never pass on the PR introducing it. The gate now scopes to added lines, self-excludes its own bullet by label, and is reframed as a review gate (backtick-quoted mentions allowed; live citations are the violation). (32) **`readRoster`'s membership check was TOCTOU at the read boundary.** The plan had it as an unlocked SELECT followed by a separate roster SELECT — a concurrent revoke committing between the two would hand the just-revoked caller a roster computed from a snapshot newer than their authorization. Both statements now run in one transaction with the membership row `FOR SHARE` (the same level-2 mode every other method takes — all five now authorize under one idiom), and the lock-ordering block pins it. (33) **The router's attach self-check compared raw while the service canonicalized.** Once the decision-5 pre-guard canonicalizes, the shipped raw `!==` at the router would falsely 401 the true owner's mixed-case attach before the service could admit it. The self-check is canonicalized in PR-A2 (UNAUTHORIZED contract unchanged) with a same-participant case-varied regression pin. (34) **Step 7c's prose claimed the host suite's `seedMembership` was object-arg** — contradicting the plan's own Interfaces note and Step 12 item 8, which correctly state the live positional signature (`seedMembership(querier, sessionId, participantId)`); the prose now matches the file. (35) **A job-level `permissions:` map REPLACES the workflow-level one** (unspecified scopes drop to `none`; ci.yml's workflow default is `contents: read` alone). The coverage job's `pull-requests: write` and the cache jobs' `actions: write` prescriptions each restate `contents: read`, or their own `actions/checkout` dies. Codex named the coverage job; the same class was self-caught on the Task 10 Files bullet (its Step 3 already wrote the full map) and in three design-doc lines. (36) **The hand-rolled `responseMeta` would have masked tRPC's mixed-batch contract** — its first-matching-error loop forced a whole batch to 410. Deleted rather than repaired: the `errorFormatter`'s `data.httpStatus` stamp is the single mechanism, because tRPC's transport natively lifts the stamped status (`getHTTPStatusCode` — uniform batch → that status, mixed batch → 207; source-verified in 11.17.0), and a mixed-batch 207 test is the negative control. (37) **The lock-ordering Files bullet lumped `attach` into the blanket two-phase assertion** (unlocked pre-read < `FOR SHARE` < `FOR UPDATE`) that Step 7 correctly scopes to the three `nodeId`-keyed mutators — `attach` has no pre-read and no attachment `FOR UPDATE` (it creates the row), so the blanket assertion would fail the correct implementation; the bullet now mirrors Step 7's per-procedure breakdown. (38) **The SPP code gates would have validated the wrong tree.** The preamble said "all `pnpm exec` from the main checkout root" and named no install step, while SPP-1 authors code in a fresh worktree with no `node_modules` — so the "full turbo pass" for the code PRs would have run against the unchanged main tree and passed vacuously. SPP-3 now requires `cd` into the worktree + a one-time `pnpm install` (seconds — pnpm hardlinks from the shared store) and states plainly that a green main-checkout pass on worktree-authored code is a lie. (39) **A third stale host-helper claim survived two fix rounds.** Step 6c's note still said `host-runtime-node.test.ts` carries the object-arg `seedMembership` after rounds 4–5 fixed two sibling sites — the sweep had grepped one phrasing shape instead of the symbol. This round swept every `seedMembership` mention (18 sites) and verified each against its target file; only Step 6c was wrong. (40) **The design's I-003-6 verification sentence was the plan bullet's un-fixed twin** — it still asserted membership-`FOR SHARE`-before-attachment-`FOR UPDATE` "for each of" all four procedures after the plan side was scoped per-procedure, and PR-A1 copies that sentence into Plan-003's invariant. Both docs now carry the same per-procedure scoping (attach: no pre-read, no attachment `FOR UPDATE`; roster: `FOR SHARE`, no attachment lock). (41) **`invite.preview`'s procedure kind was unspecified, and the default reading leaks tokens.** This repo's client convention sends queries as GET `?input=…` (`runtimeNodeClient.ts` documents the split), so a `.query()` preview would put every raw token into server/proxy logs and client history. Preview is now pinned as a `.mutation()` — the server-enforceable POST-only transport (tRPC refuses a method↔kind mismatch) — with GET-refused/POST-served test pins and the Spec-002 contract recording the kind + rationale; it remains non-consuming (kind ≠ semantics, invariant test-pinned). (42) **The Global Constraints worktree bullet was SPP-3's un-swept twin** — it still told workers to run gate binaries from the main checkout after round 5 fixed SPP-3, the exact both-statements-of-one-rule drift item (40) recorded one round earlier; both sites now split doc-gates (main-checkout binaries against worktree files) from code-gates (inside the worktree post-install). (43) **`attach`'s membership-first order deadlocked against `updateMembership` via an IMPLICIT lock.** The upsert's INSERT takes `FOR KEY SHARE` on the FK-referenced `sessions` row, so membership-`FOR SHARE`-then-upsert acquires level 2 → level 1 — the ABBA inverse of the shipped `sessions FOR UPDATE → memberships` (I-002-4), and `FOR UPDATE` conflicts with `FOR KEY SHARE` (Table 13.3). The fix folds the floor read into an explicit level-1 `SELECT … FOR KEY SHARE` that runs FIRST (also delivering the nonexistent-session 404 with the byte-identical non-member message), and I-003-6 now states that the canonical order **counts implicit FK locks** — the level-skip rule is precise: skipping is safe only when nothing later in the transaction acquires the skipped level implicitly. (44) **`ControlPlaneDeps` growth breaks the server-suite helper factories.** `_helpers.ts`'s two `ControlPlaneDeps`-typed factories fail typecheck the moment the type gains the invite service; the Task 7 file list now names the helper update (refusal-asserting stub / real service + `KeyRing` fixture). (45) **The per-package davelosert invocations all read the root report by default.** The action reads `${working-directory}/coverage/coverage-summary.json` with `working-directory` defaulting to `./`, while vitest writes package-local `coverage/`; every invocation now sets a per-package `working-directory` (and the artifact bank uploads package-local paths under unique names), or the advisory job publishes nothing the BL-123 baseline can use. (46) **The two-tier uniformity test only exercised tier 1.** Its name promised garbage AND unknown-hash, but `"garbage"` exits through the decrypt-failure arm before any row lookup — an implementation checking claim expiry before the row read would still pass while leaking `invite.expired` for unknown tokens. The test now adds the MAC-valid, rowless, **already-expired** token asserting `invite.not_found` — the arm that actually pins row-first-before-expiry. (47) **The plan pinned live package code with raw line locators.** `~:NNN` spellings into `packages/**` (the attach floor-read comment, the invite owner-probe/bind, ~30 test-site hints) are gate-evading forms of exactly what AGENTS.md §Durable-Cite Rule denies — the required form is `path#exportedSymbol` (or a test name) plus non-line advisory prose. Every package-code cite is now a symbol, quoted test name, or descriptive anchor — the only tilde-pin strings left in either doc are this item's and the Progress Log's backtick-quoted policy mentions of the pattern itself. (48) **Two more un-swept design twins survived rounds 6–7's fixes**: §4.A's lock-order narrative still said attach "locks the membership row `FOR SHARE` first and then upserts" and "none of them locks `sessions`" after item 43 inverted exactly that order, and §3.5's threat model still opened with the fork-can't-forge-the-HMAC chain after item 18 corrected the same claim in §4.E/Step 5. Both rewritten — the sweep unit is the CLAIM across both docs, not the flagged line. (49) **`ControlPlaneDeps` growth also breaks three client-sdk fixture factories across the package boundary** — item 44 caught the in-package `_helpers.ts` but missed `buildSubscribeOnlyDeps`/`buildCrudOnlyDeps` (`sessionClient.integration.test.ts`), `makeIntegrationDeps` (`sse-roundtrip.test.ts`), and the runtime-node deps factory (`runtimeNodeClient.integration.test.ts`), all on the Node-22 lane; and `InviteService` is not exported from the control-plane barrel, so those fixtures could not even construct the field. PR-B2 now exports it and migrates the fixtures in their documented throw-on-use posture. (50) **The census-restore step applied the spec-bullet delta to both README censuses** — the plan bullet (20 `approved`/6 `review` as of this writing) and the spec bullet (21/6) have different totals, so "`20 approved` → 21" was right for specs and wrong for plans; Tasks 2/3 now carry per-census deltas with the counting rule as the arbiter. (51) **PR-B1's design contract was scoped to "decisions 1–9"** — silently excluding decision 10, so the Spec-002 amendment would never record the caller-binding contract PR-B2 wires; the contract line, the Spec-002 Files bullet, and Step 2 now name the decision-10 inviter-binding note.
- **Lane mechanics:** every code/test/tooling task states its lane + the title-token + branch-shape consequence (lane 1 → token + `plan-NNN` branch; lane 2/3 → no token + non-plan branch) — the CI-enforced boundary the `lane-boundary` job checks.
- **Wiring completeness (anti-orphaning):** every net-new mechanism has a durable governance home a future implementer will actually read, and every deferral has a named owner recorded inside the owning plan — nothing ships discoverable only from this campaign doc. The map: runtime-node authz (ADR-025 + Spec-003 + error-contracts §Runtime Node + Plan-003 T3.10–12); attach membership guard (same set); `invite.preview` (Spec-002 + api-payload-contracts + Spec-021 row + Plan-002 T2.6); invite router + host merge (Spec-002 + Plan-002 T2.7 + cross-plan-dependencies + Plan-008 I-008-4, which gains invite create/accept/revoke so Tier-5 PASETO gating cannot skip them — preview's anonymous exclusion recorded); `AisWireException` migration (Spec-002 note + Plan-002 T2.7); `AIS_WIRE_HTTP_STATUS_OVERRIDES` + 410 delivery (error-contracts §Error Response Shape mechanism note naming the future registrants `artifact.relay_expired` / `approval.request_expired` + Plan-002 tasks); coverage substrate (ADR-023 §Decision Log entry + BL-123 protocol); remote cache (ADR-023 §Decision Log entry + BL-122); renderer component tests (Plan-003's seven BL-131 mention flips); the daemon invite leg deferral (Plan-002 **CP-002-9** + Plan-008 Tier-5 scope bullet + cross-plan-dependencies lines — three surfaces, decision 6). Verified at closure by Task 11 Steps 1–3.

## Progress Log

- 2026-07-10 — **Campaign-start SHA recorded (Task 1 Step 1): `29a88b8b495f33ee4784ffba39fd23d35fe14d91`** (`develop` == `origin/develop` at recording time). Task 11 Step 4's closure `/ripple-check --target=29a88b8` consumes this — never `--target=develop`, which would see an empty diff post-merge.
- 2026-07-10 — **Task 1 complete** (PR #201, `docs/bl-resolution-campaign`). Codex review round 1 returned 9 findings (1×P1, 8×P2); all were verified against the live tree and applied to this plan + the design before merge.
- 2026-07-10 — **Codex round 2** (@ the round-1 fix commit) returned 6 findings, all verified real and applied: refusal-path membership seeding (router + host), the two heartbeat staleness-recovery ingests, the FK-contradicting snippet, `revokeInvite`'s `null`→`NOT_FOUND` wire branch, and the `--remote-cache-read-only` flag mis-statement (replaced with `--cache=local:rw,remote:r`; note round 2 called the flag "nonexistent" — round 3 corrected that to **deprecated-but-functional**, vercel/turborepo#9699). Ground-truthing the fixes surfaced one more defect Codex did not name: the host suite's `seedMembership` is positional, not the object-arg shape the plan claimed. Self-review items (19)–(24) record the set. The P1 (`classifyRuntimeNodeCaller`'s owner short-circuit bypassing the membership check) surfaced two ripples the review did not name: the **permanent node-lockout** that a naive fix creates under the global `node_id` unique index, and the **lock-order cycle** that a naive membership lock creates against the shipped I-002-4 order. Both are resolved in Design §4.A decisions 1 and 3, and pinned by the new **I-003-6** invariant. Self-review items (12)-(18) record the whole set so they cannot be reintroduced.
- 2026-07-10 — **Codex round 3** (@ the round-2 fix commit `96dfcd7`) returned 7 findings, all verified real and applied to plan + design: (1) the closure `/ripple-check --target=develop` contradiction vs the recorded start-SHA (Design §7 now splits per-PR from closure targeting); (2) the invite router's missing caller-bind — `create` could attribute an invite to another owner (Design §4.B **decision 10**); (3) the read-only cache flag covering only `test`, not all four turbo invocations per job, **and** the round-2 "flag does not exist" overclaim corrected to deprecated-but-functional (vercel/turborepo#9699); (4) `attach`'s missing service-level caller/body identity pre-guard (Design §4.A decision 5); (5) `invite.preview`'s unbounded token on the anonymous path (reuses `INVITE_TOKEN_MAX_LEN`); (6) the SPP ephemeral-namespace grep self-matching its own policy prose + guard line; (7) raw-`===` UUID comparison in the owner check and the invite bind (both now `canonicalizeUuid`). This round's research **falsified a round-2 claim of my own** (the turbo flag is deprecated, not nonexistent) and a hardening choice was recorded against the DRY-er env-var alternative (undocumented falsy-string parse → silent cold-cache risk). Self-review items (25)–(31) record the set so none is reintroduced. Design §4.B gains decision 10; §4.A decision 3 gains the UUID-canonicalization note and decision 5 the identity pre-guard; the fork-poisoning risk row (§8) drops its HMAC mis-credit to match Step 5's threat model. A post-push self-verification against the live `invite-service.ts` then falsified round 3's own caller-bind rationale — `createInvite` already owner-authorizes the actor and binds `inviter` to it — so decision 10 was rewritten to wiring-only (router passes the resolved caller; no re-implemented equality check) in a follow-up commit.
- 2026-07-10 — **Codex round 4** (@ the self-correction commit `d6c2137`, after a manual `@codex review` nudge) returned 6 findings (4×P2, 2×P3), all verified against the live tree / tRPC source / GitHub Actions semantics and applied to plan + design: (1) `readRoster`'s two-statement membership check was TOCTOU at the read boundary — now one transaction with the membership row `FOR SHARE` (all five methods share the level-2 idiom; lock-order test updated); (2) the router attach self-check compared raw UUIDs while the service pre-guard canonicalizes — the self-check is canonicalized in PR-A2 with a case-varied regression pin; (3) Step 7c mis-stated the host suite's `seedMembership` as object-arg — the plan's own Interfaces note already said positional; prose aligned; (4) the advisory coverage job's `permissions: pull-requests: write` would null the workflow-level `contents: read` (job-level maps replace, not merge) — `contents: read` restated there, on Task 10's Files bullet (self-caught; its Step 3 was already right), and in three design lines; (5) the hand-rolled `responseMeta` masked tRPC's mixed-batch 207 contract — **deleted rather than repaired**: the `errorFormatter` stamp is the single mechanism, tRPC lifts `data.httpStatus` natively (source-verified, `getHTTPStatusCode` in 11.17.0), and a mixed-batch 207 test is the negative control; (6) the lock-ordering Files bullet lumped `attach` into the two-phase assertion Step 7 scopes to the three `nodeId`-keyed mutators — bullet aligned to the per-procedure breakdown. Self-review items (32)–(37) record the set.
- 2026-07-10 — **Codex round 5** (@ the round-4 fix commit `11bf592`, after a second `@codex review` nudge — Codex's auto-reviews were rate-limited this window, per its two "usage limits" replies) returned 4 findings (3×P2, 1×P3), all verified and applied: (1) the SPP code gates ran from the main checkout against a worktree-authored diff — vacuous green; SPP-3 now runs them from the worktree after a one-time `pnpm install`; (2) a third stale `host-runtime-node.test.ts` object-arg `seedMembership` claim (Step 6c) — the full 18-site symbol sweep replaced the phrasing-shaped grep; (3) the design's I-003-6 sentence was the plan lock-bullet's un-fixed twin — per-procedure scoping now lives in both docs; (4) `invite.preview` pinned as a `.mutation()` so raw tokens never ride GET `?input=` URLs (client convention verified in `runtimeNodeClient.ts`), with GET-refusal/POST-served test pins and the Spec-002 contract recording. Findings (2) and (3) are residue of rounds 4–5's too-narrow sweeps — the lesson (sweep the symbol, not the phrasing; sweep both docs, not the flagged one) is recorded here so the next fix round starts there. Self-review items (38)–(41) record the set.
- 2026-07-10 — **Codex round 6** (@ the round-5 fix commit `4d0e313`) returned 5 findings, all P2, all verified and applied: (1) the Global Constraints worktree bullet was SPP-3's un-swept twin — the round-5 lesson recurring one section up; both now split doc-gates from code-gates; (2) **the deepest catch of the campaign** — attach's membership-first lock order deadlocks against `updateMembership` through the upsert's implicit FK `FOR KEY SHARE` on `sessions` (verified against `membership-service.ts`'s shipped `sessions FOR UPDATE` and PostgreSQL Table 13.3); the floor read is now the explicit level-1 `FOR KEY SHARE` acquisition, and I-003-6 counts implicit FK locks; (3) `_helpers.ts`'s `ControlPlaneDeps`-typed factories join the Task 7 file list (typecheck ripple of the deps growth); (4) the davelosert invocations gain per-package `working-directory` + per-package artifact banking (the action defaults to the root report path); (5) the two-tier preview uniformity test gains the MAC-valid rowless expired-claim arm that actually pins row-first-before-expiry. Self-review items (42)–(46) record the set.
- 2026-07-10 — **Codex round 7** (@ the round-6 fix commit `a34e898`) returned 6 findings (1×P1, 4×P2, 1×P3), all verified and applied: (1) **P1 — the plan violated the Durable-Cite Rule it quotes in its own Global Constraints**: `~:NNN` locators into `packages/**` are gate-evading spellings of the denied raw line-pin; all 14 flagged lines (~30 individual pins) converted to symbol/test-name anchors + non-line advisory prose across both docs; (2) the design §4.A narrative still carried the pre-round-6 "attach locks membership first / none of them locks `sessions`" story one paragraph above the round-6 fix — rewritten to the level-1-first order (with the implicit-FK level-skip rule) in both sentences; (3) PR-B1's design contract said "decisions 1–9", excluding decision 10 from the Spec-002 amendment — contract line, Files bullet, and Step 2 now record the inviter-binding note; (4) `ControlPlaneDeps` growth breaks the three client-sdk fixture factories across the package boundary and `InviteService` is not barrel-exported — PR-B2 now exports it and migrates the fixtures (Node-22 lane); (5) design §3.5's threat model still credited the fork-can't-forge-the-HMAC chain §4.E disclaims — reframed to the platform-side controls with the HMAC as integrity-only; (6) the census-restore step applied the spec-bullet delta to the plan bullet — per-census deltas now stated in Tasks 2/3. Findings (2) and (5) are the fourth and fifth instances of the un-swept-twin class — the sweep lesson is now stated as "sweep the CLAIM across both docs" in item 48. Self-review items (47)–(51) record the set.
