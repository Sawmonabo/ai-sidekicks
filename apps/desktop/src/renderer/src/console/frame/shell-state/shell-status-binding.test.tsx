// The binding that fills the window's shell state, and the four ways it ends.
//
// Two properties are worth a test each and both are about HONESTY rather than about
// plumbing: a build whose port refuses leaves the window saying nothing, and a
// channel that goes away takes its claim with it. The second is the one a naive
// implementation gets wrong — holding the last report after the stream closed leaves
// a window reading "connected" on the strength of a message that arrived before the
// process carrying it went away.

import { act, render, waitFor } from "@testing-library/react";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, type ConsoleBridge } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import type { GrowthStream } from "../../bridge/growth-port/growth-outcome.js";
import { FrameStore, SessionStoreRegistry, type ShellReport } from "../../store/index.js";
import { SHELL_SCENARIO } from "../../bridge/scenarios/shell.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { useShellStateBinding } from "./shell-status-binding.js";
import { ShellChrome } from "./ShellChrome.js";

const CONNECTED: ShellReport = {
  connection: { kind: "connected" },
  negotiation: undefined,
  lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
  transport: "os-local",
  keystore: "available",
};

/**
 * A stream a case drives by hand.
 *
 * The fixture's own stream wakes on beats, which is right for a scenario and wrong
 * for a case whose subject is what happens when a stream ENDS: nothing in a scenario
 * ends one.
 */
class DrivenStream implements GrowthStream<ShellReport> {
  #pending: ShellReport | undefined;
  #wake: (() => void) | undefined;
  #closed = false;

  public get events(): AsyncIterable<ShellReport> {
    return this.#iterate();
  }

  public close(): void {
    this.#closed = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  public emit(report: ShellReport): void {
    this.#pending = report;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *#iterate(): AsyncGenerator<ShellReport> {
    while (!this.#closed) {
      const pending = this.#pending;
      if (pending !== undefined) {
        this.#pending = undefined;
        yield pending;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

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

/** A registry holding no session: this file's subject is the report, not the fold. */
function emptyRegistry(): SessionStoreRegistry {
  return new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
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
    const stream = new DrivenStream();
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
    const stream = new DrivenStream();
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

  it("leaves the window unreported where the port refuses", async () => {
    const store = new FrameStore({ initialRoute: { kind: "sessions" } });
    const refusing: ConsoleBridge = {
      ...createFixtureBridge({ scenario: SHELL_SCENARIO }),
      growth: createRefusingGrowthPort(),
    };
    const { container } = render(
      <SidekicksBridgeProvider bridge={refusing}>
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
