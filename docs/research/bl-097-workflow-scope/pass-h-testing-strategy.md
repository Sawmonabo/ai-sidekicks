# BL-097 Pass H — V1 Testing + Verification Strategy

**Date:** 2026-04-22
**Task:** Wave 2 Pass H — design the V1 test strategy that verifies the 16 contract commitments (C-1..C-16) and 7 security invariants (I1..I7) landed by Wave 1 (see `wave-1-synthesis.md`, `pass-e-security-surface.md`). Frameworks in use: `vitest` (primary), `fast-check` (property-based), `@playwright/test` (integration). Proposing `@jazzer.js/core` as the fuzzing layer (§3).
**Audience:** Spec-017 rewrite owner, Plan-015 (persistence+recovery) owner, and implementer agent (Claude Opus 4.7) starting Plan-001.

---

## §1 Test Category Overview

Five test categories. Each carries a V1 *ambition level* — what "done enough to ship" means — so the implementation agent can stop-mark a category rather than chase open-ended coverage. Ambition levels: **Foundational** (the invariant is testable and the test exists), **Hardened** (the invariant is tested under adversarial inputs and concurrency), **Continuous** (the invariant is exercised in a scheduled job beyond merge-blocking).

| Category | Covers | V1 Ambition | CI Cadence |
|---|---|---|---|
| Property-based | DAG invariants (acyclicity, ready-set determinism, iteration caps, parallel-join semantics) | **Hardened** | PR + merge (100 runs); nightly (10 000 runs) |
| Fuzz | Workflow-definition parser, expression grammar (I2), secrets resolver (I4) | **Foundational+**: 15-min CI fuzz per target per PR; nightly 2h per target | PR (15m) + nightly (2h) |
| Load | Parallel executor under contention, resource-pool admission, SQLite write-amp | **Foundational**: baseline regression only; no SLO gating in V1 | Nightly |
| Long-running integration | Multi-day `human` phase resume, checkpoint/replay, multi-agent channel lifecycle | **Hardened** | Nightly (compressed-time) + weekly (real-time) |
| Security regression | I1–I7, every CVE in Pass E §2.2 has a regression row | **Hardened**: full battery gates merge | PR + merge |

The deliberate scope exclusion: no multi-tenant / server deploy load tests (out of V1 per Pass E §1.3). No Electron-renderer security tests in Pass H — Plan-001 handles the Electron surface.

---

## §2 Property-Based Tests

Target framework: `fast-check` (`/websites/fast-check_dev`, v3.x). Stateful properties use `fc.commands` + `fc.modelRun` (see §9 citation [1]), which shrink intelligently on command sequences. For every property below, `numRuns` is stated — the PR-gate budget (fast) and the nightly budget (thorough).

### §2.1 DAG acyclicity under concurrent submit

**Statement (verifies C of §3.1 scheduling and I2 indirectly):** For any workflow definition `D` and any interleaved set of `WorkflowDefinitionCreate` calls from ≥2 concurrent submitters, if the resulting definition is accepted, the committed graph is acyclic.

**Generator strategy:** `fc.record({ phases: fc.array(phaseArb, { minLength: 1, maxLength: 30 }), edges: fc.array(edgeArb) })` where `edgeArb` can produce back-edges; apply `fc.commands` with `SubmitDefinitionCmd` + `ModifyDefinitionCmd` to simulate race.

**Assertion:** after arbitrary interleaving, either (a) all submissions rejected with `CYCLIC_DEFINITION` or (b) the committed graph passes the DFS three-color check. Shrink finds the minimal cycle.

**Budget:** PR `numRuns: 100`; nightly `numRuns: 10_000`.

