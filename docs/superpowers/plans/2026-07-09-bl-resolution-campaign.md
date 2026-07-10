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
- **Worktree lanes** (CLAUDE.md §Worktrees): each PR in its own `.worktrees/<name>/`; `git worktree add .worktrees/<name> -b <branch> develop`; run `pnpm exec` gate binaries from the MAIN checkout root targeting the worktree paths (a fresh worktree has no `node_modules`); occupancy-checked removal; never edit the main checkout from worktree work.
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

Every task's final steps run this with its own branch/subject/files. All `pnpm exec` from the main checkout root.

- **SPP-1 · Lane.** `git worktree add .worktrees/<name> -b <branch> develop`. Work inside `.worktrees/<name>/`. Lefthook may not fire inside worktrees — the explicit gates + CI are the real enforcement.
- **SPP-2 · Author.** Write deliverables per the task's Design section. Re-verify every `:NNN` anchor and relative link against the live worktree.
- **SPP-3 · Gates (local).**
  - Docs: `node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts <touched .md>` + `lychee --offline --no-progress --config .lychee.toml <touched .md>`; `pnpm exec prettier --check --ignore-path=.prettierignore <touched files>` (the `--ignore-path` override is load-bearing — prettier 3.x skips gitignored `.worktrees/` files otherwise). Set-quantifier/census edits: re-derive each total by counting rows; run `/ripple-check` on the diff.
  - Code: `pnpm typecheck && pnpm lint && pnpm test` (full turbo pass — test files only typecheck here); the touched package's `vitest run`.
  - `echo "<subject>" | pnpm exec commitlint` → zero problems.
  - Ephemeral-namespace grep over the diff: `git -C .worktrees/<name> diff develop... | grep -nE '\.agents/tmp|F-[0-9]{4}|agent-brain'` → expect no output.
- **SPP-4 · Reviews.** Dispatch `plan-execution-code-reviewer` + `plan-execution-code-quality-reviewer` (+ `plan-execution-spec-reviewer` for doc/contract tasks) in parallel on the diff. Fix ACTIONABLE; apply POLISH in-PR; record VERIFICATION as no-op.
- **SPP-5 · PR.** Commit (subject + `Refs:` + `Co-Authored-By:` trailers), push, `gh pr create --base develop` with the lane classification declared in the body (code PRs include a Test Plan). Wait on `ci-gate` + `docs-corpus-gate` + the Codex round-trip: reply to every thread before resolving; re-push fixes.
- **SPP-6 · Merge.** On CLEAN: `gh pr merge --squash --subject "<explicit subject>" --body-file <body>` (never the default title), then `git worktree remove .worktrees/<name>` (occupancy-checked).

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

