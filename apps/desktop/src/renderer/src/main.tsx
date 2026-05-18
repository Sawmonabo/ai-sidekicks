// Renderer entrypoint — Plan-023 Phase 1 (T-023p-1-5) substrate.
//
// Mounts the placeholder <App /> tree into the `#root` element declared in
// apps/desktop/src/renderer/index.html using the React 19 idiomatic root API
// (`createRoot` from `react-dom/client` — replaces the legacy
// `ReactDOM.render` API removed in React 18, see React 19 release notes).
//
// Tier 1 carve-outs (deferred to Tier 8 remainder per docs/plans/023-desktop-
// shell-and-renderer.md §Files In Scope line 260):
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

// Non-null assertion is appropriate here: `#root` is statically declared in
// `apps/desktop/src/renderer/index.html` (the Vite entry HTML). If the div is
// removed, mount would fail fast at runtime — which is the correct posture
// for a substrate boot probe (the T-023p-1-7 smoke test exercises this path).
const container = document.getElementById("root")!;

createRoot(container).render(<App />);