**Snippet:**
```typescript
fc.assert(fc.property(fc.commands([
  fc.record({phases: phaseArb, edges: edgeArb}).map(d => new SubmitDefinitionCmd(d)),
  fc.record({...}).map(d => new ModifyDefinitionCmd(d)),
]), (cmds) => {
  const s = () => ({ model: emptyDefStore(), real: new DefinitionStore() });
  fc.modelRun(s, cmds);
  // post-condition: every committed graph is acyclic
  for (const g of s().real.committed()) assert(!hasCycle(g));
}), { numRuns: 100 });
```

### §2.2 Ready-set determinism tick-over-tick

**Statement (verifies Pass A §4.2):** Given state `S` (completed-set, in-flight-set, pool-free-set) on tick `T`, the computed ready-set on tick `T+1` is a pure function of `S`. Two executors seeded with identical `S` produce identical ready-sets and identical admission decisions.

**Generator:** `fc.record({ definition: defArb, completed: fc.subarray(phases), poolFree: poolStateArb })`.

**Assertion:** `computeReadySet(S) === computeReadySet(S)` (referential invariance) and priority-tiebreak FIFO is stable (same creation order → same ordering).

**Budget:** PR 200; nightly 20 000.

### §2.3 `max_phase_transitions` and `max_duration` bounds hold under adversarial definitions

**Statement (verifies C-1 §3.1 loop safety):** For any workflow definition with arbitrary `go-back-to` chains and retry counts, total phase-transition count ≤ `max_phase_transitions` and wall-clock ≤ `max_duration` at run termination.

**Generator:** deliberately produce mutual `go-back-to` (A→B→A) and deep retry chains; vary `max_retries`, `max_phase_transitions` between 1 and 200.

**Assertion:** run-level counter `phase_transitions_executed ≤ max_phase_transitions`; run terminates with `RUN_ITERATION_LIMIT` or `RUN_DURATION_LIMIT` — never unbounded.

**Budget:** PR 50 (each run spins a mock executor — expensive); nightly 1000.

### §2.4 ParallelJoinPolicy semantics under arbitrary sibling-failure schedules

**Statement (verifies SA-4, Pass A §3.4):** For each `ParallelJoinPolicy` mode and any adversarial ordering of sibling-phase outcomes (success/failure/in-progress), the join resolves per contract:

- `fail-fast`: on first sibling failure, all other in-progress siblings receive `REQUEST_CANCEL` synchronously on the tick. Join resolves `failed`.
- `all-settled`: no sibling cancellation; join resolves `failed` iff ≥1 sibling failed, with `outcome` enumerating per-sibling results.
- `any-success`: on first sibling success, all other in-progress siblings receive `REQUEST_CANCEL`. Join resolves `succeeded`.

**Generator:** `fc.record({ siblingCount: fc.integer({min: 2, max: 10}), schedule: fc.array(fc.oneof(fc.constant('success'), fc.constant('failure'))) })`.

**Assertion:** per-mode oracle table; synchronous cancellation tick-boundary verified via event-log inspection (every cancel event shares the same `tick_id` as the triggering failure event).

**Budget:** PR 200 per mode (600 total); nightly 5000 per mode.

### §2.5 DAG topological emission is stable under retry-induced re-entry

