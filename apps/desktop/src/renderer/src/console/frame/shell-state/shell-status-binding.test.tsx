// The binding that fills the window's shell state, and the four ways it ends.
//
// Two properties are worth a test each and both are about HONESTY rather than about
// plumbing: a build whose port refuses leaves the window saying nothing, and a
// channel that goes away takes its claim with it. The second is the one a naive
// implementation gets wrong — holding the last report after the stream closed leaves
// a window reading "connected" on the strength of a message that arrived before the
// process carrying it went away.
//
// The third is the one a naive implementation gets wrong in the other direction: a
// channel that BREAKS rather than ending rejects the drain's own promise, which is
// discarded — so the defect is invisible to the store and visible only to the runner's
// unhandled-rejection report and to the subscription nobody closed.
//
// The retry beside them is here for a third honesty claim, about a rule it is the
// EXCEPTION to: the shell's mutation block closes every daemon-bound write while the
// supervisor is reconnecting, incompatible, offline, or stopped, and the runtime's own
// lifecycle controls are how a person gets out of that state. So the case below drives
// this action in exactly the state that raises the block.

import { act, render, waitFor } from "@testing-library/react";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { unhandledRejectionsDuring } from "../../core/unhandled-rejection.test-support.js";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, type ConsoleBridge } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { DrivenGrowthStream } from "../../bridge/growth-port/driven-growth-stream.test-support.js";
import type { GrowthStream } from "../../bridge/growth-port/growth-outcome.js";
import {
  FrameStore,
  SessionStoreRegistry,
  shellMutationBlock,
  type ShellReport,
} from "../../store/index.js";
import { SHELL_SCENARIO } from "../../bridge/scenarios/shell.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { useDaemonStartAction, useShellStateBinding } from "./shell-status-binding.js";
import { ShellChrome } from "./ShellChrome.js";

const CONNECTED: ShellReport = {
  connection: { kind: "connected" },
  negotiation: undefined,
  lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
  transport: "os-local",
  keystore: "available",
};

function bridgeServing(stream: GrowthStream<ShellReport> | undefined): ConsoleBridge {
  const base = createFixtureBridge({ scenario: SHELL_SCENARIO });
  return {
    ...base,
    growth: {
      ...createRefusingGrowthPort(),
      shellStatusSubscribe: async () =>
        stream === undefined
          ? await base.growth.shellStatusSubscribe({})
          : { status: "served", value: stream },
    },
  };
}

/** A build that carries no shell wire at all: every growth operation refuses. */
function refusingBridge(): ConsoleBridge {
  return {
    ...createFixtureBridge({ scenario: SHELL_SCENARIO }),
    growth: createRefusingGrowthPort(),
  };
}

/** A registry holding no session: this file's subject is the report, not the fold. */
function emptyRegistry(): SessionStoreRegistry {
  return new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
}

/** A bridge whose only served growth operation is the spawn, recorded per call. */
function bridgeRecordingStarts(starts: string[]): ConsoleBridge {
  return {
    ...createFixtureBridge({ scenario: SHELL_SCENARIO }),
    growth: {
      ...createRefusingGrowthPort(),
      daemonStart: async () => {
        starts.push("daemonStart");
        return await Promise.resolve({ status: "served", value: undefined });
      },
    },
  };
}

/** The retry, mounted the way the frame's offline banner mounts it. */
function RetryHarness(props: { readonly store: FrameStore }): React.JSX.Element {
  const start = useDaemonStartAction(props.store);
  return (
    <button type="button" onClick={start}>
      Start the local runtime
    </button>
  );
}

function Harness(props: {
  readonly store: FrameStore;
  readonly registry: SessionStoreRegistry;
}): React.JSX.Element {
  useShellStateBinding(props.store, props.registry);
  return <ShellChrome frameStore={props.store} />;
}

