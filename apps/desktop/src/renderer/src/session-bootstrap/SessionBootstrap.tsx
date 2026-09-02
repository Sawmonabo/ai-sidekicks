// Plan-001 Phase 5 T5.2 (Lane C) — renderer SessionBootstrap component.
//
// Spec-001 §Acceptance Criteria coverage:
//   • AC1: invokes `session.create` against the daemon via the
//     `window.sidekicks` preload bridge on mount and renders the returned
//     session id.
// The reject-branch render is a task acceptance criterion (T5.2(d), per
// `docs/plans/001-shared-session-core.md §T5.2 — apps/desktop/src/renderer/src/session-bootstrap/ renderer wiring`), not a Spec-001 AC. Spec-001
// AC4 (join semantics) is T5.1's `sessionClient.join` responsibility — see
// `docs/plans/001-shared-session-core.md §T5.1 — sessionClient.ts daemon + control-plane transport`.
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports
// ONLY:
//   • `react` — the renderer's UI engine; explicitly allowed.
//   • Type-only from `@ai-sidekicks/contracts` — the contracts package is
//     renderer-safe (no `node:*`, `electron`, or `fs`/`path`/`process`
//     runtime imports); the type-only form means no JS runtime import is
//     emitted at all and only the type-graph view of the bridge surface
//     reaches the renderer.
// No `electron`, no `node:*`, no `./src/main/**`, no `./src/preload/**` —
// statically enforced via the `no-restricted-imports` rule in
// apps/desktop/eslint.config.mjs. The `@ai-sidekicks/client-sdk` ban was
// by-convention at Tier 1 and is now structural: Plan-023 T-023p-1C-1 removed
// the package from `apps/desktop/package.json`, having found it declared and
// imported by nothing, so the specifier no longer resolves from this app at
// all. That is a stronger guarantee than the renderer-targeted
// `no-restricted-imports` entry this header used to await — a lint rule reports
// an import the build would still perform, and a dependency that is not
// declared cannot be imported to begin with. The SDK package is Node-side;
// importing it from the renderer would break Spec-023 §Trust Stance.

import { useEffect, useState } from "react";

import type { SessionCreateResponse } from "@ai-sidekicks/contracts";

// The `window.sidekicks` ambient type lives in the renderer-wide
// `sidekicks-bridge.d.ts` (part of this project via the renderer `tsconfig`'s
// `include: ["**/*"]`), so `window.sidekicks` below is `SidekicksBridge`-typed
// without an import here.

type BootstrapState =
  | { kind: "pending" }
  | { kind: "resolved"; value: SessionCreateResponse }
  | { kind: "rejected"; error: Error };

export function SessionBootstrap(): React.JSX.Element {
  const [state, setState] = useState<BootstrapState>({ kind: "pending" });

  useEffect(() => {
    // Strict-mode-safe mount: React 18+ invokes effects twice in dev/strict
    // mode to surface accidental state captures. The `cancelled` flag in the
    // cleanup closure makes the first invocation's promise resolution a no-op
    // so we never call `setState` on an unmounted (or about-to-be-remounted)
    // tree. Without this, the resolved branch could overwrite a pending
    // re-mount's state on the second effect run.
    let cancelled = false;

    // `DaemonMethod` brand cast (Plan-007 Tier 8 follow-up): the contract
    // declares `daemon.call<M extends DaemonMethod>(method: M, ...)` where
    // `DaemonMethod = string & { readonly __plan007_daemon_method__: never }`.
    // At Tier 1 the brand is intentionally `never`-shaped — no string literal
    // is structurally assignable to it until Plan-007 narrows the brand to a
    // string-literal union of real method names. Cast at the call site so the
    // method-name string ("session.create") can be passed without polluting
    // the public bridge type. This single cast site lifts when Plan-007
    // lands the narrowed `DaemonMethod` union (see
    // packages/contracts/src/desktop-bridge.ts §Plan-007 daemon protocol stubs).
    const daemonCall = window.sidekicks.daemon.call as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;

    // Sync-throw normalization for the Tier 1 stub-contract gap: the
    // contract `daemon.call` returns `Promise<DaemonResult<M>>`, but the
    // Tier 1 stub (`createTier1Bridge` in
    // `packages/contracts/src/desktop-bridge.ts`) violates that by throwing
    // synchronously — `() => tier1Throw("daemon.call")`. A bare
    // `daemonCall(...).then(...).catch(...)` would evaluate `daemonCall(...)`
    // first; the sync throw would propagate OUT before `.then` is reached,
    // escape this `useEffect` callback (React 18+ does NOT catch errors
    // thrown from effect callbacks), and leave the component pinned in
    // `kind: "pending"` indefinitely. Wrapping the call in an async IIFE
    // lets `await` normalise sync throws AND async rejections to the same
    // `catch` branch. Plan-007 may fix the stub at a later point; until
    // then the renderer defends against the gap.
    void (async () => {
      try {
        const bridgeResponse = await daemonCall("session.create", {});
        if (cancelled) return;
        setState({ kind: "resolved", value: bridgeResponse as SessionCreateResponse });
      } catch (bridgeError: unknown) {
        if (cancelled) return;
        // Tier 1 production branch: every Tier-1 bridge method throws
        // `NotImplementedAtTier1Error` (see
        // `packages/contracts/src/desktop-bridge.ts` `createTier1Bridge`). We
        // do not narrow on instanceof — any `Error` shape is rendered the
        // same way; the task AC T5.2(d) contract is "render the error envelope," not
        // "render a specific error class". Non-Error rejections (string,
        // plain object) are wrapped into an Error so the render branch is
        // always a real Error instance.
        const normalised =
          bridgeError instanceof Error ? bridgeError : new Error(String(bridgeError));
        setState({ kind: "rejected", error: normalised });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "pending") {
    return (
      <section aria-label="session-bootstrap-pending">
        <p>Creating session…</p>
      </section>
    );
  }

  if (state.kind === "resolved") {
    return (
      <section aria-label="session-bootstrap-resolved">
        <p>session id: {state.value.sessionId}</p>
      </section>
    );
  }

  // role="alert" so assistive tech announces the rejection.
  return (
    <section aria-label="session-bootstrap-error" role="alert">
      <p>
        {state.error.name}: {state.error.message}
      </p>
    </section>
  );
}
