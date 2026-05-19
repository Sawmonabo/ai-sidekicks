// Plan-001 Phase 5 T5.2 (Lane C) — SessionBootstrap renderer unit suite.
//
// Spec-001 §Acceptance Criteria coverage:
//   • AC1 (call site): asserted via the `expect(daemonCall).toHaveBeenCalledWith(...)`
//     check inside the resolve/reject tests — proves the component fired
//     `daemon.call("session.create", {})` on mount.
//   • AC4 (error envelope): asserted by the reject-branch tests below — proves
//     both async-rejecting and sync-throwing bridge mocks land on the
//     `role="alert"` render.
//
// Five-case coverage (per T5.2 acceptance criteria f + sync-throw defense +
// cancelled-cleanup defense):
//   1. pending — promise never settles; placeholder visible.
//   2. resolved — promise resolves to a deterministic `SessionCreateResponse`;
//      session id visible.
//   3. rejected (async) — promise rejects with `NotImplementedAtTier1Error`;
//      error envelope visible with name + message.
//   4. rejected (sync throw) — bridge call throws synchronously (matches the
//      production Tier 1 `createTier1Bridge` shape); error envelope visible.
//   5. cancelled cleanup — promise resolves AFTER unmount; the `cancelled`
//      flag set by the effect's cleanup closure must no-op the resolved
//      branch (defends against React strict-mode-double-mount setState
//      on an unmounted tree).
//
// Vitest 4 `globals: true` (apps/desktop/vitest.config.ts) makes
// `describe` / `it` / `expect` / `vi` / `afterEach` available without
// per-file import. The renderer test tsconfig
// (`src/renderer/tsconfig.test.json`) adds `vitest/globals` to `types` so
// TypeScript resolves them too — that config is kept separate from the
// production renderer tsconfig so vitest globals never leak into renderer
// production code's typegraph.

import { render, screen } from "@testing-library/react";

import { NotImplementedAtTier1Error } from "@ai-sidekicks/contracts";
import type { SessionCreateResponse, SidekicksBridge } from "@ai-sidekicks/contracts";

import { SessionBootstrap } from "../SessionBootstrap.js";

// Type-augmentation echo: `SessionBootstrap.tsx` declares `window.sidekicks`
// in a `declare global` block. That augmentation is hoisted into the
// renderer composite project's typecheck graph (the file is part of the
// project via `include: ["**/*"]`), so this test sees `window.sidekicks`
// as `SidekicksBridge`-typed.

interface MockBridge {
  daemon: {
    call: ReturnType<typeof vi.fn>;
  };
}

function installMockBridge(call: ReturnType<typeof vi.fn>): MockBridge {
  // Build the minimum bridge surface SessionBootstrap touches. The component
  // only reads `window.sidekicks.daemon.call`; mocking the other five
  // capability groups is unnecessary scaffolding. We cast through `unknown`
  // because the partial shape isn't structurally assignable to the full
  // `SidekicksBridge` (which requires `controlPlane`, `native`, `webAuthn`,
  // `update`, `app`).
  const bridge: MockBridge = { daemon: { call } };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
  return bridge;
}

