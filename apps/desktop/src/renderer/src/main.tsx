// Renderer entrypoint — Plan-023 Phase 1 (T-023p-1-5) substrate.
//
// Mounts the placeholder <App /> tree into the `#root` element declared in
// apps/desktop/src/renderer/index.html using the React 19 idiomatic root API
// (`createRoot` from `react-dom/client` — replaces the legacy
// `ReactDOM.render` API removed in React 18, see React 19 release notes).
//
// Tier 1 carve-outs (deferred to Tier 8 remainder per
// `docs/plans/023-desktop-shell-and-renderer.md §Tier 1 Partial PR Sequence`,
// the Phase 1 renderer-entrypoint bullet):
//   • No Sentry-renderer init (`@sentry/electron/renderer`). The Sentry SDK
//     does not auto-initialize renderers in v7; explicit init lands at Tier 8
//     when the dependency itself lands.
//   • No StrictMode wrapper at Tier 1. The substrate proves mount; StrictMode
//     opt-in is a Tier 8 decision once real feature views exist and we want
//     the double-invocation diagnostic.
//   • No `navigator.clipboard` runtime assertion. Plan-023 §Risks And Blockers
//     specifies a `expect(navigator.clipboard).toBeUndefined()` assertion to
//     catch transitive-dep regressions; that lands alongside the ESLint
//     `no-restricted-imports` ban at T-023p-1-6 + Tier 8 hardening pass.
//
// Renderer-untrusted constraint (Spec-023 §Trust Stance): NO imports of
// `electron` / `node:*` / `fs` / `path` / `process` / `os` / `child_process` /
// `net` / `./src/main/**` / `./src/preload/**`. The ESLint enforcement lands
// immediately after this task at T-023p-1-6.

import { createRoot } from "react-dom/client";

import { App } from "./App.js";

/** The mount point `apps/desktop/src/renderer/index.html` declares. */
const ROOT_ELEMENT_ID = "root";

/**
 * Raised when the entry HTML carries no mount point.
 *
 * A named class rather than the `!` non-null assertion this used to carry.
 * Failing fast was the right posture; the assertion's problem is WHAT it fails
 * with — `createRoot(null)` throws React's own "Target container is not a DOM
 * element", a message that names neither the document that was supposed to
 * declare the element nor the id that was looked up, in a window whose only
 * other symptom is a white rectangle. Both facts are known here, so both are
 * stated here.
 */
class MissingRootElementError extends Error {
  public constructor() {
    super(
      `renderer entry document declares no #${ROOT_ELEMENT_ID} element ` +
        `(expected it in apps/desktop/src/renderer/index.html) — nothing to mount into`,
    );
    this.name = "MissingRootElementError";
  }
}

const container = document.getElementById(ROOT_ELEMENT_ID);
if (container === null) {
  throw new MissingRootElementError();
}

createRoot(container).render(<App />);
