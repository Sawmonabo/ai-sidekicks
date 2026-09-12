// SessionBootstrap renderer unit suite.
//
// The call site itself is asserted via
// `expect(daemonCall).toHaveBeenCalledWith(...)` inside the resolve/reject
// tests — proving the component fired `daemon.call("session.create", {})` on
// mount.
//
// Four-case coverage, the last of them the sync-throw defense:
//   1. pending — promise never settles; placeholder visible.
//   2. resolved — promise resolves to a deterministic `SessionCreateResponse`;
//      session id visible.
//   3. rejected (async) — promise rejects with `NotImplementedError`;
//      error envelope visible with name + message.
//   4. rejected (sync throw) — bridge call throws synchronously (matches the
//      production `createStubBridge` shape); error envelope visible.
//
// Vitest 4 `globals: true` (apps/desktop/vitest.config.ts) makes
// `describe` / `it` / `expect` / `vi` / `afterEach` available without
// per-file import. The renderer test tsconfig
// (`src/renderer/tsconfig.test.json`) adds `vitest/globals` to `types` so
// TypeScript resolves them too — that config is kept separate from the
// production renderer tsconfig so vitest globals never leak into renderer
// production code's typegraph.

import { render, screen } from "@testing-library/react";

import { NotImplementedError } from "@ai-sidekicks/contracts";
import type { SidekicksBridge } from "@ai-sidekicks/contracts";

import { SessionBootstrap, type SessionBootstrapProps } from "../SessionBootstrap.js";

// Type-augmentation echo: the renderer-wide `sidekicks-bridge.d.ts` declares
// `window.sidekicks` in a `declare global` block. This test file is
// typechecked by `src/renderer/tsconfig.test.json`, which pulls that ambient
// `.d.ts` into its program via its `"src/**/*.d.ts"` glob — NOT via the
// production `tsconfig.json`'s `include: ["**/*"]`, because TS `extends`
// replaces (does not merge) `include`, so the test config does not inherit the
// production include set. With the glob in place the test sees
// `window.sidekicks` as `SidekicksBridge`-typed.

function installMockBridge(call: ReturnType<typeof vi.fn>): void {
  // Build the minimum bridge surface SessionBootstrap touches. The component
  // only reads `window.sidekicks.daemon.call`; mocking the other five
  // capability groups is unnecessary scaffolding. We cast through `unknown`
  // because the partial shape isn't structurally assignable to the full
  // `SidekicksBridge` (which requires `controlPlane`, `native`, `webAuthn`,
  // `update`, `app`).
  const bridge: { daemon: { call: typeof call } } = { daemon: { call } };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
}

describe("SessionBootstrap", () => {
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
    // Deterministic resolve payload — `sessionId` is the only field the component
    // renders. The remaining fields match the `SessionCreateResponse` contract shape
    // declared in `packages/contracts/src/session.ts`, so the `as
    // SessionCreateResponse` cast in `SessionBootstrap.tsx` is type-honest, not just
    // type-suppressed: `state` is the bare `SessionState` string-union, NOT a nested `{
    // status, createdAt, updatedAt }` object — that latter shape belongs to
    // `SessionSnapshot`, not the create-response surface.
    const knownSessionId = "11111111-2222-3333-4444-555555555555";
    const daemonCall = vi.fn().mockResolvedValue({
      sessionId: knownSessionId,
      state: "active",
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
    // The placeholder-bridge production branch: every stub bridge method
    // throws `NotImplementedError`. Mocking exactly this error class
    // proves the renderer surfaces the rejection without crashing.
    const stubError = new NotImplementedError("session.create");
    const daemonCall = vi.fn().mockRejectedValue(stubError);
    installMockBridge(daemonCall);

    render(<SessionBootstrap />);

    const errorBanner = await screen.findByRole("alert");
    expect(errorBanner).toBeDefined();
    // The component renders `<name>: <message>`. Both substrings must
    // appear in the rendered text.
    expect(errorBanner.textContent).toContain("NotImplementedError");
    expect(errorBanner.textContent).toContain("SidekicksBridge.session.create is not implemented");
  });

  it("renders the error envelope when the bridge throws synchronously", async () => {
    // Production-shape parity: `createStubBridge` (in
    // `packages/contracts/src/desktop-bridge.ts`) wires every method to
    // `() => stubThrow(...)` — a SYNCHRONOUS throw, not an async rejection.
    // A regression in the renderer effect (or a contracts-side change to the
    // stub) that bypasses the sync-throw normalization in `SessionBootstrap`
    // would leave the component pinned in `kind: "pending"`. This case uses
    // `vi.fn(() => { throw error })` to model that exact shape so the
    // sync-throw branch is covered alongside the async-rejection branch above.
    const stubError = new NotImplementedError("session.create");
    const daemonCall = vi.fn(() => {
      throw stubError;
    });
    installMockBridge(daemonCall);

    render(<SessionBootstrap />);

    const errorBanner = await screen.findByRole("alert");
    expect(errorBanner).toBeDefined();
    expect(errorBanner.textContent).toContain("NotImplementedError");
    expect(errorBanner.textContent).toContain("session.create");
  });

  // The additive `onCreated` seam. This component is the only `session.create` caller
  // in the renderer, so until it handed its settlement out the session a start press
  // produced had a name nothing else could learn — and the console surface that
  // absorbs this component could open no store and navigate nowhere.
  describe("onCreated", () => {
    /** Render with a props object the case owns, so the absent arm is a real render. */
    function renderProbe(props: SessionBootstrapProps): void {
      render(<SessionBootstrap {...props} />);
    }

    it("reports the session once, when session.create settles with one", async () => {
      const knownSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const daemonCall = vi.fn().mockResolvedValue({
        sessionId: knownSessionId,
        state: "active",
        channels: [],
      });
      installMockBridge(daemonCall);
      const created: string[] = [];

      renderProbe({
        onCreated: (settlement) => {
          created.push(settlement.sessionId);
        },
      });

      // The rendered id is the settlement this component accepted, so awaiting it is
      // what makes the callback assertion below a claim about the same moment.
      await screen.findByText(`session id: ${knownSessionId}`);
      expect(created).toStrictEqual([knownSessionId]);
    });

    it("reports nothing when the create rejects", async () => {
      // A create that refused produced no session, and a callback carrying an empty
      // id would be a name for something that does not exist. The console surface
      // above reads this arm as "navigate nowhere".
      const daemonCall = vi.fn().mockRejectedValue(new NotImplementedError("session.create"));
      installMockBridge(daemonCall);
      const created: string[] = [];

      renderProbe({
        onCreated: (settlement) => {
          created.push(settlement.sessionId);
        },
      });

      await screen.findByRole("alert");
      expect(created).toStrictEqual([]);
    });

    it("renders exactly as it always did when no caller supplies one", async () => {
      // The negative control for the seam being ADDITIVE. The four cases above this
      // block already render without the prop; this one renders WITH the props object
      // present and the member absent, which is the shape the absorbed mount produces
      // for a caller that wants nothing from a settled create.
      const knownSessionId = "ffffffff-1111-2222-3333-444444444444";
      const daemonCall = vi.fn().mockResolvedValue({
        sessionId: knownSessionId,
        state: "active",
        channels: [],
      });
      installMockBridge(daemonCall);

      renderProbe({ onCreated: undefined });

      expect(await screen.findByText(`session id: ${knownSessionId}`)).toBeDefined();
      expect(daemonCall).toHaveBeenCalledTimes(1);
      expect(daemonCall).toHaveBeenCalledWith("session.create", {});
    });
  });
});
