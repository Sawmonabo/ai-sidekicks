# ADR-023: Electron Main-Process Window Retention

| Field         | Value                                         |
| ------------- | --------------------------------------------- |
| **Status**    | `accepted`                                    |
| **Type**      | `Type 1 (two-way door)`                       |
| **Domain**    | Desktop app / Electron main-process lifecycle |
| **Date**      | 2026-05-18                                    |
| **Author(s)** | Sawmon Abo, Claude (AI-assisted)              |
| **Reviewers** | Codex                                         |

> **Type guidance:** Two-way door. The decision is to keep a strong reference to every window in the main process's registry of windows. Reversal is a small edit in main's window module (remove the registry's hold, its lint suppression and its comment). No migration. Reversal cost is functionally zero and the blast radius is main's window module. The Antithesis, Synthesis and Failure Mode sections are here anyway, because they carry the measurement that falsifies the usual reason for keeping the reference.

---

## Context

The desktop app's main process builds every window of the app. It builds the hidden console window at start, inside the `app.whenReady().then(...)` callback, never shows it and keeps it until quit, and every window a person sees when that window's document opens it with `window.open`: a window of session views, the first included, or a side pane's own window. No window a person sees is the main one. Main holds each window in its registry of windows, keyed by the window id the renderer names it with, and a window's `closed` handler removes its entry.

The widely repeated reason for that pattern is a garbage-collection claim: losing every JS reference to a window lets V8 collect it, which closes the window, which fires `window-all-closed` and quits the app — the desktop app disappearing shortly after launch. This ADR records that the claim is false for the Electron we ship, and why the reference is kept regardless.

## Problem Statement

What anchors the reachability of each main-process window wrapper across the unwind of the callback that built it, measured on Electron 41.6.1 and held on 44.5.1, and what shape should our user-side code take given that anchor?

### Trigger

A test that fails when the module-scope reference is removed can exist only if the failure mode is real, and the measurement below finds that it is not.

---

## Decision

Main keeps a strong reference to every window it builds in its registry of windows, from the moment it builds the window until that window's `closed` handler removes the entry, **as defensive consistency with the canonical Electron community pattern**. Every window is held the same way, because every window of the app is one kind and none is the main one: the hidden console window main builds at start, a window of session views, and a side pane's own window, the last two built around the hidden console document's `window.open`. The reachability invariant Spec-021's acceptance criterion asserts (every window stays live across the unwind of the callback that built it; `window-all-closed` does not fire spuriously) is in fact anchored by Electron's native-side `BaseWindow::self_ref_` — not by the registry's reference.

**The rule is the base class's, and so holds for every window the console creates.** The anchor measured here is `BaseWindow::self_ref_`, and Electron's own API makes `BrowserWindow` a subclass of `BaseWindow` — its type definitions at the pinned Electron declare `class BrowserWindow extends BaseWindow` — so a reading taken on a `BrowserWindow` is a reading of the base class's mechanism. Every console window is a `BaseWindow` hosting the renderer and each page as a `WebContentsView` under [ADR-034](034-embedded-browser-for-preview.md), and both halves of this decision reach each of them unchanged: the registry's reference stays, for the same defensive reason, and the native anchor is the one this investigation identified. The lifecycle guard, the desktop's window-retention test under forced garbage collection, passes on Electron 44.5.1 on macOS, the line [ADR-015](015-electron-desktop-app.md) pins; the measurements below stand as what they were, taken on a `BrowserWindow` at the Electron they name.

### Thesis — Why This Option

Three reasons support keeping the user-side reference even though it is empirically not the load-bearing GC anchor:

1. **Convention with the Electron community.** Electron's official tutorials, security checklist, and the bulk of OSS Electron apps hold their windows in a module- or top-scope reference (`let mainWindow`, or a collection where there are several windows). A reader inheriting our code finds the pattern they expect. Removing it would create a low-key surprise that requires the inheriting reader to internalize the `self_ref_` mechanism before they can reason about lifecycle.
2. **Asymmetric risk.** If a future Electron release changes `BaseWindow::self_ref_` lifetime semantics (e.g., transitioning to a weak-handle model and exposing user-land as the only GC anchor), the registry's reference is the difference between a regression that surfaces at upgrade time vs. a regression that ships silently. The cost of keeping the reference is one registry entry per window, one comment, and one lint suppression; the cost of being wrong about Electron internals 6 quarters from now is the desktop app failing to boot.
3. **Zero downside.** The registry is written in two places: where main builds a window, and in that window's `closed` handler. It does not block GC of any other heap state. It does not affect bundle size after minification. It does not add a maintenance burden.

### Antithesis — The Strongest Case Against

A skeptical staff engineer would argue:

> The registry's strong reference to each window encodes a false mechanism claim. Read literally, "without this, V8 may garbage-collect the only live handle once the callback's stack frame unwinds" is empirically not what would happen in Electron 41.6.1, because `BaseWindow::self_ref_` (`v8::Global<v8::Value>` at `shell/browser/api/electron_api_base_window.h`) strong-roots the JS wrapper from `InitWith` (`electron_api_base_window.cc`: `self_ref_.Reset(isolate, wrapper);`) until native-object destruction (`electron_api_base_window.cc`: `self_ref_.Reset();` in the destructor). Keeping a user-side reference whose comment claims it prevents GC, when in fact the native binding is what prevents GC, is a stale-comment risk waiting to bite a future reader. Better to remove the reference, document the actual mechanism inline, and let the codebase tell the truth.

The empirical evidence behind the antithesis is strong. We ran a primary-source investigation of Electron 41.6.1 + V8 v14.6.202.34-electron.0, and the lifecycle guard that encodes its invariant, the desktop's window-retention test under forced garbage collection, passes on Electron 44.5.1 on macOS, the line [ADR-015](./015-electron-desktop-app.md) pins:

- **Wrapper anchor.** `electron_api_base_window.h` declares `v8::Global<v8::Value> self_ref_;` with the inline comment "Reference to JS wrapper to prevent garbage collection." `electron_api_base_window.cc` sets it in `InitWith` (called as part of `BaseWindow`'s gin-helper constructor); `electron_api_base_window.cc` is the only site that releases it (the C++ destructor). `OnWindowClosed` emits the JS `closed` event and posts the native-destroy task but does NOT reset `self_ref_` itself — the release happens in the destructor that task runs, so the wrapper outlives the JS `closed` event by at least that posted task and is collectable afterwards.
- **`window-all-closed` trigger.** `WindowList::RemoveWindow` (`shell/browser/window_list.cc`) operates on a `WindowVector` of raw `NativeWindow*` pointers. The `OnWindowAllClosed` notification fires when that vector empties — i.e., when native windows are destroyed, not when JS wrappers are collected.
- **Empirical window-retention probe.** The probe (inlined verbatim in §References, run 2026-09-02 on Electron 41.6.1 / Node 24.15.0 / V8 14.6.202.34-electron.0) measures `v8.queryObjects(BrowserWindow, { format: "count" })` beside a plain-object negative control; the two readings the argument rests on — the unreferenced-open and post-close samples — are taken only after event dispatch has unwound (two macrotasks) and two bare `gc()` calls, while the baseline and the referenced-open reading are sampled directly (the baseline right after one `gc()`, the referenced reading right after construction), since neither is asked to show what a collection releases. Baseline `0`; one open window matches `2` (its instance plus one additional fixed match that a count-only sample cannot identify, present from the first construction onward — a second window takes the count to `3` — so the discriminating quantity is the delta from baseline); with the only JS reference nulled and the window still open the count stays `2` while the control drops `1 → 0` — an open window's wrapper survives a full major collection with no user-side reference, which is the claim this ADR rests on. After `close()`, once the `closed` dispatch has unwound, the count drops to `1` (the unidentified fixed match; the instance is released, consistent with the destructor running from the posted destroy task) and holds there at +250 ms and +1250 ms. A count taken synchronously inside the `closed` listener (`countAfterClose: 2`, measured 2026-05-18) is a pre-destruction measurement, not a post-close one: `OnWindowClosed` emits `closed` and only posts the task whose destructor later resets `self_ref_`, so during that listener the wrapper is still natively rooted by `self_ref_` regardless of any dispatch frame; such a count does not bear on the open-window claim. Because a count-only sample cannot tell the instance from the fixed match, the lifecycle guard (`apps/desktop/tests/lifecycle.gc.test.ts`) asserts a stable count across its GC cycles and a per-window delta once every window is closed, rather than a bare `≥ 1` that the fixed match alone would satisfy.
- **V8 `gc()` semantics.** From `src/extensions/gc-extension.cc`: bare `gc()` resolves to `PreciseCollectAllGarbage` (major collection, synchronous, precise mode — all roots traced). `gc(true)` falls through `GetDefaultForTruthyWithoutOptionsBag()` to a Scavenger-only minor pass that does NOT trace old-generation. The `gc(true)` form is therefore a silent footgun in any GC-pressure test — it would leave old-generation BrowserWindow wrappers intact and yield false-negative "still reachable" results. Our probe uses bare `gc()` in the main process (`apps/desktop/src/main/probes/gc-probe.ts`); the test enforces `globalGcAvailable === true` to detect the case where `--expose-gc` was not forwarded.

If the wrapper cannot be collected while the native object lives, and `window-all-closed` fires from native-object removal rather than wrapper collection, then the registry's reference does not prevent the failure mode it is usually credited with preventing. "Losing all JS references allows the window to be garbage-collected" is not the operative mechanism in Electron 41.6.1, and the invariant holds on 44.5.1.

### Synthesis — Why It Still Holds

The antithesis is empirically correct about Electron 41.6.1's mechanism. Two things follow from it:

1. **The header comment above main's registry of windows** cites this ADR and names `BaseWindow::self_ref_` as the load-bearing mechanism. The registry's reference is defensive consistency with the canonical Electron community pattern, not the GC anchor.
2. **The Spec-021 acceptance criterion** encodes the observable lifecycle invariant directly — a `queryObjects(BaseWindow)` count that holds stable across the probe's GC cycles and drops by at least one per window once every window is closed, with `window-all-closed` not firing during the probe iteration loop. It does not assert that the test fails when the registry's reference is removed, because that is false in Electron 41.6.1; and it does not settle for a bare `>= 1`, which the fixed non-instance match satisfies with the instance gone.

What does not change: the registry's strong reference to each window. The asymmetric-risk argument in the Thesis stands. The cost of being wrong about Electron internals is paid out unbounded years from now in the form of "the desktop app stopped booting after the Electron upgrade and we cannot bisect because the change happened in vendor code"; the cost of keeping a redundant reference is paid right now in the form of one comment that has to remain accurate. We pay the second cost.

The lifecycle regression test we ship in `apps/desktop/tests/lifecycle.gc.test.ts` is honest about what it observes: it asserts the observable invariant (a `queryObjects(BaseWindow)` count that holds stable across 20 GC pressure cycles and drops by at least one per window once every window is closed and the close has unwound — the per-window delta that tells the instance from the fixed match; a probe-scoped `window-all-closed` listener does not fire mid-loop) without claiming that removing the registry's reference would cause the test to fail. It exists as a future-regression guard, not as proof that user-side retention is causally load-bearing.

---

## Alternatives Considered

### Option A: Keep a strong reference to every window in main's registry (Chosen)

- **What:** Main's registry of windows holds each window from the moment main builds it until its `closed` handler removes the entry; every window is held alike, with no main window. The header comment and Spec-021's acceptance criterion cite ADR-023 and `BaseWindow::self_ref_` as the load-bearing mechanism.
- **Steel man:** Matches the canonical Electron community pattern (zero learning-curve cost for an inheriting reader who has any Electron exposure). Provides defense-in-depth against a hypothetical future Electron release that shifts `self_ref_` semantics. Costs one registry entry per window, one comment, one lint suppression — no runtime cost, no bundle-size cost, no maintenance burden beyond keeping the comment accurate.
- **Weaknesses:** The registry's hold is empirically a no-op for the failure mode it is credited with preventing. A future reader who skims past the ADR citation in the comment could re-encode the false mechanism claim in a derived doc. Mitigation: the comment cites this ADR by number, and the ADR captures the falsification.

### Option B: Hold no reference to a window, rely solely on `self_ref_` (Rejected)

- **What:** Build each window and let every reference to it fall out of scope when the callback that built it unwinds, documenting the `self_ref_` mechanism inline where windows are built.
- **Steel man:** Codebase tells the empirical truth (the JS reference is not what anchors reachability; the native binding is). No stale-comment risk. One fewer variable to keep in sync. The community-pattern argument is weak in our codebase specifically because we have a comment block + an ADR that documents the real mechanism — an inheriting reader who reads our code is more likely to understand `self_ref_` than the average Electron developer.
- **Why rejected:** The asymmetric-risk argument (Thesis #2) is load-bearing. If Electron's `BaseWindow::self_ref_` lifetime model shifts in a future release — say, moving to a weak `v8::Global<v8::Value>` with FinalizationRegistry semantics, or surfacing user-land as the canonical anchor for ESM-mode main processes — the registry's reference is the difference between "noticed at upgrade time, fixed in one PR" and "silently broken in a release that ships." The cost of keeping the reference is fully paid (one comment, one variable, one lint-disable); the cost of being wrong about a future Electron version is unbounded. Reject.

### Option C: WeakRef + FinalizationRegistry (Rejected)

- **What:** Hold the BrowserWindow via `new WeakRef(browserWindow)` + register cleanup with `new FinalizationRegistry(...)` so the lifecycle is observable from user-land without strong-rooting.
- **Steel man:** Tests can observe wrapper collection directly. Aligns with the "JS-side, not native-side" philosophy that some modern web codebases prefer.
- **Why rejected:** (a) **Heisenberg observer effect.** Holding a `WeakRef` does not affect GC, but the act of _checking_ `weakRef.deref()` in our probe would influence the V8 reachability graph during the very GC pressure cycle we're measuring. (b) **No mechanism benefit.** The native `self_ref_` keeps the wrapper alive regardless of user-side weak/strong status — so a `WeakRef` would observe the same "always reachable" state we already observe via `v8.queryObjects(BaseWindow)`. (c) **Added complexity.** FinalizationRegistry semantics are notoriously fragile across V8 versions; introducing one into the file that decides whether the desktop boots buys nothing observable.

### Option D: `BrowserWindow.getAllWindows()` re-acquire pattern (Rejected)

- **What:** Drop all references after creation; re-acquire the window via `BrowserWindow.getAllWindows()[0]` wherever needed in the lifecycle.
- **Steel man:** Treats the BrowserWindow as fully native-owned, with user-land merely a query interface. No stale-reference risk because there are no user-land references.
- **Why rejected:** The app has many windows and none is the main one, and Electron's `BrowserWindow.getAllWindows()` returns windows in an order that is not documented as stable, so no index names a window. It also cannot tell a window of session views from a side pane's own window, which main must tell apart to pair a pane window's close with its return, nor find a window by the id its saved place is kept under. Re-acquiring on each use also adds noise to every site that needs a window. The complexity cost is real and the benefit is purely aesthetic ("we don't have any user-side reference"). Reject.

### Option E: IPC-keepalive (Rejected)

- **What:** Spin up a recurring IPC handshake between main and renderer that keeps the wrapper hot.
- **Steel man:** None worth elaborating — this is a heavyweight workaround for a problem that does not exist in Electron 41.6.1.
- **Why rejected:** Adds bidirectional message traffic to keep an object alive that is already strong-rooted by `self_ref_`. Costs CPU + battery + complexity for zero benefit.

---

## Reversibility Assessment

- **Reversal cost:** Minutes. Remove the registry's strong hold on each window, its `closed`-handler removal and the comment block; the registry keeps whatever else main uses it for (the window ids, the focus order). Document the new mechanism inline in main's window module.
- **Blast radius:** Main's window module alone.
- **Migration path:** No migration required. The desktop app continues to work identically (the registry's hold is empirically a no-op for the failure mode it claimed to prevent; removing it changes nothing observable).
- **Point of no return:** None. This is a Type 1 decision throughout the V1 lifecycle. Re-evaluation triggers (see Failure Mode Analysis below) signal the moment to revisit; they do not gate reversibility.

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Future Electron release changes `BaseWindow::self_ref_` lifetime semantics | Low | High (desktop app fails to boot) | `apps/desktop/tests/lifecycle.gc.test.ts` Shape B fires (`allClosedFired === true`) on the next Electron-version-bump CI run | The registry's retained reference is the user-side anchor that buys time to investigate the new Electron mechanism without an immediate ship-stop. Mitigation: keep the registry's hold in place. |
| `self_ref_` and the registry's reference both fail to anchor (unknown future Electron rewrite) | Very low | High | Shape A (`probe.min < 1`) in lifecycle test, or Shape C (probe never emits) | Add `BrowserWindow.getAllWindows()` re-acquire as a third defense layer in the same PR that diagnoses the failure. |
| Future contributor reads the user-side reference, infers the false "this prevents GC" mechanism, propagates the belief to a derived doc | Medium — the comment is the only thing standing between a reader and the folklore | Low-Medium (no runtime impact; documentation drift) | The next edit to main's registry of windows reads the header comment | The comment cites ADR-023 inline; ADR-023 captures the falsification. The cite is the safeguard. |
| The lifecycle test itself drifts (e.g., bare `gc()` semantics change in a future V8) | Low | Medium (test becomes flaky or no-op) | Test setup-correctness gates assert `globalGcAvailable === true` and `queryObjectsAvailable === true`; either dropping to false indicates harness drift | Pin V8 version in CI matrix; ADR-023 captures the gc-extension.cc semantics so a future contributor can re-derive the assertion. |

---

## Consequences

### Positive

- **Convention parity with the Electron community.** An inheriting reader's intuition (from Electron tutorials, security checklist, third-party Electron apps) maps directly onto our code.
- **Defense-in-depth against future Electron internals shift.** If `self_ref_` semantics change, our user-side reference buys diagnostic time at the upgrade boundary.
- **Honest spec.** [Spec-021 §Acceptance Criteria](../specs/021-desktop-app-and-renderer.md#acceptance-criteria) encodes the observable lifecycle invariant directly, never a predicate that the test fails when the reference is removed, and cites [ADR-023 §Antithesis — The Strongest Case Against](./023-electron-main-process-window-retention.md#antithesis--the-strongest-case-against) for the empirical mechanism truth.
- **Honest test.** `apps/desktop/tests/lifecycle.gc.test.ts` asserts the observable contract and explicitly documents in its header that it is a future-regression guard, not a causal-mechanism demonstration.

### Negative (accepted trade-offs)

- **Empirical no-op.** The registry's hold does not prevent the failure mode it is credited with preventing. We carry one registry entry per window, one comment, one lint suppression for asymmetric-risk reasons, not because the mechanism needs them.
- **Comment-rot risk if the inline ADR-023 citation is removed or weakened.** Mitigation: the ADR is named in the comment block and in Spec-021 AC; removing the citation in a future edit would surface in code review.
- **The lifecycle test passes with or without the registry's hold.** This is honest about what the test observes (the observable invariant holds either way on Electron 41.6.1). A test that _did_ discriminate would require deliberately disabling `self_ref_` at the Electron binding level, which is out of scope for user-land.

### Unknowns

- Whether `BaseWindow::self_ref_` keeps its strong-anchor semantics in Electron releases after the 44.5.1 pin. The source was read at 41.6.1 and the lifecycle guard passes on 44.5.1 on macOS, so the semantics hold on the pin; a later Electron is the load-bearing assumption for the "empirical no-op" framing above.
- Whether any window the app builds is user-anchor-dependent for some reason we have not yet found. Every window is a `BaseWindow`, built either at start or by main's window-open handler around the renderer's `window.open`, and each is held by the registry and anchored by `BaseWindow::self_ref_`; the lifecycle guard covers every window, and a new way of building a window is read against the same Electron sources when it lands.

---

## References

### Primary sources (Electron v41.6.1)

Read at the exact `v41.6.1` tag on 2026-09-02 through the GitHub contents API (`gh api repos/electron/electron/contents/<path>?ref=v41.6.1`), so every citation below is to that tag.

- `shell/browser/api/electron_api_base_window.h` — `v8::Global<v8::Value> self_ref_;` field declaration, with the inline comment above it "Reference to JS wrapper to prevent garbage collection."
- `shell/browser/api/electron_api_base_window.h` — `class BaseWindow : public gin_helper::TrackableObject<BaseWindow>, private NativeWindowObserver` (the gin-helper inheritance that wires `self_ref_` into the JS wrapper lifecycle).
- `shell/browser/api/electron_api_base_window.h` — `std::unique_ptr<NativeWindow> window_;` (the native-window owner).
- `shell/browser/api/electron_api_base_window.cc` — `self_ref_.Reset(isolate, wrapper);` (inside `InitWith`: the wrapper is captured strong-rooted as part of construction).
- `shell/browser/api/electron_api_base_window.cc` — `self_ref_.Reset();` (inside the destructor: the only release site, reached through the destroy task `OnWindowClosed` posts).
- `shell/browser/api/electron_api_base_window.cc` — `OnWindowClosed()` method (marks the object destroyed, emits the JS `closed` event, and posts the destroy closure; does NOT reset `self_ref_` itself).
- `shell/browser/window_list.cc` — `WindowList::RemoveWindow` triggers the `OnWindowAllClosed` notification when the `WindowVector` of raw `NativeWindow*` pointers becomes empty.

### Primary sources (V8 v14.6.202.34-electron.0)

The `globalThis.gc()` mode semantics below are read from the V8 source at the upstream tag Electron 41.6.1 builds from — `src/extensions/gc-extension.cc` at tag `14.6.202.34` (<https://chromium.googlesource.com/v8/v8/+/refs/tags/14.6.202.34/src/extensions/gc-extension.cc>, read 2026-09-02). Electron's V8 patches at tag `v41.6.1` (`patches/v8/.patches`) touch no line of this file, so the upstream tag is the code that runs; the `-electron.0` suffix marks that patch set, not a fork of this extension. The return value of `gc()` establishes none of this — every mode returns `undefined` — so the empirical rows below cite this source for the mode claim and their own output only for flag passthrough and the retention count.

- `gc-extension.cc` — `GCExtension::GC` with zero arguments → `InvokeGC(isolate, GCOptions::GetDefault())`.
- `gc-extension.cc` — `GCOptions::GetDefault()` = `{GCType::kMajor, ExecutionType::kSync, Flavor::kRegular}`.
- `gc-extension.cc` — `InvokeGC` on `kMajor` / `kRegular` → `heap->PreciseCollectAllGarbage(GCFlag::kNoFlags, GarbageCollectionReason::kTesting, kGCCallbackFlagForced)`: the full-heap collection, run inline on the calling thread under `StackState::kMayContainHeapPointers` — the "major, synchronous, precise" reading is the function's own name and the switch it sits in.
- `gc-extension.cc` — a truthy non-object argument (`gc(true)`) that carries no options bag → `GetDefaultForTruthyWithoutOptionsBag()` = `{GCType::kMinor, …}`, and `InvokeGC` on `kMinor` → `heap->CollectGarbage(NEW_SPACE, …)`: young-generation Scavenger only — the silent footgun that leaves old-generation objects intact.
- `gc-extension.cc` — the `gc({type, execution, flavor, filename})` options bag: `type` `minor` / `major` / `major-snapshot`, `execution` `sync` / `async`, `flavor` `regular` / `last-resort` (`CollectAllAvailableGarbage`) — the long-term-stable structured form if V8 ever flips the default.

### Empirical research (this investigation)

| Source | Type | Key finding | URL/Location |
| --- | --- | --- | --- |
| Sanity check — `v8.queryObjects(Object)` return shape on host Node 22.9.0 | Primary research | `queryObjects(constructor)` returns a `number` count in both the default and the `{ format: "count" }` forms. Reproduce with `node -e 'const v8 = require("node:v8"); console.log(typeof v8.queryObjects(Object), typeof v8.queryObjects(Object, { format: "count" }))'`, which prints `number number`. | Node.js v22 V8 docs, `v8.queryObjects(ctor[, options])` — `format: 'count'` is documented and the API was added in v22.0.0: <https://nodejs.org/docs/latest-v22.x/api/v8.html> |
| Window-retention probe — Electron BrowserWindow prototype-chain match | Primary research | The probe is the script inlined verbatim below this table, run as `apps/desktop/node_modules/.bin/electron --js-flags=--expose-gc window-retention-probe.cjs`. The unreferenced-open and post-close readings are taken after event dispatch has unwound (two macrotasks) and two bare `gc()` calls, beside a plain-object negative control; the baseline and referenced-open readings are sampled directly (after one `gc()` and right after construction respectively), on Electron 41.6.1 / Node 24.15.0 / V8 14.6.202.34-electron.0 on 2026-09-02. Baseline `0`. One open, referenced window: `2` (the instance plus one additional fixed match a count-only sample cannot identify, present from the first construction onward; a second window reads `3`, so the delta from baseline is the discriminating quantity). Open with the only JS reference nulled, after full GC: `2`, control `1 → 0` — the load-bearing reading: an open window's wrapper is not collected without a user-side reference. Closed, dispatch unwound, after full GC: `1` (the instance released; the fixed match remains), holding at +250 ms and +1250 ms. Two windows closed one at a time through a helper whose frame returns before each collection released both (`3 → 2 → 1`), and a third window opened and closed afterwards released normally. Closing two windows from a `for … of` loop inside a suspended async frame leaves one match through +5 s, because that frame retains the final iteration binding (the loop-frame control inlined below reproduces it over plain objects: one object stays visible to `queryObjects` through five seconds from the suspended frame and none from a helper whose frame returns); that reading is a property of the loop frame, not Electron behavior. | Electron `--js-flags` command-line switch: <https://www.electronjs.org/docs/latest/api/command-line-switches>; Node.js v22 `v8.queryObjects`: <https://nodejs.org/docs/latest-v22.x/api/v8.html> |
| `--expose-gc` passthrough + `globalThis.gc()` semantics | Primary research | The same inlined probe prints `typeof gc: function` and `gc() returned: undefined` on Electron 41.6.1, which establishes exactly one thing — the flag reaches the main process and a bare `gc()` is callable there. Which collection ran is not observable from that return value (it is `undefined` for every mode); the major + synchronous + precise reading, the `gc({ type: "major", execution: "sync" })` structured equivalent, and the rejection of `gc(true)` as the MINOR Scavenger-only form rest on the V8 source cited under §Primary sources above. | Electron `--js-flags` command-line switch: <https://www.electronjs.org/docs/latest/api/command-line-switches>; V8 `gc-extension.cc` at tag `14.6.202.34`: <https://chromium.googlesource.com/v8/v8/+/refs/tags/14.6.202.34/src/extensions/gc-extension.cc> |

The window-retention probe, verbatim — save it anywhere as `window-retention-probe.cjs` and run it from the desktop package's Electron binary with `--js-flags=--expose-gc`; its 2026-09-02 output lines are recorded as trailing comments:

```js
const { app, BrowserWindow } = require("electron");
const v8 = require("node:v8");
const { setImmediate: nextMacrotask, setTimeout: sleep } = require("node:timers/promises");
const count = (constructor) => v8.queryObjects(constructor, { format: "count" });
const settleAndCollect = async () => {
  await nextMacrotask(); // let any in-flight event dispatch and its native frames unwind
  await nextMacrotask();
  globalThis.gc();
  globalThis.gc();
};
class ControlSubject {}
app.on("window-all-closed", () => {}); // keep the process alive past the last close so the late stages can run
app.whenReady().then(async () => {
  console.log("typeof gc:", typeof globalThis.gc, "| gc() returned:", String(globalThis.gc())); // typeof gc: function | gc() returned: undefined
  console.log("baseline (no window):", count(BrowserWindow)); // baseline (no window): 0
  let control = new ControlSubject();
  let browserWindow = new BrowserWindow({ show: false });
  console.log("open, referenced:", count(BrowserWindow), "| control:", count(ControlSubject)); // open, referenced: 2 | control: 1
  const closed = new Promise((resolve) => browserWindow.once("closed", resolve));
  browserWindow = null;
  control = null;
  await settleAndCollect();
  console.log(
    "open, unreferenced, after gc:",
    count(BrowserWindow),
    "| control:",
    count(ControlSubject),
  ); // open, unreferenced, after gc: 2 | control: 0
  BrowserWindow.getAllWindows()[0].close();
  await closed;
  await settleAndCollect();
  console.log("closed, unwound, after gc:", count(BrowserWindow)); // closed, unwound, after gc: 1
  await sleep(250);
  await settleAndCollect();
  console.log("closed +250 ms, after gc:", count(BrowserWindow)); // closed +250 ms, after gc: 1
  await sleep(1000);
  await settleAndCollect();
  console.log("closed +1250 ms, after gc:", count(BrowserWindow)); // closed +1250 ms, after gc: 1
  app.exit(0);
});
```

The `3` reading and the sequential-close observation in the window-retention probe row come from the following script, run the same way on the same date; output lines are again recorded as trailing comments. Each close goes through a helper whose frame returns before the next collection, so no loop binding can root a window across the samples:

```js
const { app, BrowserWindow } = require("electron");
const v8 = require("node:v8");
const { setImmediate: nextMacrotask, setTimeout: sleep } = require("node:timers/promises");
const count = () => {
  globalThis.gc();
  globalThis.gc();
  return v8.queryObjects(BrowserWindow, { format: "count" });
};
const closeAndSettle = async (browserWindow) => {
  const closed = new Promise((resolve) => browserWindow.once("closed", resolve));
  browserWindow.close();
  await closed;
  await sleep(500);
  await nextMacrotask();
};
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  console.log("baseline:", count()); // baseline: 0
  new BrowserWindow({ show: false });
  new BrowserWindow({ show: false });
  await nextMacrotask();
  await nextMacrotask();
  console.log("two open, unreferenced:", count()); // two open, unreferenced: 3
  await closeAndSettle(BrowserWindow.getAllWindows()[0]);
  console.log("first closed +500 ms:", count()); // first closed +500 ms: 2
  await closeAndSettle(BrowserWindow.getAllWindows()[0]);
  console.log("second closed +500 ms:", count()); // second closed +500 ms: 1
  await sleep(2000);
  await nextMacrotask();
  console.log("second closed +2500 ms:", count()); // second closed +2500 ms: 1
  new BrowserWindow({ show: false });
  await nextMacrotask();
  await nextMacrotask();
  console.log("third opened (unreferenced):", count()); // third opened (unreferenced): 2
  await closeAndSettle(BrowserWindow.getAllWindows()[0]);
  console.log("third closed +500 ms:", count()); // third closed +500 ms: 1
  app.exit(0);
});
```

The loop-frame control behind that reading, run 2026-09-02 as `ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/.bin/electron --expose-gc loop-frame-control.cjs` (Electron 41.6.1's Node 24.15.0) and as `node --expose-gc loop-frame-control.cjs` (host Node 24.18.0), with identical output on both:

```js
const v8 = require("node:v8");
const { setImmediate: nextMacrotask, setTimeout: sleep } = require("node:timers/promises");
class Subject {}
const count = () => {
  globalThis.gc();
  globalThis.gc();
  return v8.queryObjects(Subject, { format: "count" });
};
async function loopInSuspendedFrame() {
  const subjects = [new Subject(), new Subject()];
  for (const subject of subjects) subject.touched = true; // the loop binding lives in THIS frame
  subjects.length = 0;
  await nextMacrotask();
  await nextMacrotask();
  console.log("loop frame, +0 ms:", count()); // loop frame, +0 ms: 1
  await sleep(5000);
  console.log("loop frame, +5000 ms:", count()); // loop frame, +5000 ms: 1
}
async function loopInReturnedHelper() {
  const subjects = [new Subject(), new Subject()];
  const touchAll = (list) => {
    for (const subject of list) subject.touched = true; // this frame returns before the samples
  };
  touchAll(subjects);
  subjects.length = 0;
  await nextMacrotask();
  await nextMacrotask();
  console.log("helper frame, +0 ms:", count()); // helper frame, +0 ms: 0
  await sleep(5000);
  console.log("helper frame, +5000 ms:", count()); // helper frame, +5000 ms: 0
}
(async () => {
  await loopInSuspendedFrame();
  await loopInReturnedHelper();
})();
```

### Related ADRs

- `ADR-015` — Electron desktop app (V1 desktop architecture; this ADR is a derived contract addition).
- `ADR-021` — V1 toolchain selection (the Node 24.21 floor, with the `better-sqlite3` 13.x Node-API-10 prebuild; V8 14.6.202.34-electron.0 is the Electron 41.6.1 engine this ADR's probe measured, and the lifecycle guard passes on the Electron 44.5.1 pin).
- `ADR-022` — V1 CI/CD and release automation (the CI surface that runs the lifecycle guard on every pull request that touches the desktop app).

### Platform scope note

The window-retention probe and its `queryObjects` empirical baseline ran on macOS (darwin 25.3.0) only. Cross-platform behavior of `v8.queryObjects()`, `--expose-gc` forwarding, and the gin/v8 wrapper chain is extrapolated from V8 + Electron upstream sources (single-tree, no platform-specific GC paths affecting these primitives). The CI matrix exercises `lifecycle.gc.test.ts` on Linux (Ubuntu 24.04) on every PR, providing cross-platform regression coverage at the integration level.

### Citation scope note

Every Electron and V8 citation above is to the tag read on 2026-09-02: the Electron files were read at the `v41.6.1` tag through the GitHub contents API and `gc-extension.cc` at V8 tag `14.6.202.34` (the upstream base of `14.6.202.34-electron.0`, which Electron's V8 patches at that tag leave untouched). The window-retention probe — run against `apps/desktop/node_modules/.bin/electron` at Electron 41.6.1 — confirms that the BEHAVIOR these citations describe (the `self_ref_` strong anchor while a window is open; the bare-`gc()` semantics) is active in that version, and the lifecycle guard holds it on the Electron 44.5.1 pin, which is the load-bearing claim; the source, not the probe's return values, carries the mechanism claims. Field and method names cited here (`self_ref_`, `InitWith`, `OnWindowClosed`, `RemoveWindow`, `PreciseCollectAllGarbage`) are stable across the active Electron release line.
