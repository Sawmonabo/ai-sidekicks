// Plan-001 Phase 5 T5.2 (Lane C) — renderer root component.
//
// Pre-T5.2 (Plan-023 Phase 1 T-023p-1-5): this file rendered an inert
// 4-line placeholder (`<main><h1>AI Sidekicks</h1>…</main>`) to prove the
// React 19 toolchain mounts under Electron's renderer-untrusted boundary.
// T5.2 replaces that placeholder with the first real renderer view —
// `<SessionBootstrap />`, which exercises the preload bridge by calling
// `window.sidekicks.daemon.call("session.create", {})` on mount.
//
// Renderer-untrusted constraint (Spec-023 §Trust Stance) still holds —
// this file imports only renderer-safe code (`./session-bootstrap/index.ts`,
// which transitively imports only `react` and type/value symbols from
// `@ai-sidekicks/contracts`). The eslint `no-restricted-imports` rule
// (`apps/desktop/eslint.config.mjs`) enforces the ban list at lint time.

import { SessionBootstrap } from "./session-bootstrap/index.js";

export function App(): React.JSX.Element {
  return <SessionBootstrap />;
}
