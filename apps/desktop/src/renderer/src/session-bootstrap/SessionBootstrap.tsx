// Renderer SessionBootstrap component: it invokes `session.create` against the
// daemon through the `window.sidekicks` preload bridge on mount and renders the
// returned session id, with a rejected arm that renders the error envelope.
// Join semantics are `sessionClient.join`'s responsibility, not this
// component's.
//
// The renderer is untrusted, so this file imports ONLY:
//   • `react` — the renderer's UI engine; explicitly allowed.
//   • Type-only from `@ai-sidekicks/contracts` — the contracts package is
//     renderer-safe (no `node:*`, `electron`, or `fs`/`path`/`process`
//     runtime imports); the type-only form means no JS runtime import is
//     emitted at all and only the type-graph view of the bridge surface
//     reaches the renderer.
// No `electron`, no `node:*`, no `./src/main/**`, no `./src/preload/**` —
// statically enforced via the `no-restricted-imports` rule in
// apps/desktop/eslint.config.mjs. The `@ai-sidekicks/client-sdk` ban was once a
// convention and is now structural: the package was removed from
// `apps/desktop/package.json`, having been found declared and imported by
// nothing, so the specifier no longer resolves from this app at all. That is a
// stronger guarantee than the renderer-targeted `no-restricted-imports` entry
// this header used to await — a lint rule reports an import the build would
// still perform, and a dependency that is not declared cannot be imported to
// begin with. The SDK package is Node-side; importing it from the renderer
// would breach the renderer's untrusted boundary.

import { useEffect, useRef, useState } from "react";

import type { SessionCreateResponse } from "@ai-sidekicks/contracts";

// The `window.sidekicks` ambient type lives in the renderer-wide
// `sidekicks-bridge.d.ts` (part of this project via the renderer `tsconfig`'s
// `include: ["**/*"]`), so `window.sidekicks` below is `SidekicksBridge`-typed
// without an import here.

type BootstrapState =
  | { kind: "pending" }
  | { kind: "resolved"; value: SessionCreateResponse }
  | { kind: "rejected"; error: Error };

/** The session this component created, as the one fact a caller can act on. */
export interface SessionBootstrapCreated {
  readonly sessionId: string;
}

export interface SessionBootstrapProps {
  /**
   * Told once, when `session.create` settles with a session.
   *
   * ADDITIVE AND OPTIONAL, and the absent case is byte-identical to the behaviour
   * this component shipped with: it still creates from its own mount effect, still
   * renders the three arms below, and still needs no caller. What it could not do
   * before is HAND THE SETTLEMENT ON — it is the only `session.create` caller in
   * this renderer, so the session a start press produced had a name nothing else
   * could learn, and every surface that wanted to open, record, or navigate to it
   * was left counting presses. This prop is that name, and nothing more: the
   * component keeps the call, and the caller becomes the party that hears the
   * result.
   *
   * Not told on the rejected arm. A create that refused produced no session, and a
   * callback carrying an empty id would be a name for something that does not exist.
   */
  readonly onCreated?: ((created: SessionBootstrapCreated) => void) | undefined;
  /**
   * Told once, when the call stops being in flight — created OR refused.
   *
   * A DIFFERENT FACT FROM {@link SessionBootstrapProps.onCreated}, which is why it is
   * a second callback rather than a second argument on the first. `onCreated` answers
   * "which session is this"; a refused create has no answer to that and must still be
   * heard, because the caller that single-flights the act is holding a slot until
   * something says the act is over. Heard only on the created arm, that slot would
   * never come back after a refusal and the control that took it would be dead for the
   * life of the surface — with the reason nowhere on screen.
   *
   * Told AFTER the state is set, on both arms, and at most once per mount: the
   * `cancelled` guard below is what makes it once, so strict mode's discarded first
   * effect settles silently exactly as it does for `onCreated`.
   */
  readonly onSettled?: (() => void) | undefined;
}

