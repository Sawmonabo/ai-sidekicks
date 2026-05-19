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
// Four-case coverage (per T5.2 acceptance criteria f + sync-throw defense):
//   1. pending — promise never settles; placeholder visible.
//   2. resolved — promise resolves to a deterministic `SessionCreateResponse`;
//      session id visible.
//   3. rejected (async) — promise rejects with `NotImplementedAtTier1Error`;
//      error envelope visible with name + message.
//   4. rejected (sync throw) — bridge call throws synchronously (matches the
//      production Tier 1 `createTier1Bridge` shape); error envelope visible.
//
// Vitest 4 `globals: true` (apps/desktop/vitest.config.ts) makes
// `describe` / `it` / `expect` / `vi` / `afterEach` available without
// per-file import. The renderer tsconfig adds `vitest/globals` to `types`
// so TypeScript resolves them too.

import { render, screen } from "@testing-library/react";

import { NotImplementedAtTier1Error } from "@ai-sidekicks/contracts";
import type { SidekicksBridge } from "@ai-sidekicks/contracts";

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
    // Deterministic resolve payload. The component renders the session id
    // ONLY (per T5.2 acceptance criterion c — minimum scope at Tier 1); the
    // `state`, `memberships`, and `channels` fields are present in the shape
    // for type validity but not asserted on the rendered tree.
    const knownSessionId = "11111111-2222-3333-4444-555555555555";
    const daemonCall = vi.fn().mockResolvedValue({
      sessionId: knownSessionId,
      state: {
        status: "active",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
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
});
