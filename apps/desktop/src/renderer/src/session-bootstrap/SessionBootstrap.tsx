// Plan-001 Phase 5 T5.2 (Lane C) — renderer SessionBootstrap component.
//
// Spec-001 §Acceptance Criteria coverage:
//   • AC1: invokes `session.create` against the daemon via the
//     `window.sidekicks` preload bridge on mount.
//   • AC4: surfaces the error envelope when the call rejects (Tier 1
//     production branch — every Tier-1 daemon call rejects with
//     `NotImplementedAtTier1Error` until Plan-007 lands the real IPC
//     handlers; the renderer must render that branch deterministically).
//
// Renderer-untrusted boundary (Spec-023 §Trust Stance) — this file imports
// ONLY:
//   • `react` — the renderer's UI engine; explicitly allowed.
//   • Type-only from `@ai-sidekicks/contracts` — the contracts package is
//     renderer-safe (no `node:*`, `electron`, or `fs`/`path`/`process`
//     runtime imports); the type-only form means no JS runtime import is
//     emitted at all and only the type-graph view of the bridge surface
//     reaches the renderer.
// No `electron`, no `node:*`, no `./src/main/**`, no `./src/preload/**`,
// and no `@ai-sidekicks/client-sdk` (renderer-untrusted). The eslint
// `no-restricted-imports` rule (apps/desktop/eslint.config.mjs) enforces
// this surface statically.

import { useEffect, useState } from "react";

import type { SessionCreateResponse, SidekicksBridge } from "@ai-sidekicks/contracts";

// Tier-1 stopgap: declare the `window.sidekicks` surface for the renderer's
// TypeScript graph. The preload (`apps/desktop/src/preload/index.ts`) installs
// the bridge at runtime via `contextBridge.exposeInMainWorld('sidekicks', ...)`,
// which is a runtime-only registration — TypeScript needs an ambient
// augmentation to type the resulting `window.sidekicks` access. We colocate
// the declaration in the first renderer consumer file rather than authoring
// a sibling `renderer.d.ts` outside `target_paths`; Plan-023 Tier 8 remainder
// should hoist this to a shared renderer-only declaration file when the
// number of consumers grows beyond a handful.
declare global {
  interface Window {
    sidekicks: SidekicksBridge;
  }
}

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

    daemonCall("session.create", {})
      .then((bridgeResponse) => {
        if (cancelled) return;
        setState({ kind: "resolved", value: bridgeResponse as SessionCreateResponse });
      })
      .catch((bridgeError: unknown) => {
        if (cancelled) return;
        // Tier 1 production branch: every Tier-1 bridge method throws
        // `NotImplementedAtTier1Error` (see
        // `packages/contracts/src/desktop-bridge.ts` `createTier1Bridge`). We
        // do not narrow on instanceof — any `Error` shape is rendered the
        // same way; the AC4 contract is "render the error envelope," not
        // "render a specific error class". Non-Error rejections (string,
        // plain object) are wrapped into an Error so the render branch is
        // always a real Error instance.
        const normalised =
          bridgeError instanceof Error ? bridgeError : new Error(String(bridgeError));
        setState({ kind: "rejected", error: normalised });
      });

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

  // Rejected: render the error envelope. Tier 1 minimum-scope surface uses
  // role="alert" so assistive tech announces the rejection, and shows
  // name + message so a developer can diagnose without devtools. We render
  // the generic `Error` shape (name + message) rather than narrowing on
  // `NotImplementedAtTier1Error` specifically — the AC4 contract is "render
  // the error envelope," and a name-prefixed message conveys the Tier 1
  // stub status when that's the rejection class.
  return (
    <section aria-label="session-bootstrap-error" role="alert">
      <p>
        {state.error.name}: {state.error.message}
      </p>
    </section>
  );
}