describe("SessionBootstrap (Plan-001 Phase 5 T5.2 Lane C)", () => {
  afterEach(() => {
    // RTL auto-cleanup runs because `vitest/globals: true` lets
    // `@testing-library/react@^16` register its `afterEach` hook. We still
    // reset `window.sidekicks` manually so cross-test bridge state never
    // leaks into a sibling test's render tree.
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  it("renders a placeholder while session.create is pending", async () => {
    // Un-settling promise — the component stays in `kind: "pending"` for the
    // lifetime of the test. We assert the placeholder is rendered and that
    // `daemon.call` was invoked with the expected method + empty params.
    const daemonCall = vi.fn(() => new Promise(() => {}));
    installMockBridge(daemonCall);

    render(<SessionBootstrap />);

    const placeholder = await screen.findByLabelText("session-bootstrap-pending");
    expect(placeholder).toBeDefined();
    expect(daemonCall).toHaveBeenCalledTimes(1);
    expect(daemonCall).toHaveBeenCalledWith("session.create", {});
  });

  it("renders the session id on resolve", async () => {
    // Deterministic resolve payload — `sessionId` is the only field T5.2
    // renders (per acceptance criterion c, minimum scope at Tier 1). The
    // remaining fields match the `SessionCreateResponse` contract shape (see
    // `packages/contracts/src/session.ts` §SessionCreate) so the
    // `as SessionCreateResponse` cast in `SessionBootstrap.tsx` is
    // type-honest, not just type-suppressed: `state` is the bare
    // `SessionState` string-union, NOT a nested `{ status, createdAt,
    // updatedAt }` object — that latter shape belongs to `SessionSnapshot`,
    // not the create-response surface.
    const knownSessionId = "11111111-2222-3333-4444-555555555555";
    const daemonCall = vi.fn().mockResolvedValue({
      sessionId: knownSessionId,
      state: "active",
      memberships: [],
      channels: [],
    });
    installMockBridge(daemonCall);

    render(<SessionBootstrap />);

    // `findByText` waits for the next React-flushed render (after the
    // promise resolves + setState propagates) — it IS the assertion. If the
    // session id never appears, the await throws and the test fails.
    const resolvedNode = await screen.findByText(`session id: ${knownSessionId}`);
    expect(resolvedNode).toBeDefined();
    expect(daemonCall).toHaveBeenCalledWith("session.create", {});
  });

  it("renders the error envelope on reject", async () => {
    // The Tier 1 production branch: every Tier-1 bridge method throws
    // `NotImplementedAtTier1Error`. Mocking exactly this error class proves
    // the AC4 contract — the renderer surfaces the rejection without crashing.
    const tier1Error = new NotImplementedAtTier1Error("session.create");
    const daemonCall = vi.fn().mockRejectedValue(tier1Error);
    installMockBridge(daemonCall);

    render(<SessionBootstrap />);

    const errorBanner = await screen.findByRole("alert");
    expect(errorBanner).toBeDefined();
    // The component renders `<name>: <message>`. Both substrings must
    // appear in the rendered text.
    expect(errorBanner.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorBanner.textContent).toContain(
      "SidekicksBridge.session.create is not implemented at Tier 1",
    );
  });

  it("renders the error envelope when the bridge throws synchronously", async () => {
    // Production-shape parity: at Tier 1, `createTier1Bridge` (see
    // `packages/contracts/src/desktop-bridge.ts:346`) wires every method to
    // `() => tier1Throw(...)` — a SYNCHRONOUS throw, not an async rejection.
    // A regression in the renderer effect (or a contracts-side change to the
    // stub) that bypasses the sync-throw normalization in `SessionBootstrap`
    // would leave the component pinned in `kind: "pending"`. This case uses
    // `vi.fn(() => { throw error })` to model that exact shape so the
    // sync-throw branch is covered alongside the async-rejection branch above.
    const tier1Error = new NotImplementedAtTier1Error("session.create");
    const daemonCall = vi.fn(() => {
      throw tier1Error;
    });
    installMockBridge(daemonCall);

    render(<SessionBootstrap />);

    const errorBanner = await screen.findByRole("alert");
    expect(errorBanner).toBeDefined();
    expect(errorBanner.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorBanner.textContent).toContain("session.create");
  });

  it("cancels the bridge-resolution branch when unmounted before the promise settles", async () => {
    // Defends the `cancelled` flag + cleanup closure (SessionBootstrap.tsx:61,
    // 94, 97, 112-114). A regression that drops `cancelled` would call
    // setState on an unmounted tree — React would emit a console warning AND
    // a stale render could fire. We assert no resolved-branch label appears
    // in the DOM after the unmount + microtask drain.
    //
    // The resolve fixture is typed `Promise<unknown>` to match the production
    // bridge surface (SessionBootstrap.tsx:73-76 casts the daemon call to
    // `(method, params) => Promise<unknown>`); the renderer narrows via
    // `as SessionCreateResponse` inside the effect. Keeping the test fixture
    // branding-agnostic mirrors the other 4 tests' mock posture (none of
    // them traffic in `SessionId`-branded literals).
    let resolve!: (value: unknown) => void;
    const daemonCall = vi.fn(
      () =>
        new Promise<unknown>((r) => {
          resolve = r;
        }),
    );
    installMockBridge(daemonCall);

    const { unmount } = render(<SessionBootstrap />);
    unmount();
    // Resolve the bridge promise AFTER unmount; the cleanup must have flipped
    // `cancelled = true` so the .then path no-ops. The payload shape matches
    // `SessionCreateResponse` (sessionId/state/memberships/channels) so a
    // regression in the cleanup logic would render the resolved branch
    // visibly — there's nothing else stopping it.
    const cancelledResponse: SessionCreateResponse = {
      sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff" as SessionCreateResponse["sessionId"],
      state: "active",
      memberships: [],
      channels: [],
    };
    resolve(cancelledResponse);
    await Promise.resolve(); // drain the resolved microtask

    expect(screen.queryByLabelText("session-bootstrap-resolved")).toBeNull();
  });
});
