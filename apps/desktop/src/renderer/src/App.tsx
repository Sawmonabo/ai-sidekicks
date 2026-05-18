// Renderer placeholder `<App />` component — Plan-023 Phase 1 (T-023p-1-5) substrate.
//
// At Tier 1 the renderer mounts ONLY this placeholder. The five Signature
// Feature views (timeline, approvals, invites, runs, channels) plus the
// top-level router and layout shell land at Plan-023 Tier 8 remainder
// (see docs/plans/023-desktop-shell-and-renderer.md §Target Areas > Renderer lines
// 107-111 — each feature view defers to Tier 8 per its "Tier 8 remainder"
// annotation in §Tier 1 Partial PR Sequence > Phase 1 line 261).
//
// Renderer is the untrusted process per Spec-023 §Trust Stance. At Tier 1
// this file MUST NOT import:
//   • Node built-ins (`node:*`, `fs`, `path`, `process`, `os`, `child_process`,
//     `net`) — enforced by the ESLint flat-config landing at T-023p-1-6.
//   • `electron` — same enforcement.
//   • Anything from `./src/main/**` or `./src/preload/**` — the renderer-
//     untrusted boundary; the only renderer-reachable surface is
//     `window.sidekicks` exposed by the preload bridge (T-023p-1-4).
//
// No `window.sidekicks` consumption at Tier 1: the substrate exists to prove
// the toolchain mounts, NOT to exercise the bridge. The T-023p-1-7 smoke test
// asserts the bridge shape via direct DOM probe, not via this component.

export function App(): React.JSX.Element {
  return (
    <main>
      <h1>AI Sidekicks</h1>
      <p>Desktop Tier 1 substrate.</p>
    </main>
  );
}
