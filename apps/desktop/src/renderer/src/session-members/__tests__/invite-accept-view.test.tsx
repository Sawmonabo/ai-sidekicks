// Plan-002 Phase 6 T6.3 — InviteAcceptView renderer unit suite (Tier 2).
//
// Single-client component smoke for the invite-acceptance surface, per
// `Plan-002 §Phase 6 — Renderer (Tier 2)` Goal + `Plan-002 §Verification`: Phase 6
// component tests + single-client smoke prove the invite-acceptance UI renders
// via the preload bridge (the two-client end-to-end smoke is deferred to
// Tier 8 per CP-002-5). The phrasing here paraphrases both anchors; it is not a
// verbatim quotation of either.
//
// Spec coverage:
//   • `Spec-002 §Acceptance Criteria` AC1 (an invited participant joins an active session)
//     + §Interfaces And Contracts (`InviteAccept` creates active
//     membership): the resolved-branch test asserts the view renders the
//     joined-membership facts (sessionId, role, membership state, membershipId)
//     that the `invite.accept` wire call returns.
//   • `Spec-002 §Token Security Properties`: the view carries ONLY
//     the opaque `token` prop into the request; this suite passes a mock token
//     and asserts it round-trips in the `daemon.call("invite.accept", {token})`
//     params — the renderer never decodes/verifies the token (Spec-023 §Trust
//     Stance: renderer is the untrusted surface).
//   • Spec-023 §Trust Stance (bridge-projection / CP-002-5): the
//     `describe("bridge-projection (CP-002-5)")` block at the bottom asserts the
//     view source NEVER imports the runtime-daemon or control-plane packages
//     directly — all cross-process traffic goes through `window.sidekicks`.
//
// Mirrors the shipped SessionBootstrap.test.tsx idioms verbatim: the
// `installMockBridge` install/teardown shape, the `afterEach` reset
// (`delete window.sidekicks` + `vi.clearAllMocks()`), and the RTL
// `render`/`screen.findBy*` assertion style. The mock bridge is DUPLICATED here
// (not imported from SessionBootstrap.test.tsx) per the T6.3 standing directive
// — refactoring the shipped sibling test is out of scope, and this view's bridge
// surface is narrower (`{ daemon: { call } }`) anyway.
//
// Vitest 4 `globals: true` (apps/desktop/vitest.config.ts → renderer project)
// makes `describe` / `it` / `expect` / `vi` / `afterEach` available without a
// per-file import; the renderer test tsconfig (`src/renderer/tsconfig.test.json`)
// adds `vitest/globals` to `types` so TypeScript resolves them too.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NotImplementedAtTier1Error } from "@ai-sidekicks/contracts";
import type {
  InviteId,
  MembershipId,
  ParticipantId,
  SessionId,
  SidekicksBridge,
} from "@ai-sidekicks/contracts";

import { InviteAcceptView } from "../invite-accept-view.js";

// --------------------------------------------------------------------------
// CP-002-5 source-text read — Vite `import.meta.glob` raw form.
// --------------------------------------------------------------------------
//
// The bridge-projection assertion (bottom of this file) needs the view's own
// source TEXT. The lint-clean / typecheck-clean way to obtain it in renderer
// source is Vite's `import.meta.glob(..., { query: "?raw" })`, which inlines
// each matched file's contents as a string at transform time — NO module
// import. `node:fs`/`node:path` are doubly banned here: by the renderer
// `no-restricted-imports` ESLint rule (which scopes to
// `src/renderer/src/**/*.{ts,tsx}`, INCLUDING this `__tests__` file) AND by the
// renderer test typegraph (`src/renderer/tsconfig.test.json` has `types: []`
// plus `["vitest/globals"]` — no `@types/node`, so `node:fs` fails TS2307).
//
// `import.meta.glob` is a Vite build-time macro with no ambient TypeScript type
// in this project (the renderer tsconfig sets `types: []` and references no
// `vite/client`). Rather than widen a shared tsconfig (out of `target_paths`)
// or pull Vite's whole client typegraph, we declare the ONE signature we use as
// a local module-scoped `ImportMeta` augmentation. It is scoped to this test
// file's program and verified not to leak into the production renderer
// typecheck (`tsc -b`).
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

