# ADR-024: Electron Main-Process BrowserWindow Retention

| Field         | Value                                           |
| ------------- | ----------------------------------------------- |
| **Status**    | `accepted`                                      |
| **Type**      | `Type 1 (two-way door)`                         |
| **Domain**    | Desktop shell / Electron main-process lifecycle |
| **Date**      | 2026-05-18                                      |
| **Author(s)** | Sawmon Abo, Claude (AI-assisted)                |
| **Reviewers** | Codex (PR #70 P1 originator)                    |

> **Type guidance:** Two-way door. The decision is to keep a single `let mainWindow` module-scope reference. Reversal is a ≤5-line edit (remove the declaration + lint-disable + comment). No migration. Reversal cost is functionally zero and the blast radius is the single `apps/desktop/src/main/index.ts` file. Antithesis + Synthesis + Failure Mode sections are included anyway because they carry the document's epistemic content (the empirical falsification of the premise that motivated the original change in PR #72); the [T2] template markers are advisory, not gating, when a section is load-bearing for document accuracy.

---

## Context

The desktop shell main entrypoint at `apps/desktop/src/main/index.ts` creates exactly one `BrowserWindow` instance inside the `app.whenReady().then(...)` callback. In PR #70, Codex's automated review surfaced this as a P1 finding (verbatim quote retrieved 2026-05-18 from `gh api repos/SawmonAbo/ai-sidekicks/pulls/70/comments`):

> `mainWindow` is created as a local variable inside the `whenReady().then(...)` callback, and in the normal (non-smoke) path there is no long-lived reference after that callback returns. In Electron, losing all JS references allows the window to be garbage-collected and closed, which will trigger `window-all-closed` and quit the app unexpectedly; this can manifest as the desktop shell disappearing shortly after launch in regular builds.

PR #72 acted on this finding by promoting `mainWindow` to a module-scope `let` (declared next to the smoke-probe constants) with a `closed`-handler that nulls the reference back. The intent — recorded in the PR #72 commit message and the comment block above the declaration — was "the canonical Electron main-process retention pattern": prevent V8 from collecting the only live handle to the window once the `.then(...)` callback's stack frame unwinds.

Codex's PR #72 VERIFICATION subsequently observed that no test demonstrably failed when the module-scope retention reference was removed. That observation is what triggered the investigation this ADR records.

## Problem Statement

What anchors the reachability of the main-process `BrowserWindow` wrapper across the `app.whenReady().then(...)` callback unwind in Electron 41.6.1, and what shape should our user-side code take given that anchor?

### Trigger

Codex's PR #72 VERIFICATION observation: a non-smoke regression test for the "retention removed → process exits" failure mode was not feasible in the timeframe of PR #72, so the test was deferred. Lifting the test out of "Tier 8 remainder" deferral (per the user-affirmed production-hardened priority bar) required empirical evidence that the failure mode is real before any test design could discriminate it. The empirical evidence falsified the premise.

---

## Decision

We keep the module-scope `let mainWindow: BrowserWindow | null = null;` declaration in `apps/desktop/src/main/index.ts`, with the `closed`-handler nulling its reference back, **as defensive consistency with the canonical Electron community pattern**. The reachability invariant the AC asserts (window stays live across the `.then(...)` unwind; `window-all-closed` does not fire spuriously) is in fact anchored by Electron's native-side `BaseWindow::self_ref_` — not by the user-side reference.

### Thesis — Why This Option

Three reasons support keeping the user-side reference even though it is empirically not the load-bearing GC anchor:

1. **Convention with the Electron community.** Electron's official tutorials, security checklist, and the bulk of OSS Electron apps declare `let mainWindow` (or equivalent) at module or top scope. A reader inheriting our code finds the pattern they expect. Removing it would create a low-key surprise that requires the inheriting reader to internalize the `self_ref_` mechanism before they can reason about lifecycle.
2. **Asymmetric risk.** If a future Electron release changes `BaseWindow::self_ref_` lifetime semantics (e.g., transitioning to a weak-handle model and exposing user-land as the only GC anchor), our user-side `let mainWindow` is the difference between a regression that surfaces at upgrade time vs. a regression that ships silently. The cost of keeping the reference is one `let` declaration, one comment, and one lint-disable; the cost of being wrong about Electron internals 6 quarters from now is the entire desktop shell failing to boot.
3. **Zero downside.** The variable is referenced exactly twice (declaration + `closed` handler nulling). It does not block GC of any other heap state. It does not affect bundle size after minification. It does not add a maintenance burden.

### Antithesis — The Strongest Case Against

A skeptical staff engineer reviewing this PR would argue:

> The `let mainWindow` declaration encodes a false mechanism claim. The header comment (until amended in this PR) reads "Without this, V8 may garbage-collect the only live handle once the callback's stack frame unwinds" — but in Electron 41.6.1 that is empirically not what would happen, because `BaseWindow::self_ref_` (`v8::Global<v8::Value>` at `shell/browser/api/electron_api_base_window.h:271`) strong-roots the JS wrapper from `InitWith` (`electron_api_base_window.cc:155`: `self_ref_.Reset(isolate, wrapper);`) until native-object destruction (`electron_api_base_window.cc:130`: `self_ref_.Reset();` in the destructor). Keeping a user-side reference whose comment claims it prevents GC, when in fact the native binding is what prevents GC, is a stale-comment risk waiting to bite a future reader. Better to remove the reference, document the actual mechanism inline, and let the codebase tell the truth.

The empirical evidence behind the antithesis is strong. We ran a primary-source investigation of Electron 41.6.1 + V8 v14.6.202.34-electron.0:

- **Wrapper anchor.** `electron_api_base_window.h:271` declares `v8::Global<v8::Value> self_ref_;` with the inline comment "Reference to JS wrapper to prevent garbage collection." `electron_api_base_window.cc:155` sets it in `InitWith` (called as part of `BaseWindow`'s gin-helper constructor); `electron_api_base_window.cc:130` is the only site that releases it (the C++ destructor). `OnWindowClosed` (lines 169-194) emits the JS `closed` event and posts an async native-destroy task but does NOT reset `self_ref_` — the wrapper outlives the JS `closed` event.
- **`window-all-closed` trigger.** `WindowList::RemoveWindow` (`shell/browser/window_list.cc`) operates on a `WindowVector` of raw `NativeWindow*` pointers. The `OnWindowAllClosed` notification fires when that vector empties — i.e., when native windows are destroyed, not when JS wrappers are collected.
- **Empirical Step 0b spike.** We ran a transient spike script — a throwaway probe, not retained — against `apps/desktop/node_modules/.bin/electron --js-flags=--expose-gc`. It created one `BrowserWindow`, read `v8.queryObjects(BrowserWindow)`, then called `window.close()` + `window = null` + two synchronous bare `gc()` calls and re-read the count. Result on Electron 41.6.1 / Node 24.15.0 / V8 14.6.202.34-electron.0: `countWithWindow: 2`, `countAfterClose: 2` — `queryObjects(BrowserWindow)` did not drop to zero. This is consistent with `OnWindowClosed` posting an async destroy task while `self_ref_` keeps the wrapper alive on the heap.
- **V8 `gc()` semantics.** From `src/extensions/gc-extension.cc`: bare `gc()` resolves to `PreciseCollectAllGarbage` (major collection, synchronous, precise mode — all roots traced). `gc(true)` falls through `GetDefaultForTruthyWithoutOptionsBag()` to a Scavenger-only minor pass that does NOT trace old-generation. The `gc(true)` form is therefore a silent footgun in any GC-pressure test — it would leave old-generation BrowserWindow wrappers intact and yield false-negative "still reachable" results. Our probe uses bare `gc()` (lines 122-130 of `apps/desktop/src/main/index.ts`); the test enforces `globalGcAvailable === true` to detect the case where `--expose-gc` was not forwarded.

If the wrapper cannot be collected while the native object lives, and `window-all-closed` fires from native-object removal rather than wrapper collection, then PR #72's `let mainWindow` does not prevent the failure mode Codex's P1 described. The mechanism Codex named ("losing all JS references allows the window to be garbage-collected") is not the operative mechanism in Electron 41.6.1.

### Synthesis — Why It Still Holds

The antithesis is empirically correct about Electron 41.6.1's mechanism and correctly identifies that PR #72's commit message + the original comment encoded a falsified mechanism claim. This PR (PR2-Honest in the local notation) accepts that correction in two places:

1. **The header comment above the `let mainWindow` declaration** is amended to cite this ADR and reference `BaseWindow::self_ref_` as the actual load-bearing mechanism. The user-side reference is reframed as "defensive consistency with the canonical Electron community pattern," not as the GC anchor.
2. **The Spec-023 acceptance criterion** is amended (in the same PR) to drop the "must demonstrably FAIL when the module-scope retention reference is removed" clause — that clause is empirically false in Electron 41.6.1 — and to encode the observable lifecycle invariant directly (`queryObjects(BrowserWindow) >= 1` + `window-all-closed` does not fire during the probe iteration loop).

What does not change: the `let mainWindow` declaration itself. The asymmetric-risk argument in the Thesis stands. The cost of being wrong about Electron internals is paid out unbounded years from now in the form of "the desktop shell stopped booting after the Electron upgrade and we cannot bisect because the change happened in vendor code"; the cost of keeping a redundant reference is paid right now in the form of one comment that has to remain accurate. We pay the second cost.

The lifecycle regression test we ship in `apps/desktop/test/lifecycle.gc.test.ts` is honest about what it observes: it asserts the observable invariant (`queryObjects(BrowserWindow) >= 1` across 20 GC pressure cycles; a probe-scoped `window-all-closed` listener does not fire mid-loop) without claiming that removing `let mainWindow` would cause the test to fail. It exists as a future-regression guard, not as proof that user-side retention is causally load-bearing in the current fix-state.

---

## Alternatives Considered

### Option A: Keep `let mainWindow` (Chosen)

- **What:** Module-scope `let mainWindow: BrowserWindow | null = null;` with `closed`-handler nulling. Reframe header comment + Spec-023 AC to cite ADR-024 + `BaseWindow::self_ref_` as the load-bearing mechanism.
- **Steel man:** Matches the canonical Electron community pattern (zero learning-curve cost for an inheriting reader who has any Electron exposure). Provides defense-in-depth against a hypothetical future Electron release that shifts `self_ref_` semantics. Costs one `let`, one comment, one lint-disable — no runtime cost, no bundle-size cost, no maintenance burden beyond keeping the comment accurate.
- **Weaknesses:** The variable is empirically a no-op for the failure mode the original PR #70 P1 claimed it prevented. A future reader who skims past the ADR citation in the comment could re-encode the false mechanism claim in a derived doc. Mitigation: the comment cites this ADR by number, and the ADR captures the falsification.

### Option B: Remove `let mainWindow`, rely solely on `self_ref_` (Rejected)

- **What:** Inline the BrowserWindow creation, allow the const to fall out of scope at `.then(...)` unwind, document the `self_ref_` mechanism inline at the call site.
- **Steel man:** Codebase tells the empirical truth (the JS reference is not what anchors reachability; the native binding is). No stale-comment risk. One fewer variable to keep in sync. The community-pattern argument is weak in our codebase specifically because we have a comment block + an ADR that documents the real mechanism — an inheriting reader who reads our code is more likely to understand `self_ref_` than the average Electron developer.
- **Why rejected:** The asymmetric-risk argument (Thesis #2) is load-bearing. If Electron's `BaseWindow::self_ref_` lifetime model shifts in a future release — say, moving to a weak `v8::Global<v8::Value>` with FinalizationRegistry semantics, or surfacing user-land as the canonical anchor for ESM-mode main processes — our user-side `let` is the difference between "noticed at upgrade time, fixed in one PR" and "silently broken in a release that ships." The cost of keeping the reference is fully paid (one comment, one variable, one lint-disable); the cost of being wrong about a future Electron version is unbounded. Reject.

### Option C: WeakRef + FinalizationRegistry (Rejected)

- **What:** Hold the BrowserWindow via `new WeakRef(browserWindow)` + register cleanup with `new FinalizationRegistry(...)` so the lifecycle is observable from user-land without strong-rooting.
- **Steel man:** Tests can observe wrapper collection directly. Aligns with the "JS-side, not native-side" philosophy that some modern web codebases prefer.
- **Why rejected:** (a) **Heisenberg observer effect.** Holding a `WeakRef` does not affect GC, but the act of _checking_ `weakRef.deref()` in our probe would influence the V8 reachability graph during the very GC pressure cycle we're measuring. (b) **No mechanism benefit.** The native `self_ref_` keeps the wrapper alive regardless of user-side weak/strong status — so a `WeakRef` would observe the same "always reachable" state we already observe via `v8.queryObjects(BrowserWindow)`. (c) **Added complexity.** FinalizationRegistry semantics are notoriously fragile across V8 versions; introducing one to a substrate file that's load-bearing for desktop boot violates the project's "no unauthorized scaffolding" principle for zero observable benefit.

### Option D: `BrowserWindow.getAllWindows()` re-acquire pattern (Rejected)

- **What:** Drop all references after creation; re-acquire the window via `BrowserWindow.getAllWindows()[0]` wherever needed in the lifecycle.
- **Steel man:** Treats the BrowserWindow as fully native-owned, with user-land merely a query interface. No stale-reference risk because there are no user-land references.
- **Why rejected:** Adds an indexing assumption (`[0]` is the main window) that breaks the moment we open a second window. Electron's `BrowserWindow.getAllWindows()` returns windows in an order that is not documented as stable. Re-acquiring on each use also adds noise to every site that needs the window. The complexity cost is real and the benefit is purely aesthetic ("we don't have any user-side reference"). Reject.

### Option E: IPC-keepalive (Rejected)

- **What:** Spin up a recurring IPC handshake between main and renderer that keeps the wrapper hot.
- **Steel man:** None worth elaborating — this is a heavyweight workaround for a problem that does not exist in Electron 41.6.1.
- **Why rejected:** Adds bidirectional message traffic to keep an object alive that is already strong-rooted by `self_ref_`. Costs CPU + battery + complexity for zero benefit.

---

## Reversibility Assessment

- **Reversal cost:** ~5 minutes. Delete the `let mainWindow` declaration (1 line), the `closed`-handler nulling (3 lines), and the comment block (10 lines). Update the ADR-024 status to `superseded by ADR-NNN` or `deprecated`. Update `apps/desktop/src/main/index.ts` to reference the new mechanism inline.
- **Blast radius:** Single file (`apps/desktop/src/main/index.ts`). Any Tier 4 lifecycle work that derives from this file would need to be re-derived from the new mechanism documentation, but no other file in the repo references `mainWindow` directly (verified by `grep -rn "mainWindow" --include="*.ts" .`).
- **Migration path:** No migration required. The desktop shell continues to work identically (the `let mainWindow` is empirically a no-op for the failure mode it claimed to prevent; removing it changes nothing observable).
- **Point of no return:** None. This is a Type 1 decision throughout the V1 lifecycle. Re-evaluation triggers (see Failure Mode Analysis below) signal the moment to revisit; they do not gate reversibility.

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Future Electron release changes `BaseWindow::self_ref_` lifetime semantics | Low (no signals in Electron 41 / 42 roadmap as of 2026-05-18) | High (desktop shell fails to boot) | `apps/desktop/test/lifecycle.gc.test.ts` Shape B fires (`allClosedFired === true`) on the next Electron-version-bump CI run | The retained `let mainWindow` is the user-side anchor that buys time to investigate the new Electron mechanism without an immediate ship-stop. Mitigation: keep the `let mainWindow` in place. |
| `self_ref_` and `let mainWindow` both fail to anchor (unknown future Electron rewrite) | Very low | High | Shape A (`probe.min < 1`) in lifecycle test, or Shape C (probe never emits) | Add `BrowserWindow.getAllWindows()` re-acquire as a third defense layer in the same PR that diagnoses the failure. |
| Future contributor reads the user-side reference, infers the false "this prevents GC" mechanism, propagates the belief to a derived doc | Medium (this is exactly the kind of comment-rot path we have memory entries warning against) | Low-Medium (no runtime impact; documentation drift) | Periodic re-read of `apps/desktop/src/main/index.ts` header comment as part of cross-plan-dependencies audits | The comment cites ADR-024 inline; ADR-024 captures the falsification. The cite is the safeguard. |
| The lifecycle test itself drifts (e.g., bare `gc()` semantics change in a future V8) | Low (V8 has not changed `PreciseCollectAllGarbage` semantics in the active release line as of 2026-05-18) | Medium (test becomes flaky or no-op) | Test setup-correctness gates assert `globalGcAvailable === true` and `queryObjectsAvailable === true`; either dropping to false indicates harness drift | Pin V8 version in CI matrix; ADR-024 captures the gc-extension.cc semantics so a future contributor can re-derive the assertion. |

---

## Consequences

### Positive

- **Convention parity with the Electron community.** An inheriting reader's intuition (from Electron tutorials, security checklist, third-party Electron apps) maps directly onto our code.
- **Defense-in-depth against future Electron internals shift.** If `self_ref_` semantics change, our user-side reference buys diagnostic time at the upgrade boundary.
- **Honest spec.** `Spec-023 §Acceptance Criteria` now encodes the observable lifecycle invariant directly (not the falsified "must FAIL when removed" predicate), and cites `ADR-024 §Antithesis — The Strongest Case Against` for the empirical mechanism truth.
- **Honest test.** `apps/desktop/test/lifecycle.gc.test.ts` asserts the observable contract and explicitly documents in its header that it is a future-regression guard, not a causal-mechanism demonstration.

### Negative (accepted trade-offs)

- **Empirical no-op in the current fix-state.** The `let mainWindow` declaration does not prevent the failure mode the PR #70 P1 claimed it prevents. We carry one `let`, one comment, one lint-disable for asymmetric-risk reasons, not for current-fix-state mechanism reasons.
- **Comment-rot risk if the inline ADR-024 citation is removed or weakened.** Mitigation: the ADR is named in the comment block and in Spec-023 AC; removing the citation in a future edit would surface in code review.
- **The lifecycle test does not discriminate fix-state from a bug-state where `let mainWindow` is removed.** This is honest about what the test observes (the observable invariant holds in both states on Electron 41.6.1). A test that _did_ discriminate would require deliberately disabling `self_ref_` at the Electron binding level, which is out of scope for user-land.

### Unknowns

- Whether `BaseWindow::self_ref_` will retain its current strong-anchor semantics in Electron 42+. This is the load-bearing assumption for the "empirical no-op" framing above. Re-evaluate at every Electron major bump.
- Whether multi-window apps (Tier 4 lifecycle work) introduce a window that _is_ user-anchor-dependent — e.g., a transient settings window that does not go through `BaseWindow::self_ref_` for some reason we have not yet discovered. Reading the same files for the second-window case is the planned mitigation in Tier 4.

---

## References

### Primary sources (Electron v41.6.1)

- `shell/browser/api/electron_api_base_window.h:271` — `v8::Global<v8::Value> self_ref_;` field declaration with inline comment "Reference to JS wrapper to prevent garbage collection."
- `shell/browser/api/electron_api_base_window.h:38-39` — `class BaseWindow : public gin_helper::TrackableObject<BaseWindow>, private NativeWindowObserver` (the gin-helper inheritance that wires `self_ref_` into the JS wrapper lifecycle).
- `shell/browser/api/electron_api_base_window.h:268` — `std::unique_ptr<NativeWindow> window_;` (the native-window owner).
- `shell/browser/api/electron_api_base_window.cc:155` — `self_ref_.Reset(isolate, wrapper);` (inside `InitWith`, lines 140-156: the wrapper is captured strong-rooted as part of construction).
- `shell/browser/api/electron_api_base_window.cc:130` — `self_ref_.Reset();` (inside the destructor, lines 124-131: the only release site).
- `shell/browser/api/electron_api_base_window.cc:169-194` — `OnWindowClosed()` method (emits the JS `closed` event and posts an async destroy task; does NOT reset `self_ref_`).
- `shell/browser/window_list.cc` — `WindowList::RemoveWindow` triggers `OnWindowAllClosed` notification when the `WindowVector` of raw `NativeWindow*` pointers becomes empty.

### Primary sources (V8 v14.6.202.34-electron.0)

- `src/extensions/gc-extension.cc:336-340` — bare `gc()` → `PreciseCollectAllGarbage` (major collection, synchronous, precise mode — all roots traced).
- `src/extensions/gc-extension.cc:323-325` — `gc(true)` → `GetDefaultForTruthyWithoutOptionsBag()` → MINOR Scavenger-only collection (the silent footgun: leaves old-generation objects intact).
- `src/extensions/gc-extension.cc:290-317` — `gc({type, execution, flavor, filename})` structured form (the long-term-stable alternative if V8 ever flips the default).

### Empirical research (this investigation)

| Source | Type | Key finding | URL/Location |
| --- | --- | --- | --- |
| Step 0a sanity check — `v8.queryObjects(Object)` return shape on host Node 22.9.0 | Primary research | `queryObjects(constructor)` returns a `number` count in both the default and the `{ format: "count" }` forms. Reproduce with `node -e 'const v8 = require("node:v8"); console.log(typeof v8.queryObjects(Object), typeof v8.queryObjects(Object, { format: "count" }))'`, which prints `number number`. | Node.js v22 V8 docs, `v8.queryObjects(ctor[, options])` — `format: 'count'` is documented and the API was added in v22.0.0: <https://nodejs.org/docs/latest-v22.x/api/v8.html> |
| Step 0b spike — Electron BrowserWindow prototype-chain match | Primary research | Reproduce with `apps/desktop/node_modules/.bin/electron --js-flags=--expose-gc <script>`, where the script creates a `BrowserWindow({ show: false })`, reads `v8.queryObjects(BrowserWindow, { format: "count" })`, then calls `close()`, nulls the reference, calls `gc()` twice synchronously, and re-reads. On Electron 41.6.1 / Node 24.15.0 / V8 14.6.202.34-electron.0 it prints `countWithWindow: 2`, `countAfterClose: 2` — the wrapper does NOT drop to zero, confirming `self_ref_` keeps it alive across the JS `closed` event. | Electron `--js-flags` command-line switch: <https://www.electronjs.org/docs/latest/api/command-line-switches> |
| Step 0c — `--expose-gc` passthrough + `globalThis.gc()` semantics | Primary research | Reproduce with `apps/desktop/node_modules/.bin/electron --js-flags=--expose-gc <script>` where the script prints `typeof globalThis.gc` then `String(globalThis.gc())`: on Electron 41.6.1 it prints `function` then `undefined`, so the flag reaches the main process and bare `gc()` returns `undefined` after a major+sync+precise collection. `gc({ type: "major", execution: "sync" })` is the structured equivalent; `gc(true)` is the MINOR Scavenger-only form (rejected). | Electron `--js-flags` command-line switch: <https://www.electronjs.org/docs/latest/api/command-line-switches> |
| Codex PR #70 P1 verbatim | Primary research | Codex's original mechanism claim retrieved from `gh api repos/SawmonAbo/ai-sidekicks/pulls/70/comments` 2026-05-18. The empirical investigation in this ADR §Antithesis falsifies the named mechanism for Electron 41.6.1. | GitHub PR #70 review comments |

### Related ADRs

- `ADR-016` — Electron desktop shell (V1 desktop architecture; this ADR is a derived contract addition).
- `ADR-022` — V1 toolchain selection (Node 22.14 tier, moved 2026-09-01 from 22.12 with the `better-sqlite3` 13.x Node-API-10 prebuild; V8 14.6.202.34-electron.0 is the Electron 41.6.1 engine this ADR's probe measured, and the probe was re-run green under the Electron 44.x pin at Plan-023 T-023p-1B-4).
- `ADR-023` — V1 CI/CD and release automation (the CI surface that ensures the dead-code-elimination guarantee continues to hold: `release bundle excludes test-machinery markers`).

### Platform scope note

The Step 0b spike + `queryObjects` empirical baseline ran on macOS (darwin 25.3.0) only. Cross-platform behavior of `v8.queryObjects()`, `--expose-gc` forwarding, and the gin/v8 wrapper chain is extrapolated from V8 + Electron upstream sources (single-tree, no platform-specific GC paths affecting these primitives). The CI matrix exercises `lifecycle.gc.test.ts` on Linux (Ubuntu 24.04) before any PR can merge, providing cross-platform regression coverage at the integration level.

### Citation scope note

The Electron + V8 source line numbers above (`electron_api_base_window.h:271`, `electron_api_base_window.cc:155`, `electron_api_base_window.cc:130`, `gc-extension.cc:336-340`, etc.) were extracted via WebFetch against the upstream repositories. The fetches could not deterministically confirm the v41.6.1 git tag from the served file contents (the responses carry only a generic Chromium-style copyright header), so the line numbers are functionally correct for the source landmarks they name (field declarations, method bodies) but may diverge by a few lines from a strict `v41.6.1`-tagged checkout. The Step 0b spike — run against `apps/desktop/node_modules/.bin/electron` at our pinned Electron 41.6.1 — provides cross-confirmation that the BEHAVIOR these citations describe (the `self_ref_` strong-anchor; the bare-`gc()` semantics) is active in the version we actually ship against, which is the load-bearing claim. Field and method names cited here (`self_ref_`, `InitWith`, `OnWindowClosed`, `RemoveWindow`, `PreciseCollectAllGarbage`) are stable across the active Electron release line.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-05-17 | Triggered | Codex PR #72 VERIFICATION observed that no test demonstrably fails when `let mainWindow` is removed. User affirmed production-hardened priority — empirically investigate rather than defer. |
| 2026-05-18 | Proposed | Empirical investigation of Electron 41.6.1 + V8 14.6.202.34-electron.0 surfaced `BaseWindow::self_ref_` as the load-bearing anchor; Codex's PR #70 P1 mechanism claim falsified. |
| 2026-05-18 | Accepted | Spec-023 AC amended (commit 76714fa); regression test + probe enhancement shipped (commit 4ddab2a); user-side `let mainWindow` retained as defensive consistency against asymmetric risk of future Electron drift. |