**Statement (verifies C-9 output immutability):** Retrying a failed phase creates a new `phase_output_id`; prior output remains queryable. Emission order under topological iteration is stable across retry cycles (retries don't "jump" the order).

**Generator:** `fc.array(retryScheduleArb)` producing interleavings of success/fail/retry.

**Assertion:** for any emission trace, `output_ids` are monotonic per retry generation; no output is overwritten.

**Budget:** PR 100; nightly 10 000.

---

## §3 Fuzz Tests

Target framework: `@jazzer.js/core` (v4.x; §9 citation [2]) with `@jazzer.js/jest-runner` wrapper, integrated as `.fuzz.ts` sidecars. CI budget: each target runs 15 minutes per PR (via a nightly-runner helper that accepts a time budget) and 2 hours per night. Corpora are committed under `corpus/<target>/` and grow monotonically; any crashing input is reduced to a minimal reproducer and saved as a regression test in `vitest`.

### §3.1 Target — Workflow-definition parser

**Input domain:** YAML and JSON bytes ≤ 1 MB. Every author-controlled field in Spec-017 is a seed: phase names, `command`, `args`, `env`, `stdin`, `outputs.capture.from`, `prompts.system`, `prompts.user`, `inputs.*`, timeouts, priorities, pool claims, moderation config, parent-channel refs.

**Harness:**
```typescript
import { FuzzedDataProvider } from "@jazzer.js/core";
export function fuzz(data: Buffer) {
  const p = new FuzzedDataProvider(data);
  const yaml = p.consumeString(p.remainingBytes, "utf8");
  try { parseWorkflowDefinition(yaml); }
  catch (e) { if (e instanceof WorkflowParseError) return; throw e; }
}
```

**Oracle (what defines failure):**
1. Uncaught exception (non-`WorkflowParseError`) — fail.
2. Parse succeeds but definition would spawn a shell — fail (regression against C-2 / I1).
3. Parse infinite-loops (30s timeout) — fail (DoS regression).
4. Parse allocates >100 MB — fail (billion-laughs / entity-expansion regression).

**CVE-regression seeds (every Pass E §2.2 CVE is a seed):** n8n `CVE-2025-68613` expression crafted to escape sandbox; Airflow `CVE-2024-39877` Jinja2 `doc_md` payload; Airflow `CVE-2024-56373` log-template RCE payload; Argo `CVE-2025-66626` symlink-archive entry. Each is checked in to `corpus/workflow-parser/regressions/` and replayed at test-time.

### §3.2 Target — Expression grammar (I2)

**Input domain:** any string that could appear as an expression in a `${ ... }` or `{{ ... }}` context of a phase definition.

**Harness:** invokes `parseExpression(str)` where `parseExpression` is the typed non-Turing-complete grammar recognizer committed per C-3.

**Oracle:** every input either (a) parses to a typed AST whose evaluation reads from a whitelisted lookup set (no function-call node except for the allowed whitelist — e.g., `phaseOutput(<id>, <fieldPath>)`) or (b) returns `ExpressionParseError`. **Any code path that produces an eval, a function call into host JS, or a property access outside the whitelist is a fail.** This is the testable form of I2.

**Seed corpus:** CodeQL / Semgrep expression-injection payloads for JavaScript (§9 [3]); n8n advisory PoC; Jenkins Groovy sandbox escapes `CVE-2024-34144` / `-34145` adapted to expression syntax. Nightly mutates these against the grammar.

**Snippet:**
```typescript
import { FuzzedDataProvider } from "@jazzer.js/core";
export function fuzz(data: Buffer) {
  const expr = new FuzzedDataProvider(data).consumeString(1024, "utf8");
  try {
    const ast = parseExpression(expr);
    // Oracle: AST nodes must be from whitelisted set only
    assertEvalFree(ast); // throws if any non-whitelist node exists
  } catch (e) {
    if (e instanceof ExpressionParseError) return;
    throw e; // any other throw is a bug
  }
}
```

### §3.3 Target — Secrets resolver (I4)

**Input domain:** workflow definitions where a `secret://<scope>/<name>` reference appears in every permutation of field location (phase args, env, stdin, moderation config, output capture filter).

**Harness:** executes a mocked phase with a canary secret value (`CANARY-<rand>`); captures (a) argv passed to `execve`, (b) stdout/stderr, (c) all log writes, (d) all artifact bytes.

**Oracle:** the literal canary bytes MUST NOT appear in (a)–(d). Also verified: base64-encoded form, URL-encoded form, JSON-stringified form (closes Airflow masker bypass class, §9 [4]).

**Seed:** every field in Spec-017 that could carry a secret-ref; Airflow `#54540` reproducer patterns (base64-transformation bypass).

**CI integration:** runs per-PR as a 15-minute fuzz target; nightly 2-hour with mutation (matches §7 per-target budget).

---

## §4 Load Tests

Target tooling: `autocannon` for HTTP surfaces (Electron preload bridge), native `vitest` `bench` harness for in-process scenarios, `sqlite3_analyzer` + `EXPLAIN QUERY PLAN` for DB assertions. Load tests do not gate PR merges at V1; they produce baseline numbers and alert on ≥2× regression.

### §4.1 Parallel executor under contention

**Scenario:** spawn a workflow with 10–25 parallel phases; vary `ParallelJoinPolicy`; inject synthetic per-phase failure rates 0%, 10%, 50%.

**Success criteria:**
- `fail-fast`: at 50% failure rate, total cancellation dispatch latency ≤ 1 tick (100 ms); no orphaned in-flight phases after tick+1.
- `all-settled`: completion time equals max(sibling durations) within 5% (no serialization bug).
- `any-success`: first-success dispatch cancels the rest within 1 tick.

**Tooling:** `vitest bench` with a mock-phase harness (sleep + probabilistic fail).

### §4.2 Resource-pool admission under memory pressure

**Scenario:** `agent_memory_mb` pool size = 192 MB; admit phases declaring 100 MB each (default per Wave 1 §3.1); ramp from 1 to 10 concurrent admissions; observe `workflow.phase_waiting_on_pool` rate.

**Success criteria:** no admission exceeds pool capacity at any tick; no phase waits indefinitely (wait-time p99 ≤ 60s under steady-state 80% utilization); tripwire fires at >15% blocked-launch rolling window (feeds V1.1 calibration per wave-1 synthesis §3.1).

### §4.3 `max_concurrent_phases` backstop under burst

**Scenario:** 50 phases submitted in one burst; `max_concurrent_phases=4`.

**Success criteria:** at most 4 phases in `started` state at any tick; remaining phases in `waiting_on_pool` with well-defined admission order (priority > FIFO).

### §4.4 SQLite write-amplification (Pass G interaction)

**Scenario:** 20-phase workflow with 5× retry per phase under `all-settled` join; measure SQLite write rate per second, WAL size, row count per `phase_outputs` + `workflow_gate_resolutions`.

**Success criteria:** write rate ≤ 500 writes/sec sustained (Pass G target; revisit at synthesis); no transaction >500 ms; WAL reclaimable within 30s of checkpoint.

---

## §5 Long-Running Integration Tests

Target tooling: `vitest` + `@playwright/test` for Electron; real daemon process (not in-process) to catch serialization/boundary bugs. Time manipulation via `sinon.useFakeTimers` for compressed runs; real-time variants in weekly job.

### §5.1 Multi-day `human` phase resumption

**Setup:** spawn workflow with `human` phase, `timeout: "72h"`, assignee = participant A.

**Execution pattern:**
1. Open `/session/:sid/workflow/:rid/phase/:pid`, partially fill form.
2. Kill daemon process (`SIGKILL`).
3. Advance wall-clock 6h.
4. Restart daemon; reopen URL.
5. Assert: draft form state restored; phase still in `waiting-human`; no `timeout-behavior` fired.
6. Submit; assert phase transitions to `completed`, output artifact created.

**Assertion surface:** `workflow.phase_suspended { reason: waiting-human }` event emitted at daemon shutdown; `workflow.phase_resumed` on restart; no duplicate `phase_started`.

**Real-time weekly variant:** leave phase open 7 days; submit at 7d01h; verify no soft-timeout fired (given Decision 1: no default timeout).

### §5.2 Checkpoint/replay correctness across daemon restart

**Setup:** run a workflow through half its phases; take `pg_dump`-equivalent of SQLite state; restart daemon.

**Assertion:**
- Replay from checkpoint produces byte-identical event stream for already-completed events (§9 [5]: Temporal replay pattern).
- Remaining phases execute under the *at-checkpoint-time* workflow definition even if definition was edited during restart (C-13 / I7).
- Every event type in Pass F taxonomy has at least one replay-correctness test (per-event enumeration; test generator from Pass F synthesis).

**Snippet (Temporal-style replay oracle):**
```typescript
// Borrows Worker.runReplayHistory pattern (Temporal TS SDK)
const history = await recorder.collectEvents(runId);
const replay = await executor.runReplay({ definition: pinnedDefAt(history[0].at), history });
if (replay.error instanceof DeterminismViolationError) fail("non-deterministic replay");
assert.deepEqual(replay.finalState, original.finalState);
```

### §5.3 Multi-agent channel lifecycle (OWN-only per SA-6)

**Setup:** `multi-agent` phase with 3 agents; moderation on (Plan-012 per-turn gate).

**Execution pattern:**
1. Start phase; verify `workflow.channel_created_for_phase` event.
2. Fail phase mid-turn; verify `REQUEST_CANCEL` fires; verify agents receive cancel-intent; verify 30s grace window.
3. After grace, verify channel transitions to `closed` with `CLOSE_WITH_RECORDS_PRESERVED` semantics (records queryable, no new turns admitted).
4. Retry phase; verify *new* channel_id created (not reused — SA-6 §7.2 contract).
5. Per-turn moderation gate fires exactly once per agent turn; no silent gate bypass.

**Assertion surface:** event sequence matches Pass F taxonomy; channel_id uniqueness across retry; moderation gate resolution appears in append-only log (I7).

### §5.4 Human-phase assignment with optimistic-concurrency

**Setup:** two participants both open the same `human` phase URL.

**Execution:** both fill the form; participant A submits first. Assert participant B's submit returns `HTTP 409 CONFLICT` with a human-readable message pointing to participant A's submission. No silent last-writer-wins.

---

## §6 Security Regression Battery — Per Invariant

Every invariant has a dedicated test module `tests/security/inv-<N>-<name>.spec.ts`. Passing the battery is a merge-gate.

### §6.1 I1 — argv-list-only execution

**Static test:** `vitest` CI step runs Semgrep with rules banning `child_process.exec` (uses shell), `execSync(string)`, `spawn(..., {shell: true})`, and backtick exec. Any match fails CI.

**Dynamic test:**
```typescript
test("I1: shell metachars in param reach argv, not shell", async () => {
  const wf = loadFixture("echo-param.yaml"); // runs `echo <param>`
  const evil = '"; touch /tmp/pwned-${randomUUID()} #';
  await runPhase(wf, { param: evil });
  assert(!existsSync(`/tmp/pwned-`)); // glob-check, no shell expansion
  assertEventLog("phase.started", { argv: ["echo", evil] }); // literal, not interpolated
});
```

### §6.2 I2 — typed substitution, no eval

**Test:** every CVE payload from §2.2 expression class fed through `parseExpression`:

```typescript
const payloads = [
  /* n8n CVE-2025-68613 */ "constructor.constructor('return process')().exit()",
  /* Jenkins CVE-2024-34144 */ "['echo','pwned'].execute()",
  /* Airflow CVE-2024-39877 */ "{{ ''.__class__.__mro__[1].__subclasses__() }}",
];
for (const p of payloads) {
  assert.throws(() => parseExpression(p), ExpressionParseError);
}
```

Pair with the fuzz target (§3.2) running continuously.

### §6.3 I3 — typed approver capability

**Test:** given workflow `W` with phase `P` requiring approver Alice:

```typescript
test("I3: Bob cannot approve Alice's phase even with admin", async () => {
  const { runId, phaseId } = await startWorkflow(W);
  await expect(approveAs(bob, phaseId)).rejects.toThrow(CapabilityDeniedError);
  // admin override is a distinct capability, logged separately
  await adminOverrideApprove(bob, phaseId);
  const log = await approvalLog(phaseId);
  assert.equal(log[0].kind, "admin_override");
  assert.notEqual(log[0].kind, "approval"); // distinct entry type
});
```

### §6.4 I4 — secrets-never-in-argv / logs / artifacts

**Canary test:** the exact test stated in Pass E §4.4. Implementation detail — capture argv via `execve` wrapper in tests:
```typescript
test("I4: canary secret never leaks", async () => {
  const canary = `CANARY-${randomUUID()}`;
  await secretStore.set("scope/name", canary);
  const events = await runPhaseCapturingAll(wf);
  const encodings = [canary, Buffer.from(canary).toString("base64"),
                     encodeURIComponent(canary), JSON.stringify(canary)];
  for (const e of encodings) {
    assert(!events.argv.join(" ").includes(e));
    assert(!events.stderr.includes(e));
    assert(!events.logs.includes(e));
    assert(!events.artifactBytes.includes(e));
  }
});
```

Augmented by fuzz target §3.3.

### §6.5 I5 — content-addressed external references

**Test:** pin workflow to `codex@v1.2.3#sha256=abc...`; mutate the resolved tool bytes on disk; assert next execution fails closed with `ContentHashMismatch`:

```typescript
test("I5: mutable re-pointing of external tool is rejected", async () => {
  pin(wf, "codex", { version: "v1.2.3", sha256: "abc..." });
  await fs.writeFile(resolvedPath("codex@v1.2.3"), Buffer.from("malicious"));
  await expect(runPhase(wf)).rejects.toThrow(ContentHashMismatch);
});
```

### §6.6 I6 — human-phase uploads follow OWASP minimums

**Test fixtures:** zip bomb (42 KB → 4.5 GB decompression ratio ≥ 100 000× — §9 [6]), polyglot PNG+shell-script, symlink-to-`/etc/passwd`, oversize upload (1.1× max), mismatched Content-Type (says `image/png`, bytes are ELF).

```typescript
test.each(maliciousFixtures)("I6: %s rejected", async (fx) => {
  const res = await uploadToHumanPhase(phaseId, fx);
  assert.equal(res.status, "quarantined");
  assert.equal(await phaseOutput(phaseId), null);
});
```

Argo `CVE-2025-66626` regression: explicitly include a zip with a symlink entry pointing outside the extraction root; assert post-extraction path-validator rejects (§9 [7]).

### §6.7 I7 — append-only hash-chained approval log

**Test:** given an approved workflow run, tamper with any row in `workflow_gate_resolutions`; daemon start-up verification detects the hash-chain break and refuses to resume:

```typescript
test("I7: tampering with approval history is detected", async () => {
  await runAndApprove(wf);
  await db.execute("UPDATE workflow_gate_resolutions SET result='denied' WHERE id=1");
  await expect(daemon.start()).rejects.toThrow(ApprovalHistoryTampered);
});
test("I7: replay uses at-approval-time policy", async () => {
  const run = await runAndApprove(wf); // phase P approver=Alice
  await editDef(wf, { phaseP: { approver: "Bob" }}); // post-approval edit
  const replay = await replayFrom(run.id);
  assert.equal(replay.phaseP.resolution.approver, "Alice"); // at-time policy
});
```

---

## §7 CI Pipeline Structure

Three pipelines. Merge-gate = PR. Post-merge-gate = merge queue. Nightly/weekly = scheduled GitHub Action. All timings assume GitHub-hosted `ubuntu-latest` 4-vCPU runner.

| Stage | PR (merge-gate) | Merge queue | Nightly | Weekly |
|---|---|---|---|---|
| Lint + typecheck | yes (<2m) | yes | — | — |
| Unit (vitest) | yes (<5m) | yes | — | — |
| Property-based (fast) | yes (numRuns=100, ~3m) | yes | — | — |
| Property-based (thorough) | — | — | numRuns=10k (~30m) | — |
| Fuzz (per target) | yes (15m/target, 3 targets ≤ 45m, parallelized ≤ 15m) | yes | 2h/target (6h total) | — |
| Load tests | — | — | 30m baseline | — |
| Integration (compressed-time) | — | yes (20m) | yes (20m) | — |
| Integration (real-time, multi-day human) | — | — | — | yes (7d) |
| Security regression battery | yes (10m) | yes | yes | yes |

**Compute budget:** PR pipeline ≤ 30 min wall-clock to keep developer loop tight. Nightly ≤ 8h. Weekly unbounded.

**Fuzz corpus management:** `corpus/` is a committed directory; any nightly-found crasher is minimized, checked in as a regression in `corpus/<target>/regressions/`, and promoted to a named `vitest` test. Crashers that reveal a secret do not get checked in; instead, a canary-stripped form is committed and the real reproducer lives in a private issue.

---

## §8 Coverage Targets + Success Criteria

Numeric targets, enforced by CI:

| Metric | V1 Target | V1.1 Stretch |
|---|---|---|
| Line coverage (overall) | ≥ 85% | ≥ 90% |
| Line coverage (security-critical modules: parser, secrets resolver, approval log, executor tick loop) | ≥ 95% | ≥ 98% |
| Branch coverage (same modules) | ≥ 90% | ≥ 95% |
| Property-based iteration count (nightly, per property) | ≥ 10 000 | ≥ 50 000 |
| Fuzz duration budget (nightly, per target) | ≥ 2 h | ≥ 8 h |
| Fuzz seed corpus size (before first run) | ≥ 50 inputs/target | — |
| Integration replay: events covered | 100% of Pass F taxonomy | — |
| Security regression: CVEs with regression test | ≥1 per threat category A–E of Pass E §3 (representative coverage); every CVE explicitly named in §3.1 / §6 seed lists is required | 100% of Pass E §2.2 |
| Canary-secret test surface (I4) | argv + env + logs + 3 artifact formats + crash dumps | + core dumps |
| Invariant test gating | I1–I7 all have ≥ 1 failing test if the invariant is violated | — |

**"Success" for Pass H sign-off:** every invariant I1–I7 and every contract commitment C-1 through C-16 has at least one test in this strategy that *would fail* if the invariant were violated. This is not a coverage metric — it's a mutation-testing intent. Implementation may use `stryker-mutator` on a post-V1 pass; V1 verifies the intent by code review against this document's §2 / §3 / §6 enumeration.

---

## §9 Websearch Evidence Table

All sources fetched 2026-04-22. Bold rows are primary-source (documentation/advisory).

| # | Source | URL | Relevance |
|---|---|---|---|
| [1] | **fast-check official docs — Model-based testing (`fc.commands` + `fc.modelRun`)** | `https://fast-check.dev/docs/advanced/model-based-testing` | Stateful property test API and shrinking behavior — §2.1–§2.5 snippets |
| [2] | **Jazzer.js — coverage-guided Node.js fuzzing (v4.x, Code Intelligence)** | `https://github.com/CodeIntelligenceTesting/jazzer.js` and `https://github.com/CodeIntelligenceTesting/jazzer.js/blob/main/docs/fuzz-targets.md` | Fuzz-target shape, `FuzzedDataProvider`, Jest integration, corpus config — §3.1–§3.3 harnesses |
| [3] | **GitHub Actions script-injection guidance (GitHub Docs, 2025)** | `https://docs.github.com/en/actions/concepts/security/script-injections` | Canonical expression-injection class; underpins I2 test surface — §6.2 |
| [4] | **Airflow secret masker issue `apache/airflow#54540` (2025)** | `https://github.com/apache/airflow/issues/54540` | Pattern-mask bypasses via transformation; drives encoding-coverage in I4 canary test — §6.4 |
| [5] | **Temporal TypeScript SDK — Testing Suite (replay + determinism)** | `https://docs.temporal.io/develop/typescript/testing-suite` | `Worker.runReplayHistory`, `DeterminismViolationError`, CI replay pattern — §5.2 snippet |
| [6] | **OWASP File Upload Cheat Sheet (2025)** | `https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html` | Minimum upload checks; anchors I6 test fixtures — §6.6 |
| [7] | **Endor Labs — CVE-2025-66626 Argo broken-fix analysis** | `https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo` | Symlink-in-archive regression; drives explicit Argo regression fixture — §6.6 |
| [8] | **Astronomer — Testing Airflow DAGs** | `https://www.astronomer.io/docs/learn/testing-airflow` | DAG validation / topology test patterns (imports, cycles, dependencies) — §2.1 / §2.5 prior art |
| [9] | **Temporal blog — Replay Testing (Bitovi)** | `https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows` | CI-integrated replay pattern (representative histories, DeterminismViolationError) — §5.2 CI approach |
| [10] | **n8n `CVE-2025-68613` advisory** | `https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp` | Expression-escape payload for §3.2 seed corpus |

Supplementary (lower priority, lean on Pass E for the primary CVE citations):
- OWASP CI/CD Top 10: `https://owasp.org/www-project-top-10-ci-cd-security-risks/` (anchoring categories).

---

## §10 Open Questions for Wave 2 Synthesis

Ten explicit gaps this Pass H strategy surfaces but does not resolve. Each is a one-line framing for Wave 2 synthesis (task #25).

1. **Mutation testing in V1?** `stryker-mutator` would validate that the tests actually fail when the code is mutated. 5–20 min PR cost. Strategy recommends deferring to V1.x; Wave 2 synthesis should ratify or override.
2. **Replay-corpus sourcing.** §5.2 recommends recording real-world workflow histories and replaying them nightly. Who provides the corpus? Plan-015 (persistence) or Pass F (event taxonomy)? Dependency needs naming in synthesis.
3. **Fuzz-target coverage threshold.** Jazzer.js reports line coverage per target; if a nightly 2h run plateaus at <70% line coverage on the parser, what is the escalation policy? V1 stance unresolved.
4. **Secrets-canary test in Electron renderer.** §6.4 tests daemon-side. Does the Electron IPC surface also need a canary test? Depends on how Plan-001 exposes secrets to the renderer (presumably via reference only, never resolved — but this is not yet documented).
5. **Weekly real-time integration cost.** §7 proposes a 7-day real-clock human-phase test. Where does it run (GitHub Actions has 6h job limit on free tier)? May need self-hosted runner or a custom scheduler.
6. **Property-based tests for gate-scoping lattice (SA-7).** Temporally-disjoint channel-vs-workflow gate resolution is a lattice property; §2 does not explicitly enumerate a property for it. Wave 2 synthesis should add if the lattice is complex enough to warrant.
7. **Determinism oracle for parallel executor.** §2.2 asserts determinism of `computeReadySet`. But the parallel executor under real OS scheduling is inherently non-deterministic in wall-clock — the determinism claim is about *logical* state, not timing. Is there a hidden timing dependency worth testing?
8. **Tripwire-firing validation.** Wave 1 named several tripwires (`RUN_ITERATION_LIMIT` >2%, `agent_memory_mb` blocked-launch >15%, join-policy override >30%). Who tests that the tripwires actually fire? Pass F event-taxonomy integration, but not scoped here.
9. **Corpus poisoning protection.** If a malicious committer pushes a crafted crasher to `corpus/`, CI runs it — does this open an attacker to a DoS of CI? Nightly budget mitigates; PR budget (15 min) is less mitigated. Needs Wave 2 or Plan-015 answer.
10. **Chaos / fault-injection layer.** This strategy covers adversarial inputs but not adversarial infrastructure (SQLite corruption, disk full, clock skew). V1 scope question: does Pass H extend to fault-injection, or is that Plan-015's job?

*End of strategy.*