// Keyed by the glob-relative path (e.g. `"../invite-accept-view.tsx"`). Eager so
// the values are plain strings available synchronously at module evaluation.
const rendererViewSources = import.meta.glob("../*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Branded-id test fixtures — `"<uuid>" as SessionId` mirrors the shipped SDK
// precedent (packages/client-sdk/test/membershipClient.integration.test.ts:64-70).
// The strings are deterministic so the resolved-branch assertions are exact.
const KNOWN_SESSION_ID = "01970000-0000-7000-8000-0000000000a1" as SessionId;
const KNOWN_MEMBERSHIP_ID = "01970000-0000-7000-8000-0000000000c1" as MembershipId;
const KNOWN_PARTICIPANT_ID = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;
const KNOWN_INVITE_ID = "01970000-0000-7000-8000-0000000000d1" as InviteId;

// The opaque PASETO v4.local invite token the view carries (Spec-002
// §Token Security Properties). A placeholder string — the renderer never
// decodes it; the control-plane service does.
const MOCK_INVITE_TOKEN = "v4.local.mock-opaque-invite-token";

// A SECOND opaque token, for the prop-reset test: a parent reusing one mounted
// `InviteAcceptView` instance for a different invite (a future deep-link/router
// re-rendering the same element with a new `token`) must reset the view to
// `idle`, not leave it on the prior token's resolved/rejected branch.
const SECOND_INVITE_TOKEN = "v4.local.mock-opaque-invite-token-2";

function installMockBridge(call: ReturnType<typeof vi.fn>): void {
  // Minimum bridge surface InviteAcceptView touches: it reads ONLY
  // `window.sidekicks.daemon.call`. Mocking the other five capability groups
  // would be unnecessary scaffolding. We cast through `unknown` because the
  // partial shape is not structurally assignable to the full `SidekicksBridge`
  // (which also requires `controlPlane`, `native`, `webAuthn`, `update`, `app`).
  const bridge: { daemon: { call: typeof call } } = { daemon: { call } };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
}

describe("InviteAcceptView (Plan-002 Phase 6 T6.3)", () => {
  afterEach(() => {
    // RTL auto-cleanup runs (vitest globals lets @testing-library/react@^16
    // register its `afterEach`). We still reset `window.sidekicks` manually so
    // cross-test bridge state never leaks into a sibling test's render tree.
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  it("renders the idle Accept prompt before any click", () => {
    // Button-triggered view: it STARTS in `idle` (unlike SessionBootstrap, which
    // mounts straight into `pending`). No bridge call fires on mount — the accept
    // is a deliberate user action, not a mount side-effect.
    const daemonCall = vi.fn(() => new Promise(() => {}));
    installMockBridge(daemonCall);

    render(<InviteAcceptView token={MOCK_INVITE_TOKEN} />);

    // `getByLabelText` (synchronous) — the idle section is in the initial render,
    // so there is no async settle to await.
    const idleSection = screen.getByLabelText("invite-accept-idle");
    expect(idleSection).toBeDefined();
    expect(screen.getByRole("button", { name: "Accept invite" })).toBeDefined();
    // Acceptance must NOT auto-fire on mount (single-use invite consumption is a
    // click, never a route-load side-effect — see invite-accept-view.tsx header).
    expect(daemonCall).not.toHaveBeenCalled();
  });

  it("shows the pending in-flight state between click and resolution", async () => {
    // Un-settling promise — the view stays in `kind: "pending"` for the lifetime
    // of the test, so the `aria-busy` in-flight branch is observable.
    const daemonCall = vi.fn(() => new Promise(() => {}));
    installMockBridge(daemonCall);

    render(<InviteAcceptView token={MOCK_INVITE_TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));

    const pendingSection = await screen.findByLabelText("invite-accept-pending");
    expect(pendingSection).toBeDefined();
    expect(pendingSection.getAttribute("aria-busy")).toBe("true");
    // The token round-trips opaquely into the wire params — the renderer carries
    // it verbatim, never decoding it (Spec-002 §Token Security Properties).
    expect(daemonCall).toHaveBeenCalledTimes(1);
    expect(daemonCall).toHaveBeenCalledWith("invite.accept", { token: MOCK_INVITE_TOKEN });
  });

  it("renders the joined-membership facts when the accept resolves", async () => {
    // Deterministic `InviteAcceptResponse` (six fields per invites.ts:262-269).
    // The view renders four of them: sessionId, role, membership state,
    // membershipId. This is the Spec-002 §AC1 surface — the invited participant
    // has joined an active session, and the active membership is shown.
    const daemonCall = vi.fn().mockResolvedValue({
      inviteId: KNOWN_INVITE_ID,
      membershipId: KNOWN_MEMBERSHIP_ID,
      sessionId: KNOWN_SESSION_ID,
      participantId: KNOWN_PARTICIPANT_ID,
      role: "collaborator",
      state: "active",
    });
    installMockBridge(daemonCall);

    render(<InviteAcceptView token={MOCK_INVITE_TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));

    // `findByLabelText` waits for the resolved render (promise settle + setState
    // flush). The resolved section must surface the four membership facts.
    const resolvedSection = await screen.findByLabelText("invite-accept-resolved");
    expect(resolvedSection).toBeDefined();
    expect(resolvedSection.textContent).toContain(`session id: ${KNOWN_SESSION_ID}`);
    expect(resolvedSection.textContent).toContain("role: collaborator");
    expect(resolvedSection.textContent).toContain("membership state: active");
    expect(resolvedSection.textContent).toContain(`membership id: ${KNOWN_MEMBERSHIP_ID}`);
    expect(daemonCall).toHaveBeenCalledWith("invite.accept", { token: MOCK_INVITE_TOKEN });
  });

  it("renders the error envelope when the accept rejects asynchronously", async () => {
    // Async-rejection branch: the Tier-1 production path rejects every bridge
    // method with `NotImplementedAtTier1Error`. The view must surface it (the
    // `role="alert"` envelope) and NOT stay pinned in `pending`.
    const tier1Error = new NotImplementedAtTier1Error("invite.accept");
    const daemonCall = vi.fn().mockRejectedValue(tier1Error);
    installMockBridge(daemonCall);

    render(<InviteAcceptView token={MOCK_INVITE_TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));

    const errorSection = await screen.findByLabelText("invite-accept-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorSection.textContent).toContain(
      "SidekicksBridge.invite.accept is not implemented at Tier 1",
    );
    // Not stranded in pending — the pending section must be gone once the
    // rejection has driven the error state.
    expect(screen.queryByLabelText("invite-accept-pending")).toBeNull();
  });

  it("renders the error envelope when the bridge call throws synchronously", async () => {
    // LOAD-BEARING sync-throw case. At Tier 1, `createTier1Bridge`
    // (packages/contracts/src/desktop-bridge.ts) wires every method to
    // `() => tier1Throw(...)` — a SYNCHRONOUS throw, not an async rejection. The
    // view's accept handler wraps the call in a void async IIFE so `await`
    // funnels BOTH a sync throw and an async rejection into the same `catch`. A
    // regression that bypassed that normalization (e.g. a bare
    // `acceptInvite(...).then(...)`) would let the sync throw escape the handler
    // and strand the view in `pending` with no error rendered — this case pins
    // against exactly that.
    const tier1Error = new NotImplementedAtTier1Error("invite.accept");
    const daemonCall = vi.fn(() => {
      throw tier1Error;
    });
    installMockBridge(daemonCall);

    render(<InviteAcceptView token={MOCK_INVITE_TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));

    const errorSection = await screen.findByLabelText("invite-accept-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorSection.textContent).toContain("invite.accept");
    // Proves the sync throw did not strand the view in pending.
    expect(screen.queryByLabelText("invite-accept-pending")).toBeNull();
  });

  it("resets to the idle Accept prompt when the token prop changes on a reused instance", async () => {
    // Token-identity prop-reset guard (invite-accept-view.tsx — the render-phase
    // "Adjusting some state when a prop changes" pattern). A parent that REUSES
    // one mounted instance for a NEW invite (a future deep-link/router rendering
    // the same `<InviteAcceptView>` element with a different `token` after a
    // prior accept settled) must see the view return to `idle` for the new
    // invite — NOT remain pinned on the first token's resolved branch with stale
    // membership and no Accept button. Without the guard, `useState({ idle })`
    // would not re-run and the first token's `resolved` state would leak.
    const firstResponse = {
      inviteId: KNOWN_INVITE_ID,
      membershipId: KNOWN_MEMBERSHIP_ID,
      sessionId: KNOWN_SESSION_ID,
      participantId: KNOWN_PARTICIPANT_ID,
      role: "collaborator",
      state: "active",
    };
    const daemonCall = vi.fn().mockResolvedValue(firstResponse);
    installMockBridge(daemonCall);

    // Render with token A and drive it all the way to the resolved branch.
    const { rerender } = render(<InviteAcceptView token={MOCK_INVITE_TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    await screen.findByLabelText("invite-accept-resolved");
    expect(daemonCall).toHaveBeenCalledWith("invite.accept", { token: MOCK_INVITE_TOKEN });

    // Re-render the SAME instance with a DIFFERENT token (the deep-link reuse).
    rerender(<InviteAcceptView token={SECOND_INVITE_TOKEN} />);

    // The view returns to the idle Accept-prompt branch for the new invite: the
    // idle section + Accept button reappear and the stale resolved section is
    // gone. `waitFor` because the render-phase setState schedules a re-render.
    await waitFor(() => {
      expect(screen.getByLabelText("invite-accept-idle")).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Accept invite" })).toBeDefined();
    expect(screen.queryByLabelText("invite-accept-resolved")).toBeNull();

    // The reset alone fires no new wire call (acceptance stays user-initiated).
    expect(daemonCall).toHaveBeenCalledTimes(1);

    // And the new invite is acceptable: clicking Accept now carries token B.
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    await screen.findByLabelText("invite-accept-resolved");
    expect(daemonCall).toHaveBeenNthCalledWith(2, "invite.accept", { token: SECOND_INVITE_TOKEN });
  });

  describe("bridge-projection (CP-002-5)", () => {
    // Spec-023 §Trust Stance + Plan-002 CP-002-5 operational enforcement. The
    // renderer is the UNTRUSTED surface: it must reach the daemon / control-plane
    // ONLY through the `window.sidekicks` preload bridge, NEVER by importing the
    // node-side packages directly. This assertion reads the view's own source
    // text (via the Vite `import.meta.glob` raw form declared inline above — a
    // lint-clean / typecheck-clean alternative to `node:fs`, which is doubly
    // banned in renderer source: by `no-restricted-imports` AND by the renderer
    // test typegraph's `types: []`/no-`@types/node` posture) and asserts no
    // import statement targets the banned packages.
    //
    // THIS IS THE SOLE OPERATIONAL ENFORCEMENT of the daemon/control-plane import
    // ban for renderer source: `apps/desktop/eslint.config.mjs` bans `electron` /
    // `node:*` / `main`/`preload` escapes, but the `@ai-sidekicks/runtime-daemon`
    // / `@ai-sidekicks/control-plane` ban is deferred to the Plan-023 Tier 8
    // remainder (those would be inert today). Until that lands, this regex tripwire
    // is the only thing that turns CI red on a direct import — so it must catch
    // EVERY realistic direct-import shape, not just the bare-exact form.
    //
    // The four regexes below cover:
    //   1. `bannedBareImport` — `from "@ai-sidekicks/<pkg>"` AND any subpath
    //      (`from "@ai-sidekicks/<pkg>/internal"`) — the optional `(?:/…)?` group
    //      is what closes the subpath-evasion gap a trailing-quote-only anchor left.
    //   2. `bannedRelativeImport` — `from "…/packages/<pkg>/…"` (exact or subpath).
    //   3. `bannedSideEffectImport` — a `from`-less side-effect import
    //      (`import "@ai-sidekicks/<pkg>"` or its relative form). A REAL gap for
    //      control-plane, which (unlike runtime-daemon's native bindings) pulls
    //      nothing that would crash on a bare side-effect import.
    //   4. `bannedDynamicImport` — `import("@ai-sidekicks/<pkg>")` (or relative).
    // where `<pkg>` is `runtime-daemon | control-plane`.
    //
    // All four anchor on the IMPORT SURFACE (`from "…"` / `import "…"` /
    // `import("…")`), NOT bare words: these views legitimately mention
    // "control-plane" and "the local daemon" in PROSE comments
    // (invite-accept-view.tsx lines 13, 63), so a naive substring on the package
    // nickname would false-positive. The set is verified empirically in the
    // implementer's report: all violation shapes match; allowed imports (`react`,
    // `@testing-library/react`, type-only `@ai-sidekicks/contracts`) and prose do
    // not.
    const bannedBareImport =
      /from\s*["'`]@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?["'`]/;
    const bannedRelativeImport = /from\s*["'`][^"'`]*packages\/(?:runtime-daemon|control-plane)\//;
    const bannedSideEffectImport =
      /import\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;
    const bannedDynamicImport =
      /import\s*\(\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;
    // `[patternName, pattern]` tuples drive the `it.each` below. Naming each
    // pattern means a future regression reports WHICH shape matched (the case
    // title interpolates the name) instead of a bare `expected true to be false`
    // that forces a manual bisect across the four regexes.
    const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp]> = [
      ["bannedBareImport", bannedBareImport],
      ["bannedRelativeImport", bannedRelativeImport],
      ["bannedSideEffectImport", bannedSideEffectImport],
      ["bannedDynamicImport", bannedDynamicImport],
    ];

    // Glob-key-drift guard, hoisted to run ONCE before the `it.each`: if the
    // `import.meta.glob` key ever drifts, this throws loudly here rather than
    // letting every case vacuously pass against an `undefined` source. After the
    // narrowing throw, `inviteAcceptSource` is `string` for all cases below.
    const inviteAcceptSource = rendererViewSources["../invite-accept-view.tsx"];
    if (typeof inviteAcceptSource !== "string") {
      throw new Error("invite-accept-view.tsx source was not loaded by import.meta.glob");
    }

    it.each(bannedDirectImportPatterns)(
      "invite-accept-view.tsx source matches no %s direct daemon/control-plane import",
      (_bannedImportPatternName, bannedImportPattern) => {
        expect(bannedImportPattern.test(inviteAcceptSource)).toBe(false);
      },
    );
  });
});