- Create: `docs/decisions/025-runtime-node-caller-authorization.md` (from `docs/decisions/000-adr-template.md`; Type 2 — complete every section).
- Modify: `docs/specs/003-runtime-node-attach.md` (Status `approved` → `review`; §Interfaces And Contracts + §Required Behavior authorization precondition for all five procedures — including **attach's session-membership precondition** (axis a); the four behavior changes recorded; dated Amendment block).
- Modify: `docs/architecture/contracts/error-contracts.md` (§Runtime Node — add **two** rows: `runtimenode.not_found` (404) + `runtimenode.permission_denied` (403); **and narrow** `runtimenode.capabilityupdate_conflict`'s description to the I-003-2 state guard. Per Step 4).
- Modify: `docs/plans/003-runtime-node-attach.md` (Status → `review`; new Phase-3 tasks T3.10/T3.11/T3.12; re-open the audit checkbox for the new tasks; §Progress Log note). **§Invariants takes two amendments:** (i) **I-003-3 amended** — its Verification note records that the runtime-node domain now _reads_ `session_memberships` for authorization under a `FOR SHARE` lock while still never mutating it; its two normative sentences (`RuntimeNodeAttach` MUST NOT modify `session_memberships`; `MembershipUpdate` MUST NOT trigger runtime-node detach as a side effect) are **unchanged and explicitly re-affirmed** — the `owner_inactive_member` detach carve-out exists so the second one can hold without stranding nodes. (ii) **I-003-6 added** — _any transaction touching both `session_memberships` and `runtime_node_attachments` MUST lock in the order `sessions` → `session_memberships` → `runtime_node_attachments`_, extending I-002-4; verified by the `lock-ordering.test.ts` runtime-node block.
- Modify: `docs/plans/008-control-plane-relay-and-session-join.md` (I-008-4 endpoint list adds the five runtimenode procedures; Plan-008 already `review`).
- Modify: `README.md` (**both** censuses — the plan line (~:264): Plan-003 `approved` → `review`; **and the spec line (~:265)**: Spec-003 `approved` → `review`, which changes `21 approved` → 20 and `6 … in review` → 7 and adds Spec-003 to the named list. Re-derive every count by counting, not arithmetic).

**Interfaces:** Produces ADR-025 (the caller-ownership decision) + the Spec-003 authorization preconditions + the two new `runtimenode.*` contract rows that PR-A2's code and reviews are conducted against.

- [ ] **Step 1:** SPP-1 name=`a1-authz-docs`, branch=`docs/bl-141-authz`.
- [ ] **Step 2:** Author ADR-025 recording Design §4.A decisions 1–9 (decision 9 — extending Plan-008's I-008-4 gated-endpoint invariant to the five runtime-node procedures — is _recorded_ here as part of the authorization-hardening rationale; its file-level _implementation_, the Plan-008 I-008-4 list edit, lands in Step 6) with antithesis (row-loading middleware — rejected for TOCTOU/double-fetch; Cedar now — rejected per cedar#1226 + ADR-012 approval-scope, with the named relational-growth revisit criterion; flat-404 everywhere — rejected where the corpus already discloses to members) + synthesis (transaction-interior predicate **plus the classify-then-mutate locking contract**, Design §4.A decision 1 §Locking discipline; two-tier `NOT_FOUND`/403; first-attacher-owns-`node_id`; **attach's two authorization axes — the shipped node-identity axis (b) and the newly-enforced session-membership axis (a), decision 5**; heartbeat/roster hardening). Include a **§Lock Order** subsection recording the new **I-003-6** canonical order (`sessions` → `session_memberships` → `runtime_node_attachments`) as an extension of I-002-4, the two-phase resolve it forces on the `nodeId`-keyed procedures, and why `FOR SHARE` — not `FOR UPDATE`, and never `FOR KEY SHARE` — is the correct membership lock mode. Record the **`owner_inactive_member` detach carve-out** with its rejected antithesis: reaping attachments from `MembershipService.updateMembership` is forbidden by Plan-003 I-003-3 (`MembershipUpdate` MUST NOT trigger a runtime-node detach) and would usurp the ADR-012 Cedar-gated `revoked` authority producer that `attach-service.ts` explicitly defers. Include a **§Uniform-Negative Scope** subsection recording, as an accepted residual with mitigation + revisit criterion, that `attach`'s 409 `attach_conflict` discloses one bit about a guessed `node_id` (Design §4.A decision 4 §Scope) — a Type-2 ADR must carry its own counterexample. Cite OWASP API1:2023, ASVS v5 8.2.2/8.3.1/8.3.3, cedar#1226, Matrix MSC3266 (Design §9 URLs).
- [ ] **Step 3:** Amend Spec-003 with the authorization preconditions and **all four behavior changes** (Design §4.A doc deliverables): a per-procedure precondition sentence for attach/heartbeat/capabilityupdate/detach (caller == active-node owner; cross-session → uniform not-found) + roster (session-membership predicate) + **attach's session-membership precondition (axis a)**. Record the four behavior changes explicitly: (1) attach's session-membership precondition is now **enforced** with a typed 404 (was required-but-unenforced — a non-member attach previously succeeded, a nonexistent-session attach raised a raw FK-500); (2) the heartbeat presence-forgery close; (3) the roster empty-for-unknown-session supersession; (4) `capabilityupdate`'s 409→404 split for the no-active-row arm. Add the I-003-3 read-vs-mutate note: attach/roster now **read** `session_memberships` for authorization while still never **mutating** it. Dated Amendment block (Spec-003/Spec-006 block precedent). Flip Status to `review`.
- [ ] **Step 4:** Amend error-contracts §Runtime Node per Design §4.A: add the `runtimenode.not_found` (404) and `runtimenode.permission_denied` (403) rows verbatim from the Design's table (the `not_found` description covers roster/attach non-member/nonexistent-session too), and **narrow** `runtimenode.capabilityupdate_conflict`'s description to the I-003-2 `registering→online` state guard (its no-active-attachment arm moves to the new 404). Re-derive the §Runtime Node row count by counting.
- [ ] **Step 5:** Add Plan-003 Phase-3 tasks (acceptance criteria tracing to ADR-025 + the Spec-003 rows): **T3.10** (the `classifyRuntimeNodeCaller` predicate + the two typed errors `RuntimeNodePermissionDeniedException`/`RuntimeNodeNotFoundException` + the `participant_id` SELECT-column extension on `updateCapabilities` + per-procedure negatives across heartbeat/capabilityupdate/detach), **T3.11** (the two session-scoped membership checks — **attach's axis-a session-membership guard AND the roster membership predicate**), **T3.12** (the two-account IDOR suite across the service / router / HTTP-envelope layers + the attach node-identity (axis-b) regression tests); flip Status `review`; re-open the audit checkbox scoped to the new tasks (Plan-014 precedent wording); fold the scoped audit-delta evidence into a §Progress Log note for PR-A1p to cite.
- [ ] **Step 6:** Amend Plan-008 I-008-4 to add `runtimenode.attach` / `heartbeat` / `capabilityupdate` / `detach` / `roster` to the gated-endpoint list (one-line rationale: the runtime-node guard consumes the same R1 middleware output).
- [ ] **Step 7:** Update **both** README censuses: the plan line (Plan-003 → `review`) **and** the spec line (Spec-003 → `review`: `21 approved` → 20, `6 … in review` → 7, Spec-003 added to the named list — README tracks a spec census beside the plan census; flipping only one lands a README that contradicts Spec-003's own header). Counts re-derived by counting. Then `grep -rn "Plan-003\|Spec-003" README.md CLAUDE.md docs/` for any other status claim.
- [ ] **Step 8:** SPP-3 docs gates + `/ripple-check` (heading/cite/set-quantifier risk). SPP-4 with `plan-execution-spec-reviewer`. SPP-5/6 — subject `docs(repo): adr-025 runtime-node caller-ownership authorization`, body declares the Spec-003 + Plan-003 `review` flips + the Plan-008 I-008-4 fix + the census ripple; trailer `Refs: ADR-025, Spec-003, Plan-003, Plan-008, BL-141`.

---

### Task 3: PR-A1p — Spec-003 + Plan-003 re-promotion

**Design contract:** §5 (promotion leg); [runbook §Spec-Status Promotion Gate](../../operations/plan-implementation-readiness-audit-runbook.md).

**Files:** Modify: `docs/specs/003-runtime-node-attach.md` (`review` → `approved`); `docs/plans/003-runtime-node-attach.md` (`review` → `approved`; tick the re-opened audit checkbox); `README.md` (**both** census lines restored — plan + spec).

**Interfaces:** Produces the `approved` Spec-003 + Plan-003 that PR-A2's lane-1 preflight (Gate 7) requires.

- [ ] **Step 1:** SPP-1 name=`a1p-authz-promote`, branch=`docs/bl-141-promote`.
- [ ] **Step 2:** Flip Spec-003 + Plan-003 to `approved`; tick the audit checkbox. PR body cites runbook §Spec-Status Promotion Gate by name and the PR-A1 audit-delta evidence (Spec-027/NS-13b promotion-PR precedent): the new Plan-003 tasks trace to ADR-025 + the amended Spec-003 rows; dep-closure terminal (ADR-025 accepted in PR-A1; ADR-010/012 accepted); no open questions gating Required Behavior. For the Plan-003 half, also satisfy the **plan-side** §Status Promotion Gate elements (runbook:210–214): cite the Tier-3 audit-completion date + the `plan-readiness-audit-tier-3-complete` tag.
- [ ] **Step 3:** Restore **both** README censuses (Plan-003 back to `approved` on the plan line; Spec-003 back to `approved` on the spec line — `20 approved` → 21, `7 … in review` → 6, Spec-003 dropped from the named list). Counts re-derived by counting.
- [ ] **Step 4:** SPP-3/4/5/6 — subject `docs(repo): re-promote spec-003 + plan-003 (adr-025 audit delta)`, trailer `Refs: Spec-003, Plan-003, BL-141`.

---

### Task 4: PR-A2 — Unit A code + BL-141 archive (lane 4 → lane 1)

**Design contract:** §4.A code deliverables; §3.1 seams.

**Files:**

- Modify: `packages/contracts/src/error.ts` (add `RUNTIME_NODE_PERMISSION_DENIED_CODE` + `RUNTIME_NODE_NOT_FOUND_CODE`).
- Modify: `packages/control-plane/src/runtime-nodes/errors.ts` (add `RuntimeNodePermissionDeniedException` + `RuntimeNodeNotFoundException`; narrow `RuntimeNodeCapabilityUpdateConflictException`'s doc comment to the surviving state-conflict arm).
- Create: `packages/control-plane/src/runtime-nodes/classify-caller.ts` (`classifyRuntimeNodeCaller`).
- Modify: `packages/control-plane/src/runtime-nodes/heartbeat-service.ts` (`ingest` gains a caller param + transaction: resolve active attachment, classify, then upsert).
- Modify: `packages/control-plane/src/runtime-nodes/attach-service.ts` — **all four methods gain `callerParticipantId` as the first parameter.** `updateCapabilities` / `detach` / `readRoster` gain the classification/membership predicate (Design §4.A decisions 3/4/6/7). **`attach` gains the axis-a session-membership guard (Design §4.A decision 5)**: inside the existing `this.#querier.transaction`, BEFORE the floor-read, verify the caller holds an `active` `session_memberships` row for `validated.sessionId`; absent → `RuntimeNodeNotFoundException` (superseding both the silent non-member success AND the FK-500 a nonexistent session used to raise). The axis-b node-identity guard (owner-immutability `WHERE … participant_id = EXCLUDED.participant_id` + the `23505` → `attach_conflict` path) is already shipped and unchanged — PR-A2 adds regression tests for it. **The floor-read comment (attach-service.ts ~:413-419), which currently reads "session existence/authorization is the router's gate (T3.8), not this service's," is corrected** — the service now enforces the membership precondition itself. `updateCapabilities`' `FOR UPDATE` SELECT (`AttachService.updateCapabilities`) gains **`participant_id`** in its column list (absent today; `classifyRuntimeNodeCaller` needs it — Design §4.A code deliverables). **Two shipped I-003-3 comments become false and must be corrected in this PR:** the file header's claim that attach "acquires NO `session_memberships` lock — it never references, SELECTs FOR UPDATE, or UPDATEs that table", and `detach`'s docstring mirror "It NEVER references, SELECTs FOR UPDATE, INSERTs, UPDATEs, or DELETEs `session_memberships`". Both are restated as **reads for authorization under `FOR SHARE`; never mutates** — the invariant governs mutation, and the byte-for-byte no-mutation tests (T3.2 / P8) still pass unchanged.
- Modify: `packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts` (resolve `callerParticipantId` per procedure and pass it down to all five, including `attach`; FORBIDDEN + NOT_FOUND catch-arms on the four mutations + the roster query; `attach` keeps its self-check AND gains a NOT_FOUND catch-arm).
- Test: `packages/control-plane/src/runtime-nodes/__tests__/runtime-node-router.test.ts` (extend `buildHarness` with real helpers; router-level IDOR asserting tRPC `.code` + `.cause instanceof`) + `attach-service.test.ts` + `heartbeat-service.test.ts` (service-level IDOR: direct service calls with a stranger id; row-byte-unchanged). **`runtime-node-router.test.ts` is not only extended — it is migrated:** four shipped tests assert superseded postures (Step 12 item 7).
- Modify: `packages/control-plane/src/server/__tests__/host-runtime-node.test.ts` (HTTP-layer envelope oracle: byte-identical `data.aisError` + `data.httpStatus` for the not-visible vs no-active-row negatives — the only surface where `aisError` materializes, Design §3.1). **Also migrated:** its `capabilityupdate_conflict` projection test seeds nothing and expects 409; that arm is now 404 (Step 12 item 8).
- Modify: `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts` (**I-003-6 regression block** — extend the shipped logging-proxy `Querier` technique that already pins I-002-4 to assert the runtime-node lock order: unlocked attachment pre-read < `session_memberships … FOR SHARE` < `runtime_node_attachments … FOR UPDATE`, for `attach` / `detach` / `heartbeat.ingest` / `updateCapabilities`; `readRoster` takes no lock. Cross-directory but correct: this file is the canonical home of the lock-ordering invariant, and forking a second one would fracture it).
- Modify: `packages/client-sdk/test/runtimeNodeClient.integration.test.ts` (the OTHER_SESSION roster-isolation leg, ~:1221, now seeds the caller's membership so the roster returns instead of 404-ing — runs on `test-node22`, so a miss reddens `ci-gate`; Design §4.A code deliverables §Cross-package ripple) + `packages/client-sdk/src/runtimeNodeClient.ts` (comment sweep: any comment asserting cross-session roster visibility is now membership-scoped).
- Modify: `docs/backlog.md` + `docs/archive/backlog-archive.md` (move BL-141).

**Interfaces:**

- Consumes: `resolveCurrentParticipantId(ctx): ParticipantId` (existing dep on `RuntimeNodeRouterDeps`); `session_memberships` (Plan-001-created table; `state IN ('pending','active','suspended','revoked')` — the predicate keys on `'active'`); the `AisWireException` errorFormatter path.
- Produces:
  - `RUNTIME_NODE_PERMISSION_DENIED_CODE: "runtimenode.permission_denied"`, `RUNTIME_NODE_NOT_FOUND_CODE: "runtimenode.not_found"`.
  - `class RuntimeNodePermissionDeniedException extends AisWireException`, `class RuntimeNodeNotFoundException extends AisWireException`.
  - `type RuntimeNodeCallerVerdict = "owner_active_member" | "owner_inactive_member" | "member_not_owner" | "not_visible"` — **four** verdicts, because node-identity ownership and active session membership are independent facts (Design §4.A decision 3).
  - `classifyRuntimeNodeCaller(transaction: Querier, callerParticipantId: ParticipantId, row: { participant_id: string; session_id: string }): Promise<RuntimeNodeCallerVerdict>` — used by `detach` / `updateCapabilities` / `heartbeat` (which have an existing row to classify), each after an **unlocked** pre-read of that row and before the `FOR UPDATE` re-resolve (I-003-6 lock order). It takes the level-2 `session_memberships … FOR SHARE` lock internally. `attach` and `readRoster` instead run a **direct `active`-membership SELECT** (no existing node row to classify — attach is creating one, roster is enumerating); `attach`'s is `FOR SHARE`, `readRoster`'s is unlocked. (`Querier` is the transaction-callback type — `migration-runner.ts` passes a connection-bound `Querier` to `transaction(fn)`, not a narrower type; there is no `Queryable`.)
  - All five service methods (`attach` / `updateCapabilities` / `detach` / `readRoster` / `HeartbeatService.ingest`) take `callerParticipantId: ParticipantId` as the **first** parameter.
  - Test-harness helpers on `buildHarness`'s return (Design §3.1 — none exist in `runtime-node-router.test.ts` today): `callerAs(participantId, ctx?)` (rebuilds the router over the same querier with `resolveCurrentParticipantId: () => participantId`), `rawAttachmentRow(nodeId)` / `rawPresenceRow(nodeId)` (direct `querier.query` row reads), `seedMembership({ sessionId, participantId, role?, state? })` — matching the field-name shape of the file-scope `seedMembership(querier, { … })` that ALREADY exists in `attach-service.test.ts` / `host-runtime-node.test.ts`.

**Uniform-negative rule (Design §4.A decision 4 — the oracle-closing invariant this task implements).** `not_visible` MUST produce each procedure's own no-active-row response, never a distinct one:

| Procedure | no-active-row / no-visible-session | `not_visible` | `member_not_owner` | `owner_inactive_member` |
| --- | --- | --- | --- | --- |
| `detach` | `null` (idempotent no-op — retry-safety) | `null` | 403 | **proceed** (self-service release) |
| `heartbeat` | 404 `runtimenode.not_found` | 404 (identical) | 403 | 404 (identical) |
| `capabilityupdate` | 404 `runtimenode.not_found` (**split out of the shipped 409**) | 404 (identical) | 403 | 404 (identical) |
| `roster` | 404 `runtimenode.not_found` (supersedes `{nodes: []}` for an unknown/invisible session; a **member of a visible-but-empty** session still gets `{nodes: []}`) | 404 (identical) | n/a — membership is the predicate | 404 (membership is the predicate) |
| `attach` | 404 `runtimenode.not_found` for a **non-member or nonexistent** session (axis a, **NEW** — supersedes silent success + the FK-500); 409 `attach_conflict` stays for the node-identity axis (axis b, shipped) | 404 (non-member) | n/a — attach has no pre-existing row to classify by membership; the caller's own membership is the predicate | 404 (membership is the predicate) |

`capabilityupdate` keeps its 409 **only** for the I-003-2 `registering→online` state guard, which is reachable only by the node's owner. `attach`'s axis-a 404 (membership) and axis-b 409 (`attach_conflict`, cross-owner / cross-session-active) are distinct refusals on distinct axes — the membership guard runs first, so a non-member never reaches the node-identity conflict path.

**Why `detach` alone carves out `owner_inactive_member` (Design §4.A decision 3).** `idx_node_attachments_active` is globally unique on `node_id`, so refusing a revoked owner's detach strands that node for **every** session, permanently — and Plan-003 I-003-3 forbids the obvious cleanup (`MembershipUpdate` MUST NOT trigger a runtime-node detach as a side effect). Detach is a **release** of the caller's own row: it writes only the two runtime-node tables, grants no session authority, and is unreachable by a non-owner (a stranger classifies `not_visible`). The other three procedures **drive** a node inside a session, which an inactive member has no standing to do. This yields the daemon recovery protocol: `409 attach_conflict` elsewhere → `detach` own node → re-attach.

**Scope of the invariant (Design §4.A decision 4 §Scope — do NOT overstate it).** Uniformity binds the four `nodeId`-keyed rows above. It does **not** bind `attach`'s 409 `attach_conflict`: `idx_node_attachments_active` is globally unique on `node_id`, so a caller who IS a member of their own session can probe a guessed `node_id` and distinguish "attached somewhere I can't see" (409) from "free" (success). That one-bit channel is inherent to the shipped I-003-5 global node identity, is **accepted and recorded in ADR-025 with its mitigation (high-entropy `node_id`; Tier-6 rate limit) and revisit criterion (node-id squatting observed, or `node_id` becomes user-authored → re-open I-003-5 for per-session uniqueness + server-minted ids)**. Write the ADR to say this; do not write "the guard never discloses cross-session node existence" without the `nodeId`-keyed qualifier — the shipped `attach_conflict` row description refutes the unqualified claim.

- [ ] **Step 1:** SPP-1 name=`a2-authz-code`, branch=`feat/plan-003-caller-authz`.

- [ ] **Step 2: Write the failing contracts test.** In `packages/contracts/src/__tests__/error.test.ts` (or the existing error test file):

```ts
import { RUNTIME_NODE_NOT_FOUND_CODE, RUNTIME_NODE_PERMISSION_DENIED_CODE } from "../error.js";

it("exports the runtimenode authorization wire codes", () => {
  expect(RUNTIME_NODE_PERMISSION_DENIED_CODE).toBe("runtimenode.permission_denied");
  expect(RUNTIME_NODE_NOT_FOUND_CODE).toBe("runtimenode.not_found");
});
```

- [ ] **Step 3:** Run `pnpm --filter @ai-sidekicks/contracts test` → FAIL (not exported).

- [ ] **Step 4: Add both constants** to `packages/contracts/src/error.ts`, matching the sibling `*_CODE` export shape with explicit type annotations (TS9010, `--isolatedDeclarations`):

```ts
export type RuntimeNodePermissionDeniedCode = "runtimenode.permission_denied";
export const RUNTIME_NODE_PERMISSION_DENIED_CODE: RuntimeNodePermissionDeniedCode =
  "runtimenode.permission_denied";
export type RuntimeNodeNotFoundCode = "runtimenode.not_found";
export const RUNTIME_NODE_NOT_FOUND_CODE: RuntimeNodeNotFoundCode = "runtimenode.not_found";
```

(The type+const pair is the shipped sibling shape throughout `error.ts` — every existing `*_CODE` pairs an exported type alias with the annotated const.)

- [ ] **Step 5:** Run the contracts test → PASS. Commit `feat(contracts): add runtimenode authorization wire codes`.

- [ ] **Step 6: Add both exception subclasses** to `packages/control-plane/src/runtime-nodes/errors.ts` (mirror the code+message-only 409 siblings; no `details`), and narrow `RuntimeNodeCapabilityUpdateConflictException`'s doc comment to the surviving `registering→online` state-guard arm:

```ts
import {
  RUNTIME_NODE_NOT_FOUND_CODE,
  RUNTIME_NODE_PERMISSION_DENIED_CODE,
} from "@ai-sidekicks/contracts";
// ...existing imports...

/**
 * Thrown when the caller is an ACTIVE member of the target attachment's
 * session but is NOT the participant that owns the node identity
 * (first-attacher-owns, ADR-025). A caller who is not a member of that
 * session never reaches this — they receive the procedure's uniform negative
 * instead, so cross-session node existence never leaks. Code+message-only.
 */
export class RuntimeNodePermissionDeniedException extends AisWireException {
  readonly code: typeof RUNTIME_NODE_PERMISSION_DENIED_CODE = RUNTIME_NODE_PERMISSION_DENIED_CODE;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodePermissionDeniedException";
  }
}

/**
 * The uniform negative (ADR-025): "no visible active attachment for this node"
 * OR "no visible session for this roster read". Deliberately identical for a
 * node/session that does not exist and one the caller may not see — `node_id`
 * is caller-chosen TEXT (guessable), so a distinguishable response would be an
 * existence oracle. `detach` never throws this (its no-active-row response is
 * an idempotent `null`, and its not-visible response matches it).
 */
export class RuntimeNodeNotFoundException extends AisWireException {
  readonly code: typeof RUNTIME_NODE_NOT_FOUND_CODE = RUNTIME_NODE_NOT_FOUND_CODE;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeNotFoundException";
  }
}
```

- [ ] **Step 6b: Create `classify-caller.ts`** — the single predicate every procedure shares:

```ts
import type { ParticipantId } from "@ai-sidekicks/contracts";

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
 * `session_id`, then this call, then `SELECT … FOR UPDATE` on the attachment with a
 * re-verify). Calling this while holding the attachment lock inverts the order and
 * deadlocks against `attach`, which locks membership before inserting.
 *
 * CALLER CONTRACT 2 — RE-VERIFY (load-bearing): the verdict describes `row` as of the
 * unlocked pre-read. After taking the attachment lock the caller MUST re-check that
 * `(participant_id, session_id)` still equal the values passed here; under READ
 * COMMITTED an unlocked row can be retired and replaced by a different participant's
 * attachment in between, so applying a stale verdict is a TOCTOU hole (wrong-owner
 * detach / presence forgery), not a guard. A mismatch yields the procedure's uniform
 * negative. `readRoster` (pure read, mutates nothing) is the only caller exempt from
 * both contracts.
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
  const isOwner = row.participant_id === callerParticipantId;
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
| `owner_inactive_member` | **proceed** (self-service release) | 404 | 404 | 404 |
| `member_not_owner` | 403 | 403 | 403 | n/a (membership-keyed) |
| `not_visible` | `null` no-op | 404 | 404 | 404 |

- [ ] **Step 6c: Extend `buildHarness` with the real helpers the suite needs.** Design §3.1 verified that NONE of `callerAs` / `rawAttachmentRow` / `rawPresenceRow` / `invoke` exist in `runtime-node-router.test.ts` today, that `harness.caller` is a **pre-built property** (`harness.caller.runtimenode.attach(...)`, NOT `harness.caller({ requestId })`), and that the router closed over a **fixed** `resolveCurrentParticipantId: () => PARTICIPANT_ID`. So `callerAs` must rebuild the router over the SAME services with a different identity stub. Preserve the existing `{ pg, querier, router, caller }` keys; add the services + helpers. Also add `const STRANGER_PARTICIPANT_ID` (a third participant, seeded but never made a member) beside the existing `PARTICIPANT_ID` / `OTHER_PARTICIPANT_ID` constants. **Note:** a file-scope `seedMembership(querier, { sessionId, participantId, role, state })` ALREADY exists in `attach-service.test.ts` and `host-runtime-node.test.ts` — this harness helper matches that field-name shape (the querier is closed over; `role`/`state` default), it does not invent a new one.

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
it("refuses a non-member attach with not_found and writes no attachment row", async () => {
  await seedParticipant(ctx.querier, STRANGER_PARTICIPANT_ID);
  await seedSession(ctx.querier, SESSION_ID); // session exists; caller holds NO membership
  await expect(
    ctx.service.attach(
      STRANGER_PARTICIPANT_ID,
      buildAttachRequest({ participantId: STRANGER_PARTICIPANT_ID }),
    ),
  ).rejects.toBeInstanceOf(RuntimeNodeNotFoundException);
  expect(await readAttachmentRow(ctx.querier, NODE_ID, SESSION_ID)).toBeUndefined();
});

// Attach axis-a: a nonexistent session yields the SAME not_found (superseding the raw
// FK-500). SESSION_ID is deliberately never seeded — beforeEach gives each test a
// fresh PGlite, so the default buildAttachRequest() targets a nonexistent session.
it("refuses an attach to a nonexistent session with the same not_found, no FK-500", async () => {
  await seedParticipant(ctx.querier, PARTICIPANT_ID);
  await expect(ctx.service.attach(PARTICIPANT_ID, buildAttachRequest())).rejects.toBeInstanceOf(
    RuntimeNodeNotFoundException,
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
  ).rejects.toBeInstanceOf(RuntimeNodeNotFoundException);
  expect(await readPresence(ctx.querier, NODE_ID)).toBeUndefined();
});

// Oracle: a stranger heartbeating a REAL attachment gets the identical refusal, no row.
it("refuses a stranger's heartbeat on an existing attachment identically to never-attached", async () => {
  await seedAttachment(ctx.querier, {
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_ID,
    nodeId: NODE_ID,
    state: "online",
  });
  await expect(
    ctx.service.ingest(STRANGER_PARTICIPANT_ID, { nodeId: NODE_ID, healthState: "online" }),
  ).rejects.toBeInstanceOf(RuntimeNodeNotFoundException);
  expect(await readPresence(ctx.querier, NODE_ID)).toBeUndefined();
});
```

**Locking regression tests (Design §4.A decision 1 §Locking discipline; I-003-6).** PGlite is single-connection, so a true concurrent interleave is not directly expressible. **Do not invent a raw-source string scan** — this repo already has the right technique and a canonical home for it: `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts` wraps the test `Querier` in a **logging proxy** that captures every SQL statement, recursively re-wrapping the in-transaction `tx` and tagging it with a tx-scoped `querierId`, so assertions can pin both the **ordering** of lock statements and the fact that they ran through the in-tx `Querier` (gripping the held client rather than a side-checked-out connection). It already pins I-002-4 for `InviteService.acceptInvite` and `MembershipService.updateMembership` this way.

Extend that file with a runtime-node block asserting, per procedure, inside a single transaction:

1. `attach` — the `session_memberships … FOR SHARE` statement precedes any `runtime_node_attachments` statement (canonical order), and no `sessions … FOR UPDATE` is taken.
2. `detach` / `heartbeat.ingest` / `updateCapabilities` — the attachment **pre-read carries no lock clause**, the `session_memberships … FOR SHARE` follows it, and the `runtime_node_attachments … FOR UPDATE` follows that (order: unlocked pre-read < `FOR SHARE` < `FOR UPDATE`). A `FOR UPDATE` appearing before the `FOR SHARE` is the deadlock-inducing inversion and must fail the test.
3. `detach`'s mutation carries `participant_id` in its `WHERE` (assert on the captured statement, not the source file).
4. **Negative control** (per standing practice — prove the checker can fail): temporarily hoist the attachment `FOR UPDATE` above the membership `FOR SHARE` in a scratch edit and confirm the ordering assertion fails before landing the real implementation. Do not commit the scratch edit.

`readRoster` asserts the inverse: it issues a membership `SELECT` with **no** lock clause and never a `FOR UPDATE`. Semantic two-connection interleave tests remain the Tier-5 integration-suite follow-up (named, not silently skipped).

Add the rest of the §Uniform-negative table at the service layer: same-session non-owner → `RuntimeNodePermissionDeniedException` for `updateCapabilities` (row + presence byte-unchanged); cross-session (non-member) `detach` returns the shipped idempotent `null` (byte-identical to detaching a never-attached node — the oracle), row byte-unchanged; `readRoster` by a non-member of an existing session throws `RuntimeNodeNotFoundException`, identical to `readRoster` on an unknown `sessionId`; a member of a **visible-but-empty** session gets `{ nodes: [] }`; `updateCapabilities` by the owner on a `registering` node without a capability declaration → the surviving `RuntimeNodeCapabilityUpdateConflictException`; attach cross-owner reconnect + attach cross-session second-active → `RuntimeNodeAttachConflictException` (axis-b regression, shipped). Every owner happy-path stays green.

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
it("maps cross-session and nonexistent-node heartbeats to the identical NOT_FOUND / typed cause", async () => {
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
  expect(hidden.code).toBe("NOT_FOUND");
  expect(absent.code).toBe("NOT_FOUND");
  expect(hidden.cause).toBeInstanceOf(RuntimeNodeNotFoundException);
  expect(absent.cause).toBeInstanceOf(RuntimeNodeNotFoundException);
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
expect(hidden.body.error.data.aisError.code).toBe("runtimenode.not_found");
expect(hidden.body.error.data.httpStatus).toBe(404);
expect(hidden.body.error.data.aisError.code).toBe(absent.body.error.data.aisError.code);
expect(hidden.body.error.data.httpStatus).toBe(absent.body.error.data.httpStatus);
// The `message` is NOT asserted equal: it echoes the caller's own chosen nodeId, which
// reveals no server-side fact — the leak-relevant fields (code + httpStatus) are identical.
```

(The suite's existing idiom is a module-level `buildControlPlaneFetchHandler(...)` + per-procedure request construction — the new helper wraps that idiom so caller identity varies per call; `host-runtime-node.test.ts` also already carries its own file-scope `seedMembership(querier, { … })` for the seeding these cases need.)

- [ ] **Step 8:** Run `pnpm --filter @ai-sidekicks/control-plane test` → FAIL. Confirm the failures are the _expected_ ones — the service-level tests demonstrate the live IDORs before the fix (the negative control for this task): today the non-owner detach **succeeds**, the stranger's heartbeat **creates a presence row**, and a **non-member attach writes an attachment row** (the write-IDOR the axis-a guard closes). A zero-findings run here would mean the tests don't actually exercise the vulnerable paths — they must go red first.

- [ ] **Step 9: Thread the caller identity through the router.** In `runtime-node-router.factory.ts`, each mutating procedure resolves the caller once and passes it to the service; add the FORBIDDEN + NOT_FOUND catch-arms. Example for `detach`:

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
      if (err instanceof RuntimeNodeNotFoundException) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message, cause: err });
      }
      throw err;
    }
  }),
```

Apply the same shape to `heartbeat`, `capabilityupdate` (keeping its surviving CONFLICT arm alongside the new NOT_FOUND arm), and `roster` (`.query`, NOT_FOUND on no-visible-session). **`attach` gains a NOT_FOUND catch-arm too** (for the new axis-a membership refusal) and is now threaded `callerParticipantId` — it keeps its existing self-check (`input.participantId === callerParticipantId`, else UNAUTHORIZED) and its axis-b `attach_conflict` (409) path; the membership guard raises `RuntimeNodeNotFoundException` → NOT_FOUND. So `attach`'s catch-arm carries UNAUTHORIZED (self-check, pre-existing) + NOT_FOUND (axis-a, new) + CONFLICT (axis-b, shipped).

Both new exceptions extend `AisWireException`, so the shared `errorFormatter` projects `shape.data.aisError` for each with **no formatter change** — the router's only job is the tRPC status mapping (`FORBIDDEN` / `NOT_FOUND`).

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

    // PHASE 3 — level-3 lock + RE-VERIFY. Re-resolve the row FOR UPDATE and confirm
    // it is still the row the verdict was computed from. A concurrent detach +
    // re-attach can have swapped in a different participant's attachment between
    // phase 1 and here; applying the stale verdict would retire someone else's row.
    const locked = await transaction.query<{ participant_id: string; session_id: string }>(
      `SELECT participant_id, session_id FROM runtime_node_attachments
        WHERE node_id = $1 AND state IN ('registering','online','degraded')
        FOR UPDATE`,
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

1. **Canonical order (I-003-6, new):** `sessions` → `session_memberships` → `runtime_node_attachments`. It extends the shipped I-002-4 order (`sessions` → `session_memberships`, pinned by `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts`). No runtime-node procedure locks `sessions`; skipping a level in a total order is safe. **Inverting it deadlocks** — `attach` locks membership then inserts the attachment, so any procedure that locks the attachment first and then reads membership closes an ABBA cycle.
2. **`FOR SHARE` on membership, `FOR UPDATE` on the attachment.** The membership row is read, not written, so an exclusive lock would needlessly serialize one participant's concurrent node calls. `FOR SHARE` still blocks a concurrent revoke, because a plain `UPDATE session_memberships SET state = …` takes `FOR NO KEY UPDATE`, which conflicts with `FOR SHARE` (PostgreSQL Table 13.3). **Never `FOR KEY SHARE`** — it does _not_ conflict with `FOR NO KEY UPDATE` and would be a silent no-op.
3. **Re-verify after the level-3 lock.** The phase-1 pre-read is unlocked by construction, so the verdict is only valid for the row it saw. Phase 3 re-reads under `FOR UPDATE` and compares `(participant_id, session_id)`; a mismatch takes the uniform negative.

`readRoster` is the single exempt caller — a pure read, so a plain membership `SELECT` (no lock) suffices. **Do not "simplify" the pre-read into a locked read** — that is exactly the order inversion rule 1 forbids.

`attach` — gains `callerParticipantId` as its first param and the **axis-a membership guard** at the top of the existing `this.#querier.transaction`, BEFORE the version-floor read. The guard supersedes the floor-read comment (~:413-419) that currently says session authorization "is the router's gate (T3.8), not this service's" — correct that comment to record that the service now enforces membership:

```ts
async attach(callerParticipantId: ParticipantId, request: RuntimeNodeAttachRequest): Promise<RuntimeNodeAttachResponse> {
  const validated = RuntimeNodeAttachRequestSchema.parse(request);
  return this.#querier.transaction(async (transaction) => {
    // ADR-025 axis-a: the caller (== validated.participantId, pinned by the router
    // self-check) must be an ACTIVE member of the target session before any
    // attachment row is created. A non-member — OR a nonexistent session (no
    // membership row either way) — yields the uniform not-found, superseding both
    // the silent non-member success AND the raw FK-500 the old floor-read comment
    // deferred to. Runs BEFORE the floor read.
    //
    // `FOR SHARE` is REQUIRED, not decorative. This is the one classify-then-mutate
    // window whose artifact is DURABLE: an unlocked read lets a concurrent revoke
    // commit between the check and the upsert, so a stale authorization creates a
    // real attachment row that outlives the transaction. FOR SHARE conflicts with the
    // FOR NO KEY UPDATE that `UPDATE session_memberships SET state=...` takes, so the
    // revoke serializes behind us (PostgreSQL Table 13.3). FOR KEY SHARE would NOT
    // conflict and would be a silent no-op. It is a SHARED lock, so two of this
    // participant's concurrent attaches do not serialize against each other.
    //
    // Taking the membership lock BEFORE touching runtime_node_attachments is the
    // canonical order I-003-6 requires; it is why the nodeId-keyed mutators must
    // pre-read their attachment row UNLOCKED. I-003-3 still holds: a FOR SHARE row
    // lock reads, it does not modify session_memberships.
    const membership = await transaction.query<{ one: number }>(
      `SELECT 1 AS one FROM session_memberships
        WHERE session_id = $1 AND participant_id = $2 AND state = 'active'
        FOR SHARE`,
      [validated.sessionId, callerParticipantId],
    );
    if (membership.rows[0] === undefined) {
      throw new RuntimeNodeNotFoundException(
        `No visible session for the requested runtime-node attach.`,
      );
    }
    // ...existing floor read (step 1) + readOnly derivation (step 2) + upsert
    //    (step 3, axis-b conflict/revoked classification) — all unchanged...
  });
}
```

`capabilityupdate` — apply the same three-phase shape as `detach`. Phase 1: an **unlocked** pre-read of `participant_id, session_id` for the active `node_id` (new statement — it must precede the membership lock, so it cannot be the shipped `FOR UPDATE` SELECT). Phase 2: `classifyRuntimeNodeCaller`; `member_not_owner` → 403; `not_visible` **and `owner_inactive_member`** → `RuntimeNodeNotFoundException` with **the same message the no-active-row branch now throws** (that branch changes from `RuntimeNodeCapabilityUpdateConflictException` to `RuntimeNodeNotFoundException`; the 409 survives only for the `registering→online` guard below it). Phase 3: the **existing** `SELECT … FOR UPDATE` (`AttachService.updateCapabilities`; it selects `id, state, client_version, session_id` today) — **add `participant_id` to its column list** (absent today) and re-verify `(participant_id, session_id)` against the phase-1 snapshot before any mutation. The shipped `FOR UPDATE` is retained but now sits **below** the membership lock, per I-003-6.

`heartbeat.ingest` — wrap the body in `this.#querier.transaction` and apply the same three phases. Phase 1: unlocked pre-read (`SELECT participant_id, session_id FROM runtime_node_attachments WHERE node_id = $1 AND state IN ('registering','online','degraded')`); no row → `RuntimeNodeNotFoundException`. Phase 2: classify — `member_not_owner` → 403; `not_visible` **and `owner_inactive_member`** → the identical `RuntimeNodeNotFoundException` (an inactive-membership owner may not drive a node; only `detach` is carved out). Phase 3: re-resolve `FOR UPDATE`, re-verify against the snapshot, then run the existing presence upsert. **Both locks are required** (see §Locking discipline above): without the level-3 lock + re-verify, a concurrent detach + re-attach by a different participant can land between the classify and the upsert, letting a stale verdict authorize a presence write against an attachment the caller no longer owns — re-opening the presence-forgery hole this change closes. Without the level-2 `FOR SHARE`, a concurrent revoke does the same.

`readRoster` — gains `callerParticipantId` first; before the roster SELECT, verify the caller holds an `active` `session_memberships` row for `input.sessionId`; absent → `RuntimeNodeNotFoundException` (identical for an unknown session and a session the caller isn't in). A member of a **visible-but-empty** session still gets `{ nodes: [] }` (the membership check passes; the roster SELECT returns no rows). This supersedes the shipped `{nodes: []}`-for-unknown-session posture. `readRoster` classifies by membership only — there is no per-row owner question for an enumeration. Comment the membership SELECT to record the I-003-3 read-vs-mutate distinction: roster now **references** `session_memberships` for authorization but never **mutates** it (the byte-unchanged property the I-003-3 test asserts still holds — a read is not a write; Step 12.5).

- [ ] **Step 11:** Run `pnpm --filter @ai-sidekicks/control-plane test` → PASS (all IDOR + uniformity cases green; every owner happy-path still green). Then full `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 12: Migrate the existing suites to the new signatures + superseded postures.** This is the widest blast radius in the task; enumerate each in the PR body as a ratified Spec-003 contract change (PR-A1), not regression masking. The five service methods gained a `callerParticipantId` first parameter, so **every existing call site updates** — these are build-breaking (TS + runtime), not optional:
  1. **Signature migration (mechanical, all call sites).** `attach-service.test.ts` uses its own `ctx = { pg, querier, service: new AttachService(querier) }` (beforeEach ~:471); ~15 `ctx.service.attach(req)` calls → `ctx.service.attach(PARTICIPANT_ID, req)`, and the `updateCapabilities` / `detach` / `readRoster` call sites likewise. `heartbeat-service.test.ts` `ctx.service.ingest(req)` → `ctx.service.ingest(PARTICIPANT_ID, req)`. **Seed the owner's membership** so the happy-paths clear axis-a: add `seedMembership(ctx.querier, { sessionId: SESSION_ID, participantId: PARTICIPANT_ID, role: "viewer", state: "active" })` per-test where the session is seeded (the file-scope helper — attach-service.test.ts already has it; heartbeat-service.test.ts gains its duplicate in Step 7). `buildAttachRequest`'s participant defaults to `PARTICIPANT_ID`, so the owner is the ctx caller.
  2. **Attach happy-paths now require membership** (attach-service.test.ts: the P9 reconnect ~:716/:726, the cross-owner refusals ~:742/:759, the response-shape tests ~:639/:667/:854/:905, etc.). Each already `seedSession`s — add the matching `seedMembership(ctx.querier, { sessionId: SESSION_ID, participantId: PARTICIPANT_ID, role: "viewer", state: "active" })`. The cross-owner-reconnect tests (~:766/:815) attach as `OTHER_PARTICIPANT_ID` — seed **that** participant's membership too, so the refusal is the axis-b `attach_conflict` (the intended assertion), not an axis-a not-found.
  3. **Heartbeat ingest presence-forgery close** (heartbeat-service.test.ts ingest suite, describe ~:180; "creates a presence row … on first heartbeat (P6)" ~:181, "updates the SAME row …" ~:191). Today they ingest against a node with **no** attachment (presence has no FKs, so none was seeded). Now `ingest` refuses a never-attached node — each ingest happy-path must first `seedParticipant` + `seedSession` + `seedMembership` + `seedAttachment` (active) for `NODE_ID` owned by `PARTICIPANT_ID`, then `ingest(PARTICIPANT_ID, …)`. Add a NEW negative test: `ingest(STRANGER_PARTICIPANT_ID, …)` on a never-attached node → `RuntimeNodeNotFoundException`, no presence row (moved from Step 7 if colocated).
  4. **capabilityupdate no-active-row 409 → 404** (attach-service.test.ts): the three no-active-row assertions flip `RuntimeNodeCapabilityUpdateConflictException` → `RuntimeNodeNotFoundException` — "no active attachment" (it ~:1582), "never attached" (it ~:1613), "revoked … active-band excludes revoked" (it ~:1629). The **state-guard** test "refuses driving a registering attachment online (I-003-2 guard)" (it ~:1492) and the version-floor refusals (describe ~:1809) **stay 409** — do not flip them.
  5. **Roster posture split** (attach-service.test.ts roster describe, T5.0c). The combined test "returns an empty roster for a session with no attachments AND for a non-existent session" splits: a **member** of an empty session still gets `{ nodes: [] }`; a **non-member or non-existent** session now → `RuntimeNodeNotFoundException` (404). The "isolates sessions" test seeds the caller's membership in the session it reads. The I-003-3 "writes NOTHING — … session_memberships byte-for-byte unchanged across a roster read" test **stays green** — `readRoster` now SELECTs `session_memberships` for authorization but never mutates it (a read is not a write); keep the assertion, and correct any code/comment claiming roster "never references" `session_memberships` to "never **mutates**" (the I-003-3 read-vs-mutate distinction the Spec-003 amendment records).
  6. **Client-SDK cross-package ripple** (`packages/client-sdk/test/runtimeNodeClient.integration.test.ts`, OTHER_SESSION roster-isolation leg ~:1221): seed the caller's membership so the roster returns rather than 404-ing; sweep `runtimeNodeClient.ts` comments for any cross-session-roster-visibility claim (now membership-scoped). Runs on `test-node22` → a miss reddens `ci-gate`.
  7. **Router-suite migration** (`runtime-nodes/__tests__/runtime-node-router.test.ts`) — **four** shipped tests assert postures this task supersedes; skipping this file lands control-plane red. (a) `"runtimenode.heartbeat mounts and resolves to null (void -> null wire mapping)"` — its comment says _"No seeding needed: the first heartbeat upserts the presence row"_; heartbeat now 404s on a never-attached node, so it must seed participant → session → membership → active attachment for the stub caller. (b) `"runtimenode.capabilityupdate maps the no-active-attachment refusal to CONFLICT"` — that arm is now `NOT_FOUND`; re-point the test at the surviving `registering→online` state guard so the CONFLICT-mapping property it proves survives, and add a sibling asserting the no-active-row arm now maps to `NOT_FOUND`. (c) the attach test whose comment reasons _"an unseeded one would FK-throw INTERNAL_SERVER_ERROR"_ — that premise is superseded by the typed 404; reword and assert the 404. (d) every attach happy-path seeds the stub caller's membership. Note the harness's `caller` is a **single pre-built** caller over a fixed `resolveCurrentParticipantId` stub — the `callerAs(participantId)` helper from Step 6c is what varies identity here.
  8. **HTTP-suite migration** (`server/__tests__/host-runtime-node.test.ts`) — `"projects runtimenode.capabilityupdate_conflict as {code, message} (no details) — the T3.8-deferred sibling now projects via the base"` seeds nothing and expects `409` + `RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE`; under the 409→404 split that request now yields the typed 404. **Do not delete the test** — it is the sibling-projection oracle for the whole `AisWireException` family. Re-point it at the surviving `registering→online` 409 arm (seed an active `registering` attachment owned by the stub caller), and add a **new** HTTP-layer test asserting the no-active-row arm projects `404` + `RUNTIME_NODE_NOT_FOUND_CODE` with `data.httpStatus === 404`. This file is also where the byte-identical uniform-negative envelope oracle lives (Step 7).

- [ ] **Step 13: Move BL-141 to the archive.** Remove the BL-141 entry from `docs/backlog.md`; append to `docs/archive/backlog-archive.md` under `## Completed: <merge date>` with a closure note: exit (a)–(d) met via ADR-025 + Spec-003 rows + Plan-003 T3.10–T3.12 + enforced code; production-live automatically at Plan-008 R1 (the identity substrate). **State the two refinements explicitly** (Design §4.A decisions 7 + 4): (i) the unauthorized roster read returns the typed `runtimenode.not_found` (404) rather than a 403, because a 403 would make `roster` a session-existence oracle; (ii) cross-session `detach` refuses via its shipped idempotent `null` no-op rather than a typed error — the per-procedure uniform negative, since a `NOT_FOUND` there would itself be the oracle. Both are deliberate readings of exit (c)/(d)'s "typed authorization error" letter, ratified in ADR-025, not silent narrowings. Cites PR-A1/PR-A1p/PR-A2.

- [ ] **Step 14:** SPP-3/4/5/6. Test Plan in the body enumerates, by name: the IDOR cases across the three layers (service / router / HTTP-envelope oracle); the uniform-negative oracle assertions (detach `null`, heartbeat/capabilityupdate 404, roster 404, attach 404 — one per procedure); and the Step-12 superseded-posture updates (the signature migration, the attach-happy-path membership seeding, the heartbeat ingest presence-forgery rewrite, the three capabilityupdate 409→404 flips, the roster split, the client-SDK leg) — flag each as the ratified Spec-003 contract change, not regression masking. Subject `feat(control-plane): enforce runtime-node caller-ownership (plan-003)`; trailer `Refs: Plan-003, ADR-025, BL-141`. Title carries the `Plan-003` token (lane 1).

---

### Task 5: PR-B1 — Unit B docs (BL-133)

**Design contract:** §4.B (decisions 1–9), §3.2 ground truth.

**Files:**

- Modify: `docs/specs/002-invite-membership-and-presence.md` (Status → `review`; §Interfaces And Contracts `invite.preview` contract + two-tier error pin + a note that the five invite refusals now project onto the `aisError` envelope with their error-contracts §Invite HTTP statuses; dated Amendment block).
- Modify: `docs/architecture/contracts/api-payload-contracts.md` (add `InvitePreviewRequest`/`InvitePreviewResponse` beside the Tier-2 invite trio; method-name registry note — flag the doc's `Invite*Request/Response` names vs code's `InviteCreate/InviteAccept/InviteRevoke` skew, don't silently reconcile).
- Modify: `docs/specs/021-rate-limiting-policy.md` (Status → `review`; add the `invite.preview` registry row).
- Modify: `docs/specs/023-desktop-shell-and-renderer.md` (§Deep-Link Invite Flow — one-line resolution pointer to Spec-002's new contract; stays `approved` — clarifying cross-ref).
- Modify: `docs/architecture/cross-plan-dependencies.md` (disambiguation lines: the invite **control-plane tRPC router** is Plan-002-owned and ships now; the **daemon-side invite leg** — IPC handlers + live control-plane caller — is Plan-008's Tier-5 join/relay handoff).
- Modify: `docs/plans/008-control-plane-relay-and-session-join.md` (I-008-4 gated-endpoint list gains `invite.create`/`invite.accept`/`invite.revoke` + `invite.preview`'s recorded anonymous exclusion; the Tier-5 scope bullet names the daemon invite IPC leg; Plan-008 stays `review` — amendment declared in the PR body).
- Modify: `docs/architecture/contracts/error-contracts.md` (§Error Response Shape mechanism note: the `AIS_WIRE_HTTP_STATUS_OVERRIDES` delivery path for non-native HTTP statuses + the named future registrants).
- Modify: `docs/plans/002-invite-membership-and-presence.md` (Status → `review`; new Phase-2 tasks T2.6/T2.7/T2.8; new **CP-002-9** §Cross-Plan Obligations entry; re-open audit checkbox scoped to the new tasks; §Progress Log note).
- Modify: `README.md` (census: Plan-002 + Spec-002 + Spec-021 → `review`; re-derive counts).

**Interfaces:** Produces the `invite.preview` contract + response shape + error posture + the invite-router ownership disambiguation that PR-B2's code and reviews are conducted against.

- [ ] **Step 1:** SPP-1 name=`b1-invite-docs`, branch=`docs/bl-133-invite-preview`.
- [ ] **Step 2:** Author the Spec-002 §Interfaces `invite.preview` contract: request `{ token }`; response `{ joinMode, expiresAt, sessionName: string | null, inviterDisplayName: string | null }` (raw UUIDs excluded; null fields documented Plan-018-fed / session-name-fed); explicitly non-consuming (idempotent — the single-use token survives); row-first-then-expiry error order matching accept (Design §4.B decision 1); two-tier errors reusing the §Invite vocabulary (uniform `invite.not_found` for garbage/unknown; distinct expired/revoked/already_accepted for MAC-valid). Add the note that the five invite refusals now project onto `aisError` (the migration to `AisWireException`) with their §Invite HTTP statuses, expired/revoked at 410 via the override map (Design §4.B decision 8). Dated Amendment block; flip Status `review`.
- [ ] **Step 3:** Add the api-payload-contracts `InvitePreviewRequest`/`InvitePreviewResponse` interfaces beside the existing invite trio (Design §4.B decision 3 shapes); note the `invite.preview` method under the already-reserved `invite` namespace root. Add the error-contracts §Error Response Shape **mechanism note** (Design §4.B decision 8, fourth bullet): registry codes whose pinned HTTP status has no native tRPC code are delivered via `AIS_WIRE_HTTP_STATUS_OVERRIDES` (`@ai-sidekicks/contracts` `error.ts`) — the `errorFormatter` stamps `data.httpStatus`, the host `responseMeta` lifts `response.status`, unmapped codes ride their carrier code's native status; name the future registrants (`artifact.relay_expired` with Plan-014 Tasks 7–10; `approval.request_expired` only if it gains a control-plane tRPC surface — its V1 surface is daemon JSON-RPC where §JSON-RPC Wire Mapping governs).
- [ ] **Step 4:** Add the Spec-021 registry row (Design §4.B decision 5 values); flip Status `review`. Re-derive the registry row count.
- [ ] **Step 5:** Add the Spec-023 §Deep-Link resolution pointer (declare in the PR body: clarifying cross-ref, Spec-023 stays `approved` per the runbook default rule). Add the cross-plan-dependencies disambiguation line (declare: runbook:218 re-audit trigger does not fire — clarification, not an ownership change). Add the **Plan-008 edits** (Design §4.B decisions 6/9): the I-008-4 gated-endpoint list gains `invite.create`/`invite.accept`/`invite.revoke` (the §4.A decision-9 mirror — the three authenticated procedures PR-B2 makes reachable through the merged host), with `invite.preview` recorded in the invariant text as **deliberately excluded** (anonymous by design per §4.B decision 1; token entropy + the Spec-021 anonymous per-token-hash row carry its protection); widen the Tier-5 scope bullet ("Invite-acceptance handoff") to name the daemon-side invite IPC leg + live control-plane caller (decision 6 surface (c)). Declare in the PR body: invariant-list completion + scope naming, Plan-008 already `review` so no additional flip; plus the observation for Plan-008's next readiness re-audit that the Tier-1 session-directory procedures' Tier-5 gating disposition rides I-008-1's allow-list-widening obligation (pre-existing, not adjudicated by this campaign).
- [ ] **Step 6:** Add Plan-002 Phase-2 tasks (acceptance criteria tracing to the Spec-002 rows), matching PR-B2's task decomposition (Design §4.B doc deliverables): **T2.6** (relocate `INVITE_*_CODE` to `contracts/src/error.ts` + the `AIS_WIRE_HTTP_STATUS_OVERRIDES` map + the `InvitePreview{Request,Response}` schemas + `previewInvite`), **T2.7** (migrate the five invite exceptions to `AisWireException` + `invite-router.factory.ts` + host merge + the `errorFormatter`/`responseMeta` 410 override), **T2.8** (test suite incl. the HTTP-layer envelope oracle). Append **CP-002-9** to §Cross-Plan Obligations (the established CP-002-1..8 pattern): the daemon-side invite leg — the `invite.*` IPC handlers under `packages/runtime-daemon/src/ipc/handlers/`, the live control-plane caller they delegate to, and `membershipClient.preview` — is consumed from Plan-008-remainder Tier 5 (join/relay handoff); Plan-002's T2.6–T2.8 own the control-plane tRPC transport only; the renderer's `NotImplementedAtTier1Error` posture stands until that leg lands; cross-ref the cross-plan-dependencies disambiguation lines. The daemon IPC handlers + live control-plane caller are **not** Plan-002 tasks here — they are Plan-008 Tier-5. Flip Status `review`; re-open the audit checkbox scoped to the new tasks; fold audit-delta evidence into a §Progress Log note.
- [ ] **Step 7:** README census (Plan-002 + Spec-002 + Spec-021 → `review`; counts re-derived). Merge-serialize vs PR-A1 (rebase census lines if PR-A1 landed first).
- [ ] **Step 8:** SPP-3 docs gates + `/ripple-check`. SPP-4 with `plan-execution-spec-reviewer`. SPP-5/6 — subject `docs(repo): spec-002 non-consuming invite.preview + wire contract`, body declares the three `review` flips + the two clarifying-only edits + the Plan-008 amendment (already `review`) + the error-contracts mechanism note + census ripple; trailer `Refs: Spec-002, Spec-021, Spec-023, Plan-002, Plan-008, BL-133`.

---

### Task 6: PR-B1p — Spec-002 + Spec-021 + Plan-002 re-promotion

**Files:** Modify: `docs/specs/002-…` + `docs/specs/021-…` + `docs/plans/002-…` (`review` → `approved`; tick Plan-002's re-opened audit checkbox); `README.md` (census restore).

- [ ] **Step 1:** SPP-1 name=`b1p-invite-promote`, branch=`docs/bl-133-promote`.
- [ ] **Step 2:** Flip all three to `approved`; tick the audit checkbox. PR body cites runbook §Spec-Status Promotion Gate by name + PR-B1 delta evidence (T2.6–T2.8 trace to the amended Spec-002 rows; dep-closure terminal; no gating open questions). For the Plan-002 half, also satisfy the **plan-side** §Status Promotion Gate elements (runbook:210–214): cite the Tier-2 audit-completion date + the `plan-readiness-audit-tier-2-complete` tag.
- [ ] **Step 3:** Restore README census.
- [ ] **Step 4:** SPP-3/4/5/6 — subject `docs(repo): re-promote spec-002 + spec-021 + plan-002 (invite delta)` (68 chars — `commitlint` `header-max-length` is 72; do not re-expand to `invite.preview delta`), trailer `Refs: Spec-002, Spec-021, Plan-002, BL-133`.

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
- Modify: `packages/control-plane/src/server/host.ts` (merge the invite router; `ControlPlaneDeps` gains `InviteRouterDeps`; add `responseMeta` reading the override map for transport status; wire a placeholder invite service in the production default export).
- Modify: `packages/control-plane/src/index.ts` (export the invite router factory if the session router is exported similarly).
- Test: `packages/control-plane/src/invites/__tests__/invite-router.test.ts` (create → preview → accept round trip; router-level exception→tRPC-code mapping) + `invite-service.test.ts` (the `INVITE_*_CODE` import-path fix + preview cases).
- Create: `packages/control-plane/src/server/__tests__/host-invite.test.ts` (HTTP-layer envelope oracle: per refusal `response.status` + `data.httpStatus` + `data.aisError.code`; expired/revoked at **410 on both**).
- Modify: `docs/backlog.md` + `docs/archive/backlog-archive.md` (move BL-133).

**Deliberately NOT in this task (Design §4.B decisions 4/6 — Plan-008 Tier-5 relay leg):** the daemon IPC invite handlers (`packages/runtime-daemon/src/ipc/handlers/invite-*.ts`) and `membershipClient.preview`. No daemon invite handler exists today and the daemon has no live control-plane caller; building a handler now only relocates the renderer's `NotImplementedAtTier1Error` to a handler delegating to a deferred caller (no usable capability, plus renderer-test churn). They land with the live caller at Tier-5.

**Interfaces:**

- Consumes: `InviteService` (shipped), the file-scope `decryptV4Local` / `decodeClaims` / `isExpiredClaim` + the inline `createHash("sha256")…` idiom (shipped in `invite-service.ts`), the `AisWireException` base + `errorFormatter`, the runtime-node router + host-merge precedents.
- Produces: `previewInvite(request: InvitePreviewRequest): Promise<InvitePreviewResponse>` (anonymous — **no** caller param, unlike `acceptInvite(participantId, request)`); `createInviteRouter(deps): InviteRouter`; the five invite exceptions now `extends AisWireException`; the relocated `INVITE_*_CODE` + `AIS_WIRE_HTTP_STATUS_OVERRIDES` in `@ai-sidekicks/contracts`.

- [ ] **Step 1:** SPP-1 name=`b2-invite-code`, branch=`feat/plan-002-invite-preview`.

- [ ] **Step 2: Relocate the invite codes + add the override map (Design §4.B decision 8).** Write the failing `error.test.ts` block first (invite-code literals + `startsWith("invite.")` + `AIS_WIRE_HTTP_STATUS_OVERRIDES` completeness), run → FAIL, then add to `contracts/src/error.ts` the five `export type InviteXxxCode = "invite.xxx"` + `export const INVITE_XXX_CODE: InviteXxxCode = "invite.xxx"` pairs (explicit annotations, TS9010) beside the runtime-node siblings, plus:

```ts
// Domain codes whose error-contracts.md §Invite HTTP status is NOT expressible
// as a native tRPC error-code key (tRPC has no 410 Gone member). The control-
// plane tRPC host reads this in BOTH the errorFormatter (envelope data.httpStatus)
// and the fetch handler's responseMeta (transport status) to deliver the contract
// status. Every entry MUST match error-contracts.md §Invite.
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

→ FAIL. Add `InvitePreviewRequestSchema` (`{ token: z.string() }`, `.strict()`) / `InvitePreviewResponseSchema` (`joinMode` = the shared `JoinMode` schema from `presence.ts`; `expiresAt` = `z.string()`; `sessionName`/`inviterDisplayName` = `z.string().nullable()`; `.strict()`) + inferred types (explicit annotations). → PASS.

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
  await expect(ctx.service.previewInvite({ token: "garbage" })).rejects.toBeInstanceOf(
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

- [ ] **Step 8: Wire the 410 override + merge the router (Design §4.B decision 8).** In `sessions/trpc.ts` `errorFormatter`, inside the existing `cause instanceof AisWireException` branch, add `data.httpStatus` from the override map when present:

```ts
const override = AIS_WIRE_HTTP_STATUS_OVERRIDES[cause.code];
const data =
  override !== undefined
    ? { ...shape.data, aisError, httpStatus: override }
    : { ...shape.data, aisError };
return { ...shape, data };
```

In `host.ts`: `t.mergeRouters(createSessionRouter(deps), createRuntimeNodeRouter(deps), createInviteRouter(deps))`; add `InviteRouterDeps` to `ControlPlaneDeps`; wire a placeholder invite service in the production default export (beside the attach/heartbeat placeholders); and add `responseMeta` to the `fetchRequestHandler` call:

```ts
responseMeta({ errors }) {
  for (const error of errors) {
    const cause: unknown = error.cause;
    if (cause instanceof AisWireException) {
      const override = AIS_WIRE_HTTP_STATUS_OVERRIDES[cause.code];
      if (override !== undefined) return { status: override };
    }
  }
  return {};
}
```

- [ ] **Step 9: Write the router test + the HTTP-layer envelope oracle.** In `invite-router.test.ts` (mirror the runtime-node router harness): a create → preview → accept round trip over the in-process tRPC caller against PGlite; assert preview returns the bounded shape and does not consume; assert a revoked-token preview throws `TRPCError` with `.cause instanceof InviteRevokedException`. In `host-invite.test.ts` (mirror `host-runtime-node.test.ts`): drive `buildControlPlaneFetchHandler`; assert an expired-token and a revoked-token preview each return `response.status === 410`, `body.error.data.httpStatus === 410`, and `body.error.data.aisError.code` = `invite.expired` / `invite.revoked`; assert a not-found preview returns 404. Run → PASS.

- [ ] **Step 10:** Full `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 11: Move BL-133 to the archive.** Remove from `backlog.md`; append to the archive with the closure note: exit (a) **met** (the Spec-002 contract, exceeded — full invite router + hardened `aisError`/410 envelope, not just the preview contract); exit (b) **met-as-refined** — the endpoint ships on the **control-plane tRPC transport**; its daemon-as-gateway clause (ADR-008 surface, mirroring the `invite.accept` wire registration) is reassigned to **Plan-008 Tier-5** via Plan-002 **CP-002-9** (an obligation entry; the implementation task lands with Plan-008's Tier-5 leg). Name the **two** remaining hand-offs, each another plan's own step: the daemon-integration leg (IPC handlers + live control-plane caller) is **Plan-008 Tier-5**; exit (c) (Plan-023 Tier-8 deep-link consumption + two-client smoke) is **Plan-023 Tier-8**. Cites PR-B1/PR-B1p/PR-B2.

- [ ] **Step 12:** SPP-3/4/5/6. Test Plan enumerates the non-consumption invariant, two-tier uniformity (tampered vs unknown-hash → `invite.not_found`), per-lifecycle-state preview, the HTTP-layer 410 envelope oracle, and the now-reachable create/accept/revoke wire path. Subject `feat(control-plane): invite.preview + invite wire transport (plan-002)` (70 chars — `commitlint` `header-max-length` is 72, so "non-consuming" lives in the body, not the subject); body declares the non-consumption invariant, the Plan-008 Tier-5 daemon-leg deferral + the cross-plan `trpc.ts`/`host.ts` edits (map-guarded, zero shipped-behavior change). Trailer `Refs: Plan-002, Spec-002, BL-133`. Title carries `Plan-002` (lane 1).

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
- Modify: `.github/workflows/ci.yml` (new advisory `coverage` job — non-required; `--coverage`; davelosert action SHA-pinned once per package; `actions/upload-artifact`).
- Modify: `turbo.json` (a `test:coverage` task or `outputs` for `coverage/**`, per §3.4 — keep the required `test` task fast/cached; coverage runs fresh).
- Modify: `docs/backlog.md` (BL-123 → `in_progress`; protocol + pointers).
- Modify: `docs/decisions/023-v1-ci-cd-and-release-automation.md` (§Decision Log entry: advisory coverage job design — the durable home once BL-123 archives).
- Modify: `.claude/skills/plan-execution/references/failure-modes.md` (ride-along: "CLAUDE.md doc-first" → AGENTS.md §Doc-First Discipline).

**Interfaces:** Consumes the workspace catalog + per-package vitest configs. Produces per-package `coverage/` artifacts + a PR-comment surface.

- [ ] **Step 1:** SPP-1 name=`d-coverage`, branch=`chore/coverage-measurement-substrate` (NON-plan-scoped — lane 3).
- [ ] **Step 2:** Bump the `testing` catalog to exact `4.1.10` + add `@vitest/coverage-v8: 4.1.10`; `pnpm install`; confirm `pnpm-lock.yaml` resolves both at `4.1.10` (peer-pin satisfied).
- [ ] **Step 3:** Add the `coverage` block to each package `vitest.config.ts` (`provider: 'v8'`, `reporter: ['text','json','json-summary','lcov']`, `reportOnFailure: true`, no `enabled`, no thresholds); desktop config scopes coverage to the `renderer` project only (exclude the `main` Electron-spawning project). Add the coverage devDep to each package `package.json`.
- [ ] **Step 4:** Verify locally: `pnpm --filter @ai-sidekicks/contracts exec vitest run --coverage` emits `coverage/coverage-summary.json` + `lcov.info`; the required `pnpm test` (no `--coverage`) is unchanged (control-plane PGlite timeouts untouched). **Desktop is special**: its `test` script nests `turbo run test:renderer test:smoke`, and the `main`/smoke project spawns a real Electron binary (not in-process-instrumentable). Invoke desktop coverage as `pnpm --filter @ai-sidekicks/desktop exec vitest run --project=renderer --coverage` — the renderer project only; never `pnpm --filter @ai-sidekicks/desktop test --coverage` (that would drag in the un-instrumentable smoke project).
- [ ] **Step 5:** Add the advisory `coverage` job to `ci.yml` (NOT in the `ci-gate` `needs` list — non-required). **Mirror the required suite's Node split** (`test-node22` runs `--filter='!@ai-sidekicks/control-plane'`; `test-node24` runs `--filter='@ai-sidekicks/control-plane...'`): the coverage job runs control-plane on Node 24 and every other package on Node 22, so instrumentation never changes a package's Node tier. `--coverage` (desktop via `--project=renderer`); `davelosert/vitest-coverage-report-action@<SHA>` once per package with a unique `name` + `permissions: pull-requests: write`; `actions/upload-artifact` for `lcov.info` + `coverage-final.json`. Verify `ci-gate`'s `needs` still lists only `[test-node22, test-node24, hook-tests-macos]` (coverage stays out).
- [ ] **Step 6:** Fix the `failure-modes.md:171` pointer (ride-along).
- [ ] **Step 7:** Update BL-123: Status `in_progress`; record the ≥5-PR baseline protocol (Overall per package + Delta per PR; floors = observed-min − buffer tiered by criticality; Google FSE 2019 + Testing Blog 2020 citations for the eventual threshold ADR) + durable artifact pointers; **reconcile exit (a)'s wording** — it says "installed in root `package.json` devDependencies," but the correct pnpm-workspace mechanism (what this PR ships) is the `testing` catalog pin + per-package `catalog:testing` devDeps; rewrite exit (a) to the catalog mechanism (same BL-wording-fix treatment as BL-122's `TURBO_TOKEN` correction). Add the **ADR-023 §Decision Log entry** recording the advisory coverage job's design (non-required advisory job mirroring the required suite's Node split; `davelosert` reporter action SHA-pinned; thresholds deliberately deferred pending the ≥5-PR baseline — BL-123 owns the protocol; the eventual threshold policy is a separate future decision, BL-123 exit (c)/(d)) — ADR-023 is the CI/CD architecture owner and the durable home once BL-123 archives (Design §4.D).
- [ ] **Step 8:** Full `pnpm typecheck && pnpm lint && pnpm test`; `.claude/**` eslint (subdir `.mjs` node globals). SPP-3/4/5/6. Subject `chore(repo): wire vitest v8 coverage measurement substrate`; body declares lane 3 + the flag-gated advisory-job design; `Refs: BL-123, ADR-023`. No plan token.

---

### Task 10: PR-E — Unit E remote-cache experiment + doc fixes (lane 3)

**Design contract:** §4.E; §3.5 ground truth.

**Files:**

- Modify: `turbo.json` (add `"remoteCache": { "signature": true }`).
- Modify: `.github/workflows/ci.yml` (SHA-pinned `rharkor/caching-for-turbo` step in both test jobs; `TURBO_REMOTE_CACHE_SIGNATURE_KEY` env from secret; `--remote-cache-read-only` on `pull_request`; job-scoped `permissions: actions: write`).
- Modify: `docs/backlog.md` (BL-122 References §Axis 2 → §Axis 1; record the measurement window).
- Modify: `docs/decisions/023-v1-ci-cd-and-release-automation.md` (§Decision Log entry: rharkor provider adjudication + "deployed" → decided-now-implemented correction).

**Interfaces:** Consumes GitHub Actions cache + `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (executor-set secret, Step 5). Produces a warm-cache CI path measurable against the 218–223s baseline.

- [ ] **Step 1:** SPP-1 name=`e-remote-cache`, branch=`chore/turbo-remote-cache-experiment` (NON-plan-scoped — lane 3).
- [ ] **Step 2:** Add `"remoteCache": { "signature": true }` to `turbo.json`.
- [ ] **Step 3:** Add the `rharkor/caching-for-turbo@<commit-SHA>` step (pin to a SHA, not `@v2.5.0`) before the turbo run in `test-node22` + `test-node24`; append `--remote-cache-read-only` on `pull_request` events (`${{ github.event_name == 'pull_request' && '--remote-cache-read-only' || '' }}`); add job-scoped `permissions: { contents: read, actions: write }`.

  **Declare `TURBO_REMOTE_CACHE_SIGNATURE_KEY` at `env:` on the JOB, not on the caching-action step.** GitHub Actions step-level `env:` is scoped to that one step and does not propagate forward, whereas the key is consumed later, by the `pnpm turbo run …` steps — Turborepo signs each uploaded artifact "using the value of the environment variable `TURBO_REMOTE_CACHE_SIGNATURE_KEY`" at run time (<https://turborepo.dev/docs/reference/configuration>, verified 2026-07-10). Putting it on the action step silently disables signing:

  ```yaml
  test-node24:
    permissions: { contents: read, actions: write }
    env:
      TURBO_REMOTE_CACHE_SIGNATURE_KEY: ${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}
    steps:
      - uses: rharkor/caching-for-turbo@<commit-SHA>
      - run: pnpm turbo run test ${{ github.event_name == 'pull_request' && '--remote-cache-read-only' || '' }}
  ```
- [ ] **Step 4:** Fix BL-122: References (§Axis 2 → §Axis 1) **and the Summary sentence's same miscite** ("ADR-023 §Axis 2 names Turborepo remote-cache…" — the cache text lives in §Axis 1; sweep both forms in one edit); **correct exit (a)'s `TURBO_TOKEN` reference** — `TURBO_TOKEN` is Vercel Remote Cache's bearer auth; the rharkor/GitHub-Actions-cache backend uses **only** the HMAC signature key `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (there is no `TURBO_TOKEN` in this design), so exit (a) names the wrong secret; **persist the 218–223s cache-cold baseline onto the BL** (today it lives only in these campaign docs — the measurement has no durable home otherwise); record the measurement window (≥5 PRs vs that baseline; <30% → revert + record). Add the ADR-023 §Decision Log entry (rharkor as the $0 GitHub-native provider; the "or equivalent" latitude is **ADR-022's** phrasing that the swap rides on, recorded here as a Decision Log entry; ducktors fails the $0 constraint; correct the "deployed" overstatement to decided-now-implemented).
- [ ] **Step 5:** **Set the repo secret (executor step, not an owner hand-off):** `openssl rand -hex 32 | gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY` (owner-authenticated `gh`; 32 random bytes hex-encoded; stdin keeps the value out of argv); verify with `gh secret list`. Only if GitHub refuses (HTTP 403 — token lacks repo admin) surface an owner ACTIONABLE in the PR body instead — until set, the cache is inert (uploads/downloads no-op safely). Then SPP-3 (docs gates on the `.md`; workflow YAML lints) / SPP-4 / SPP-5 / SPP-6. Subject `chore(repo): turbo remote-cache experiment via github actions cache`; body declares lane 3 + the fork-poisoning threat model + the keep-or-revert exit; `Refs: BL-122, ADR-023`. No plan token. **State the threat model honestly:** the controls that defend against fork cache-poisoning are GitHub withholding secrets from fork-originated workflows, the read-only `GITHUB_TOKEN` on `pull_request`, and `--remote-cache-read-only` on PR events. The HMAC is **not** one of them — Turborepo documents `remoteCache.signature` as artifact **integrity** verification and states it "is not a security feature" (same source as Step 3). ADR-023 §Axis 1's "HMAC ≥32 bytes" requirement is still met; only the rationale is corrected. Do not credit the signature with a security property upstream disclaims.
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
| control-plane | `invites/invite-router.factory.ts`, `runtime-nodes/classify-caller.ts`, `server/__tests__/host-invite.test.ts` | `runtime-nodes/{errors,attach-service,heartbeat-service,runtime-node-router.factory}.ts`, `invites/invite-service.ts`, `sessions/trpc.ts` (errorFormatter 410 override), `server/host.ts` (merge + `responseMeta`), `index.ts`, tests (`runtime-nodes/__tests__/{runtime-node-router,attach-service,heartbeat-service}.test.ts`, `server/__tests__/host-runtime-node.test.ts`, `invites/__tests__/invite-service.test.ts`) |
| runtime-daemon | — (invite IPC handlers deferred to Plan-008 Tier-5, Design §4.B decision 6) | — |
| client-sdk | — | `test/runtimeNodeClient.integration.test.ts` + `src/runtimeNodeClient.ts` comment sweep (Unit A roster-membership ripple; `membershipClient.preview` is Plan-008 Tier-5) |
| desktop | `renderer/src/runtime-node-attach/__tests__/*.test.tsx` (×4) | — |
| CI/tooling | — | `turbo.json`, `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, per-package `vitest.config.ts` + `package.json`, `.claude/skills/plan-execution/references/failure-modes.md` |
| Backlog | — | `backlog.md` (remove BL-141/BL-133; rewrite BL-131; update BL-123/BL-122; annotate BL-134), `archive/backlog-archive.md` (add BL-141, BL-133) |
| README | — | plan-status census (×4 flips + restores) |

## Self-review (writing-plans checklist)

- **Spec coverage:** every Design §4 unit maps to a task (A→2/3/4; B→5/6/7; C→8; D→9; E→10; closure→11). Design §6 archive actions are Task 4 Step 13 / Task 7 Step 11 / Task 8 Step 8. Design §7 corpus scan is Task 11.
- **Placeholders:** code steps carry actual code (the predicate helper, the router shape, the preview method with real symbols, the test bodies against the real harness); doc steps name the exact file + section + status transition. No "TBD"/"handle edge cases".
- **Type consistency:** `RUNTIME_NODE_PERMISSION_DENIED_CODE` / `RUNTIME_NODE_NOT_FOUND_CODE` / `RuntimeNodePermissionDeniedException` / `RuntimeNodeNotFoundException` / `RuntimeNodeCallerVerdict` / `classifyRuntimeNodeCaller` (typed `transaction: Querier`, the real transaction-callback type — there is no `Queryable`) / `previewInvite` / `InvitePreviewRequestSchema` / `InvitePreviewResponseSchema` / `createInviteRouter` / the five migrated invite exceptions (`extends AisWireException`) / `AIS_WIRE_HTTP_STATUS_OVERRIDES` used identically across their tasks. **All five runtime-node service methods take `callerParticipantId` as the first parameter; `previewInvite` takes NO caller (it is anonymous, unlike `acceptInvite(participantId, request)`).** The deferred daemon symbols (`register*` handlers, `membershipClient.preview`) are intentionally absent — Plan-008 Tier-5. (A pre-landing review pass replaced an earlier hedged `assertCallerOwnsNode` throw-helper with the `classifyRuntimeNodeCaller` verdict enum — a throw-helper cannot express per-procedure uniform negatives, the oracle-closing requirement.)
- **Adversarial pass (design defects caught pre-landing, recorded so they are not reintroduced):** (1) a global "cross-session → 404" rule would have left `capabilityupdate` answering 409-for-absent vs 404-for-hidden — an existence oracle on guessable `node_id`s; fixed by the per-procedure uniform-negative rule. (2) `detach`'s shipped idempotent `null` no-op means its uniform negative is `null`, not an error — an earlier draft's `NOT_FOUND` assertion would itself have been the oracle. (3) **`attach` was mis-scoped as "regression tests only."** It has two authorization axes: the node-identity axis (b, owner-immutability upsert) IS shipped, but the **session-membership axis (a) was never enforced** — a non-member attach silently created a row (write-IDOR) and a nonexistent-session attach raised a raw FK-500. The hardened plan builds the axis-a guard now (Task 4 Step 10) and keeps axis-b as regression tests. (4) **The invite exceptions `extends Error`, not `AisWireException`** — so the tRPC surface would project no `aisError` at all; the migration (Task 7 Step 3) is the fix, and error-contracts §Invite's 410 for expired/revoked is undeliverable by stock tRPC, so decision 8 adds the contracts-owned `AIS_WIRE_HTTP_STATUS_OVERRIDES` + the `errorFormatter`/`responseMeta` override (verified against tRPC v11). (5) **`previewInvite`'s error order** must be row-first-then-expiry (mirroring the shipped `acceptInvite`), and it uses the REAL file-scope symbols `decryptV4Local`/`decodeClaims`/`isExpiredClaim`/`createHash` — an earlier draft had expiry-before-row and invented `#decryptAndParseClaims`/`sha256Hex`. (6) **The IDOR test harness was fictional** — `callerAs`/`rawAttachmentRow`/`invoke` do not exist, and the in-process `createCaller` surfaces `.code`+`.cause`, NOT `data.aisError` (which only materializes over the HTTP handler); the plan now adds the real helpers (Task 4 Step 6c) and asserts per layer (service/router/HTTP). Its service-level blocks were also written against the router suite's harness while targeting `attach-service.test.ts`/`heartbeat-service.test.ts`, which use a different `ctx = { pg, querier, service }` idiom — restated per destination file (Step 7). (7) **`classify`-then-mutate was a TOCTOU hole on two procedures.** `detach` and `heartbeat.ingest` resolved their attachment row **unlocked**; under READ COMMITTED a concurrent detach+re-attach can swap in another participant's row between the classify and the mutation, so the stale verdict authorizes a wrong-owner retire / forged presence write — re-opening the exact holes this campaign closes. Both now `SELECT … FOR UPDATE` (and `detach` carries `participant_id` in its UPDATE `WHERE`), and `classifyRuntimeNodeCaller`'s doc comment states the lock as a **caller contract** rather than claiming a universal "no TOCTOU window." (8) **The uniform-negative invariant was overstated and self-refuting.** `idx_node_attachments_active` is globally unique on `node_id`, so `attach`'s surviving 409 `attach_conflict` discloses one bit about any guessed `node_id` — the shipped error-contracts row for it says so in plain text. The invariant is now scoped to the four `nodeId`-keyed procedures and the residual channel is recorded in ADR-025 with its mitigation and revisit criterion; a Type-2 ADR must carry its own counterexample. (9) **`previewInvite` omitted the persisted-`expired` rung** that `acceptInvite` keeps deliberately — a swept-but-unexpired-claim row would have previewed as healthy-pending while accept refused it, the precise posture divergence decision 1 forbids. (10) **The invite fixtures were mis-typed**: `seedInvite` takes `tokenHash`, not `token`; `mintInviteToken` requires `expiresAt`; `MintedInvite` has no `expiresAt`. All three corrected against the live suite. (11) **README carries a spec census beside the plan census** — flipping only the plan line would land a README contradicting Spec-003's own header (Tasks 2/3 now flip and restore both). (12) **The owner verdict short-circuited the membership check.** `classifyRuntimeNodeCaller` returned `"owner"` on `row.participant_id === callerParticipantId` _before_ querying `session_memberships`, so a `suspended`/`revoked` participant kept heartbeating, updating capabilities, and detaching in a session they had left — the attachment row carries its creator's `participant_id` forever, and `MembershipService.updateMembership` ships `suspend`/`revoke` today. The membership query now gates every verdict, and the verdict is 4-valued. (13) **Fixing (12) naively would strand nodes permanently.** `idx_node_attachments_active` is globally unique on `node_id`, so denying a revoked owner `detach` leaves the slot occupied for all sessions, forever, with no actor able to free it. The tempting reaper — retiring attachments inside `MembershipService.updateMembership` — is **forbidden by shipped Plan-003 I-003-3** ("`MembershipUpdate` MUST NOT trigger runtime-node detach as a side effect") and would usurp the deferred Cedar-gated `revoked` producer. Resolved inside the runtime-node domain instead: `owner_inactive_member` may `detach` (self-service release) and nothing else, giving daemons a `409 → self-detach → re-attach` recovery path. (14) **Adding attach's membership lock naively would deadlock.** With `detach`/`heartbeat`/`capabilityupdate` locking the attachment row first and then reading membership, while `attach` locks membership then inserts the attachment, the two orders form an ABBA cycle on a shared `node_id`. The repo already pins a canonical order (I-002-4: `sessions` → `session_memberships`, enforced by `lock-ordering.test.ts`); this campaign extends it to a third level (I-003-6) and pays for it with a two-phase resolve plus a post-lock re-verify. (15) **`FOR KEY SHARE` would have been a silent no-op.** It does not conflict with the `FOR NO KEY UPDATE` that `UPDATE session_memberships SET state = 'revoked'` acquires, so it would have "locked" nothing against the exact race it was added to close; `FOR SHARE` is the weakest mode that conflicts (PostgreSQL Table 13.3). (16) **The migration list omitted two suites that assert superseded contracts** — `runtime-node-router.test.ts` ("No seeding needed: the first heartbeat upserts the presence row"; `capabilityupdate` no-active-row → `CONFLICT`) and `host-runtime-node.test.ts` (unseeded `capabilityupdate` → 409 + `capabilityupdate_conflict`). Both are now enumerated (Step 12 items 7-8), and the projection oracle is **re-pointed, not deleted**. (17) **`seedAttachment` is FK-backed**, contradicting the plan's own "needs no parent rows today" — the suite's helper comment and its one call site both seed `participants` + `sessions` first. (18) **The signature key was scoped to the wrong workflow step** (GitHub step `env:` does not propagate), and the HMAC was credited with a fork-poisoning defense that Turborepo's own docs disclaim ("not a security feature"). Both corrected.
- **Lane mechanics:** every code/test/tooling task states its lane + the title-token + branch-shape consequence (lane 1 → token + `plan-NNN` branch; lane 2/3 → no token + non-plan branch) — the CI-enforced boundary the `lane-boundary` job checks.
- **Wiring completeness (anti-orphaning):** every net-new mechanism has a durable governance home a future implementer will actually read, and every deferral has a named owner recorded inside the owning plan — nothing ships discoverable only from this campaign doc. The map: runtime-node authz (ADR-025 + Spec-003 + error-contracts §Runtime Node + Plan-003 T3.10–12); attach membership guard (same set); `invite.preview` (Spec-002 + api-payload-contracts + Spec-021 row + Plan-002 T2.6); invite router + host merge (Spec-002 + Plan-002 T2.7 + cross-plan-dependencies + Plan-008 I-008-4, which gains invite create/accept/revoke so Tier-5 PASETO gating cannot skip them — preview's anonymous exclusion recorded); `AisWireException` migration (Spec-002 note + Plan-002 T2.7); `AIS_WIRE_HTTP_STATUS_OVERRIDES` + 410 delivery (error-contracts §Error Response Shape mechanism note naming the future registrants `artifact.relay_expired` / `approval.request_expired` + Plan-002 tasks); coverage substrate (ADR-023 §Decision Log entry + BL-123 protocol); remote cache (ADR-023 §Decision Log entry + BL-122); renderer component tests (Plan-003's seven BL-131 mention flips); the daemon invite leg deferral (Plan-002 **CP-002-9** + Plan-008 Tier-5 scope bullet + cross-plan-dependencies lines — three surfaces, decision 6). Verified at closure by Task 11 Steps 1–3.

## Progress Log

- 2026-07-10 — **Campaign-start SHA recorded (Task 1 Step 1): `29a88b8b495f33ee4784ffba39fd23d35fe14d91`** (`develop` == `origin/develop` at recording time). Task 11 Step 4's closure `/ripple-check --target=29a88b8` consumes this — never `--target=develop`, which would see an empty diff post-merge.
- 2026-07-10 — **Task 1 complete** (PR #201, `docs/bl-resolution-campaign`). Codex review round 1 returned 9 findings (1×P1, 8×P2); all were verified against the live tree and applied to this plan + the design before merge. The P1 (`classifyRuntimeNodeCaller`'s owner short-circuit bypassing the membership check) surfaced two ripples the review did not name: the **permanent node-lockout** that a naive fix creates under the global `node_id` unique index, and the **lock-order cycle** that a naive membership lock creates against the shipped I-002-4 order. Both are resolved in Design §4.A decisions 1 and 3, and pinned by the new **I-003-6** invariant. Self-review items (12)-(18) record the whole set so they cannot be reintroduced.