describe("useShellStateBinding", () => {
  it("publishes what the stream reports", async () => {
    const stream = new DrivenGrowthStream<ShellReport>();
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const { container } = render(
      <SidekicksBridgeProvider bridge={bridgeServing(stream)}>
        <Harness store={store} registry={emptyRegistry()} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      stream.emit({ ...CONNECTED, transport: "loopback" });
      await crossMacrotaskBoundary();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Loopback transport is in use");
    });
    expect(store.getState().shellState.connection.kind).toBe("connected");
  });

  it("goes back to saying nothing when the channel ends", async () => {
    const stream = new DrivenGrowthStream<ShellReport>();
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    render(
      <SidekicksBridgeProvider bridge={bridgeServing(stream)}>
        <Harness store={store} registry={emptyRegistry()} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      stream.emit(CONNECTED);
      await crossMacrotaskBoundary();
    });
    await waitFor(() => {
      expect(store.getState().shellState.connection.kind).toBe("connected");
    });
    await act(async () => {
      stream.close();
      await crossMacrotaskBoundary();
    });
    await waitFor(() => {
      // The control the first case is worth nothing without: a binding that held the
      // last report would still read `connected` here.
      expect(store.getState().shellState.connection.kind).toBe("unreported");
    });
  });

  it("settles a channel that BROKE as a channel loss, and lets nothing escape", async () => {
    const stream = new DrivenGrowthStream<ShellReport>();
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const escaped = await unhandledRejectionsDuring(async () => {
      render(
        <SidekicksBridgeProvider bridge={bridgeServing(stream)}>
          <Harness store={store} registry={emptyRegistry()} />
        </SidekicksBridgeProvider>,
      );
      await act(async () => {
        stream.emit(CONNECTED);
        await crossMacrotaskBoundary();
      });
      await act(async () => {
        stream.fail(new Error("the shell's report subscription was torn down"));
        await crossMacrotaskBoundary();
      });
    });

    // The drain's promise is discarded, so a rejection that escapes it reaches the
    // window as an unhandled rejection rather than as anything a person could read.
    expect(escaped).toStrictEqual([]);
    // And the subscription is let go of rather than left open behind a reader that
    // has stopped reading it.
    expect(stream.closeCount).toBe(1);
    expect(store.getState().shellState.connection.kind).toBe("unreported");
  });

  it("negative control: a live channel is neither closed nor reset", async () => {
    // Without this the case above passes for a binding that closed the stream and
    // published `unreported` after every frame it was ever sent.
    const stream = new DrivenGrowthStream<ShellReport>();
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    render(
      <SidekicksBridgeProvider bridge={bridgeServing(stream)}>
        <Harness store={store} registry={emptyRegistry()} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      stream.emit(CONNECTED);
      await crossMacrotaskBoundary();
    });

    expect(stream.closeCount).toBe(0);
    expect(store.getState().shellState.connection.kind).toBe("connected");
  });

  it("clears the previous bridge's report when a replacement refuses", async () => {
    // THE DEFECT THIS PINS. A report is a claim ONE supervisor made, and a window
    // addressed at a different one was holding it: the retired drain's own settlement
    // is refused so it cannot clear it, and a refused subscribe publishes nothing at
    // all, so the window read "connected" about a bridge that had never answered.
    const stream = new DrivenGrowthStream<ShellReport>();
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const registry = emptyRegistry();
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridgeServing(stream)}>
        <Harness store={store} registry={registry} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      stream.emit(CONNECTED);
      await crossMacrotaskBoundary();
    });
    await waitFor(() => {
      expect(store.getState().shellState.connection.kind).toBe("connected");
    });

    await act(async () => {
      rerender(
        <SidekicksBridgeProvider bridge={refusingBridge()}>
          <Harness store={store} registry={registry} />
        </SidekicksBridgeProvider>,
      );
      await crossMacrotaskBoundary();
    });

    expect(store.getState().shellState.connection.kind).toBe("unreported");
  });

  it("publishes the replacement's own report — the control", async () => {
    // Without this the case above passes for a binding that reset the window and then
    // never wrote again, which is a different way of saying nothing true.
    const first = new DrivenGrowthStream<ShellReport>();
    const second = new DrivenGrowthStream<ShellReport>();
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const registry = emptyRegistry();
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridgeServing(first)}>
        <Harness store={store} registry={registry} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      first.emit(CONNECTED);
      await crossMacrotaskBoundary();
    });

    await act(async () => {
      rerender(
        <SidekicksBridgeProvider bridge={bridgeServing(second)}>
          <Harness store={store} registry={registry} />
        </SidekicksBridgeProvider>,
      );
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      second.emit({ ...CONNECTED, transport: "loopback" });
      await crossMacrotaskBoundary();
    });

    expect(store.getState().shellState.transport).toBe("loopback");
    expect(store.getState().shellState.connection.kind).toBe("connected");
  });

  it("discards a frame from the bridge it replaced", async () => {
    // The other half of the claim, driven at the one moment it is reachable: the swap
    // lands while the previous port's subscribe is still in flight, so that drain
    // acquires its stream after its own claim is gone. It lets the handle go rather
    // than draining it, and the frame it would have published reaches nothing.
    const retired = new DrivenGrowthStream<ShellReport>();
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const registry = emptyRegistry();
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridgeServing(retired)}>
        <Harness store={store} registry={registry} />
      </SidekicksBridgeProvider>,
    );
    act(() => {
      rerender(
        <SidekicksBridgeProvider bridge={bridgeServing(new DrivenGrowthStream<ShellReport>())}>
          <Harness store={store} registry={registry} />
        </SidekicksBridgeProvider>,
      );
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(retired.closeCount).toBe(1);
    await act(async () => {
      retired.emit({ ...CONNECTED, connection: { kind: "stopped" } });
      await crossMacrotaskBoundary();
    });

    expect(store.getState().shellState.connection.kind).toBe("unreported");
  });

  it("leaves the window unreported where the port refuses", async () => {
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const { container } = render(
      <SidekicksBridgeProvider bridge={refusingBridge()}>
        <Harness store={store} registry={emptyRegistry()} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(store.getState().shellState.connection.kind).toBe("unreported");
    expect(container.querySelector(".meridian-shell-state")).toBeNull();
  });
});

