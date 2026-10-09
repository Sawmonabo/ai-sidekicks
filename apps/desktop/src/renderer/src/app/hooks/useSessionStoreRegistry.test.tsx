// What the registry this hook mints folds with and is fed by: the projectors its stores open with
// and the subscriber that binds the open session. A store with no projectors still holds a
// transcript and one nothing feeds still renders, so each case drives the hook's own registry.

import { act, render } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { type BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { type ScenarioEngine } from "#renderer/services/daemon/engine.fixture.js";
import { REFRESH_DEBOUNCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { type SessionDiagnostics } from "#renderer/services/session-events/diagnostics-handle.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  SessionProbe,
  fixtureBridgeWrapper,
  lastObservation,
  type Observation,
} from "./session-probe.test-support.js";

/** A session id the daemon admits, so the subscriber opens a stream for it. */
const BOUND_SESSION_ID = "019b7a44-4400-75e5-8510-ada11a5a66a5";

/** One run beat, payload-shaped as the run-lifecycle taxonomy spells it. */
function queuedRunEvent(sessionId: string, sequence: number, runId: string): ProjectedSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    cursor: `cursor-at-${String(sequence)}`,
    kind: "run.queued",
    occurredAt: new Date(sequence).toISOString(),
    payload: { sessionId, runId, runVersion: 1, newState: "queued" },
  };
}

/** The diagnostics a composition was handed, as the page would hold them. */
interface DiagnosticsHolder {
  installed: SessionDiagnostics | undefined;
}

/**
 * A fixture bridge with a composition beside it that keeps the session diagnostics it is
 * handed, so a case reads what the hook gave over rather than a page property.
 */
function compositionHarness(): {
  readonly scenarioEngine: ScenarioEngine;
  readonly diagnosticsHolder: DiagnosticsHolder;
  readonly wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element;
} {
  const { bridge, scenarioEngine } = createFixtureBridge({
    scenario: CONCURRENT_STREAMING_SCENARIO,
  });
  const diagnosticsHolder: DiagnosticsHolder = { installed: undefined };
  const composition: BridgeComposition = {
    createBridge: () => ({
      bridge,
      clock: scenarioEngine.clock,
      disposal: scenarioEngine,
      installHandles: () => () => undefined,
    }),
    installSessionDiagnostics: (diagnostics) => {
      diagnosticsHolder.installed = diagnostics;
      return () => {
        diagnosticsHolder.installed = undefined;
      };
    },
  };
  return {
    scenarioEngine,
    diagnosticsHolder,
    wrapper: function CompositionHost(props: { readonly children: ReactNode }) {
      return (
        <PlatformBridgeProvider
          bridge={bridge}
          clock={scenarioEngine.clock}
          composition={composition}
        >
          {props.children}
        </PlatformBridgeProvider>
      );
    },
  };
}

describe("useSessionStoreRegistry — the projectors the window's stores fold with", () => {
  it("registers the run-lifecycle projectors on the stores it opens", () => {
    // Asserted through the registry the hook built, not a constructor spy: a mock would pass
    // even if the composition root registered nothing.
    const observed: Observation[] = [];
    const sessionId = "session-run-projection";
    render(
      <SessionProbe
        sessionId={sessionId}
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper: fixtureBridgeWrapper() },
    );
    const { registry } = lastObservation(observed);
    const store = registry.peek(sessionId);
    expect(store).toBeDefined();
    // The base state the fixture's own read establishes, so a later read changes nothing.
    store?.initialize({ cursor: 0, entities: [] });

    act(() => {
      registry.enqueue(sessionId, [queuedRunEvent(sessionId, 1, "run-projection-1")]);
      registry.flush(sessionId);
    });

    const projectedRun = store?.snapshot().partitions.run["run-projection-1"];
    expect(projectedRun?.state).toBe("queued");
    expect(projectedRun?.body?.["runVersion"]).toBe(1);
  });
});

describe("useSessionStoreRegistry: the window's registry and the subscriber feeding it", () => {
  it("mints a subscriber beside the registry and binds the open session", async () => {
    const { scenarioEngine, diagnosticsHolder, wrapper } = compositionHarness();
    render(<SessionProbe sessionId={BOUND_SESSION_ID} onObserve={() => undefined} />, {
      wrapper,
    });

    // Read through what the composition was handed, since the hook does not return the
    // subscriber; this is also what the fixture composition puts on the page for the endurance
    // tier.
    const diagnostics = diagnosticsHolder.installed;
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.openSessionIds()).toEqual([BOUND_SESSION_ID]);

    // The stream binds once the session's read has landed, which the refresh debounce releases.
    await act(async () => {
      scenarioEngine.advance(REFRESH_DEBOUNCE_MS + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(diagnostics?.boundSessionIds()).toEqual([BOUND_SESSION_ID]);
  });
});