export function SessionBootstrap(props: SessionBootstrapProps): React.JSX.Element {
  const [state, setState] = useState<BootstrapState>({ kind: "pending" });
  // The LATEST callback, held off the create effect's dependency list.
  //
  // The effect below runs exactly once per mount, on an empty list, because running
  // it again would create a second session. A caller that composes `onCreated` inline
  // — which is what a parent rendering this inside its own tree does — hands a new
  // function identity on every pass, so naming the prop in that list would make every
  // parent render start a session, and capturing the first render's closure would
  // answer a settlement with a callback the parent has since replaced. The ref is
  // refreshed on every commit and read at settlement time, which is neither.
  const notifyCreated = useRef(props.onCreated);
  const notifySettled = useRef(props.onSettled);
  useEffect(() => {
    notifyCreated.current = props.onCreated;
    notifySettled.current = props.onSettled;
  });

  useEffect(() => {
    // Strict-mode-safe mount: React 18+ invokes effects twice in dev/strict
    // mode to surface accidental state captures. The `cancelled` flag in the
    // cleanup closure makes the first invocation's promise resolution a no-op
    // so we never call `setState` on an unmounted (or about-to-be-remounted)
    // tree. Without this, the resolved branch could overwrite a pending
    // re-mount's state on the second effect run.
    let cancelled = false;

    // `DaemonMethod` brand cast: the contract declares
    // `daemon.call<M extends DaemonMethod>(method: M, ...)` where the brand is
    // intentionally `never`-shaped, so no string literal is structurally
    // assignable to it until the brand narrows to a string-literal union of
    // real method names. Cast at the call site so the method-name string
    // ("session.create") can be passed without polluting the public bridge
    // type. This single cast site lifts when the narrowed `DaemonMethod` union
    // lands — see the daemon protocol stubs in
    // packages/contracts/src/desktop-bridge.ts.
    const daemonCall = window.sidekicks.daemon.call as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;

    // Sync-throw normalization for the stub-contract gap: the
    // contract `daemon.call` returns `Promise<DaemonResult<M>>`, but the
    // placeholder stub (`createStubBridge` in
    // `packages/contracts/src/desktop-bridge.ts`) violates that by throwing
    // synchronously — `() => stubThrow("daemon.call")`. A bare
    // `daemonCall(...).then(...).catch(...)` would evaluate `daemonCall(...)`
    // first; the sync throw would propagate OUT before `.then` is reached,
    // escape this `useEffect` callback (React 18+ does NOT catch errors
    // thrown from effect callbacks), and leave the component pinned in
    // `kind: "pending"` indefinitely. Wrapping the call in an async IIFE
    // lets `await` normalise sync throws AND async rejections to the same
    // `catch` branch. The stub may be fixed at a later point; until then the
    // renderer defends against the gap.
    void (async () => {
      try {
        const bridgeResponse = await daemonCall("session.create", {});
        if (cancelled) return;
        const created = bridgeResponse as SessionCreateResponse;
        setState({ kind: "resolved", value: created });
        // Once, and after the state is set: the caller opens a store and navigates
        // on this, so it runs on a settlement this component has already accepted.
        // The `cancelled` guard above is what makes it once — strict mode's discarded
        // first effect resolves with the flag set and tells nobody.
        notifyCreated.current?.({ sessionId: created.sessionId });
        notifySettled.current?.();
      } catch (bridgeError: unknown) {
        if (cancelled) return;
        // Placeholder-bridge production branch: every stub bridge method throws
        // `NotImplementedError` (see
        // `packages/contracts/src/desktop-bridge.ts` `createStubBridge`). We
        // do not narrow on instanceof — any `Error` shape is rendered the
        // same way; the contract is "render the error envelope," not
        // "render a specific error class". Non-Error rejections (string,
        // plain object) are wrapped into an Error so the render branch is
        // always a real Error instance.
        const normalised =
          bridgeError instanceof Error ? bridgeError : new Error(String(bridgeError));
        setState({ kind: "rejected", error: normalised });
        // The refused arm's half of the settlement. `onCreated` is deliberately not
        // told here — there is no session to name — but the act is over, and the
        // caller holding a single-flight slot has to hear that on this arm too.
        notifySettled.current?.();
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