describe("useDaemonStartAction", () => {
  /** A window told the runtime is gone: every mutating act is closed. */
  function stoppedStore(): FrameStore {
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    store.publishShellReport({ ...CONNECTED, connection: { kind: "stopped" } });
    return store;
  }

  it("spawns the runtime in exactly the state that blocks every daemon call", async () => {
    // The rule this pins: the shell's mutation block closes daemon-bound writes, and
    // the runtime's OWN lifecycle controls are the way back from the state that
    // raised it. A block applied to this action would leave a stopped runtime with no
    // control that could start it.
    const store = stoppedStore();
    expect(shellMutationBlock(store.getState().shellState)).toBeDefined();

    const starts: string[] = [];
    const { getByRole } = render(
      <SidekicksBridgeProvider bridge={bridgeRecordingStarts(starts)}>
        <RetryHarness store={store} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      getByRole("button", { name: "Start the local runtime" }).click();
      await crossMacrotaskBoundary();
    });

    expect(starts).toStrictEqual(["daemonStart"]);
    // And it claimed nothing about the outcome: the supervisor's next report is what
    // says whether the runtime came back.
    expect(store.getState().shellState.connection.kind).toBe("stopped");
  });

  it("raises the port's refusal on the frame's banner stack — the control", async () => {
    // Without this the case above passes for an action that swallowed every answer:
    // a press that resolves in silence is indistinguishable from one that is broken.
    const store = stoppedStore();
    const { getByRole } = render(
      <SidekicksBridgeProvider bridge={refusingBridge()}>
        <RetryHarness store={store} />
      </SidekicksBridgeProvider>,
    );
    await act(async () => {
      getByRole("button", { name: "Start the local runtime" }).click();
      await crossMacrotaskBoundary();
    });

    expect(store.getState().banners).toHaveLength(1);
  });
});
