// Who owns the Agents pane's reads, and for how long.
//
// Two lifetime claims are checked here, because both are claims a rendered pane
// cannot make on its own:
//
//   • **A model never belongs to a session it is not for.** State replaced from an
//     effect lags its inputs by a frame, so the mismatched frame has to be watched
//     as it happens rather than after it settles.
//   • **Acquiring a linkage read is not starting one.** The split exists so a
//     render body can never open a subscription, and "never started" is only
//     observable on the model itself.
//
// What REFRESHES each read is `../agent-reads.test.ts`, beside the factories
// that decide it.

import { renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { FixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { REFRESH_MAX_WAIT_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { AgentsPaneModels } from "./agents-pane-models.js";
import { useAgentsPaneModels } from "./hooks/useAgentsPaneModels.js";
import { initializedStore } from "@test/helpers/session-store-fixtures.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import {
  REJECTING_AGENTS_PANE_CALLS,
  unscriptedBridge,
} from "./components/run-links.test-support.js";

const PARENT_RUN_ID = "run-7";
const OTHER_PARENT_RUN_ID = "run-9";

/** The provider a hook under test is mounted in: that fixture's bridge, on its frozen clock. */
function windowOver(
  fixture: FixtureBridge,
): (props: { readonly children: React.ReactNode }) => React.JSX.Element {
  return bridgeWrapper(fixture.bridge, fixture.scenarioEngine.clock);
}

// --- A model never belongs to a session it is not for -------------------------

/** Every value the hook answered, in render order, including uncommitted frames. */
function recordedModelSessionIds(
  fixture: FixtureBridge,
  first: SessionStore,
  second: SessionStore,
): readonly (string | undefined)[] {
  const answered: (string | undefined)[] = [];
  const view = renderHook(
    (sessionStore: SessionStore) => {
      const models = useAgentsPaneModels(fixture.bridge, sessionStore, REJECTING_AGENTS_PANE_CALLS);
      answered.push(models?.sessionId);
      return models;
    },
    { initialProps: first, wrapper: windowOver(fixture) },
  );
  const beforeSwitch = answered.length;
  view.rerender(second);
  return answered.slice(beforeSwitch);
}

/**
 * The shape this finding replaced: the held set answered without the match check.
 *
 * The negative control, so the recorder above is shown to REPORT a mismatched frame
 * when there is one — without it the clean case would also pass over a hook that
 * answered `undefined` forever.
 */
function useUnguardedAgentsPaneModels(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): AgentsPaneModels | undefined {
  return useHeldAgentsPaneModels(bridge, sessionStore);
}

/**
 * The second shape this finding replaced: the guard compared the SESSION ID.
 *
 * A replacement bridge or a rebuilt store under one session passes it, so the first
 * committed render after either hands back a set bound to what was just retired.
 */
function useSessionIdGuardedAgentsPaneModels(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): AgentsPaneModels | undefined {
  const models = useHeldAgentsPaneModels(bridge, sessionStore);
  return models !== undefined && models.sessionId === sessionStore.sessionId ? models : undefined;
}

/** The lifecycle both stand-ins share — a set built and disposed by an effect. */
function useHeldAgentsPaneModels(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): AgentsPaneModels | undefined {
  const clock = useBridgeClock();
  const [models, setModels] = useState<AgentsPaneModels | undefined>(undefined);
  useEffect(() => {
    const built = new AgentsPaneModels(bridge, clock, sessionStore, REJECTING_AGENTS_PANE_CALLS);
    setModels(built);
    return () => {
      built.dispose();
      setModels(undefined);
    };
  }, [bridge, clock, sessionStore]);
  return models;
}

describe("the Agents pane's models — the session they belong to", () => {
  it("answers nothing on the frame where the held set is the previous session's", () => {
    const fixture = unscriptedBridge("agent-models-match");
    const afterSwitch = recordedModelSessionIds(
      fixture,
      initializedStore("session-a"),
      initializedStore("session-b"),
    );

    // The pane's binding column dispatches attach, config-update, and detach
    // through whatever this answers, so one frame carrying the left session's
    // models would mutate a session the console is no longer showing.
    expect(afterSwitch).not.toContain("session-a");
    expect(afterSwitch.at(-1)).toBe("session-b");
  });

  it("negative control: without the check that same frame carries the previous session", () => {
    const fixture = unscriptedBridge("agent-models-unguarded");
    const answered: (string | undefined)[] = [];
    const view = renderHook(
      (sessionStore: SessionStore) => {
        const models = useUnguardedAgentsPaneModels(fixture.bridge, sessionStore);
        answered.push(models?.sessionId);
        return models;
      },
      { initialProps: initializedStore("session-a"), wrapper: windowOver(fixture) },
    );
    const beforeSwitch = answered.length;
    view.rerender(initializedStore("session-b"));

    expect(answered.slice(beforeSwitch)).toContain("session-a");
  });

  it("answers nothing at all where the mount resolved no session", () => {
    const fixture = unscriptedBridge("agent-models-storeless");
    const view = renderHook(
      () => useAgentsPaneModels(fixture.bridge, undefined, REJECTING_AGENTS_PANE_CALLS),
      { wrapper: windowOver(fixture) },
    );
    expect(view.result.current).toBeUndefined();
  });
});

// --- Acquiring a linkage read is not starting one -----------------------------

describe("the Agents pane's models — the linkage lease", () => {
  it("hands out a read that has not subscribed and has read nothing", () => {
    const { bridge, scenarioEngine } = unscriptedBridge("agent-linkage-acquire");
    const models = new AgentsPaneModels(
      bridge,
      scenarioEngine.clock,
      initializedStore("session-lease"),
      REJECTING_AGENTS_PANE_CALLS,
    );
    const lease = models.acquireLinkage(PARENT_RUN_ID);

    expect(lease.read.isSubscribed).toBe(false);
    expect(lease.read.readCount).toBe(0);
    expect(models.heldLinkageParentRunId).toBe(PARENT_RUN_ID);

    // And the caller starting it DOES subscribe, so the case above is about who
    // starts the read rather than about a lease that hands back a dead object.
    lease.read.start();
    expect(lease.read.isSubscribed).toBe(true);

    models.dispose();
  });

  it("disposes the read when the last lease on it is given back", () => {
    const { bridge, scenarioEngine } = unscriptedBridge("agent-linkage-release");
    const models = new AgentsPaneModels(
      bridge,
      scenarioEngine.clock,
      initializedStore("session-lease"),
      REJECTING_AGENTS_PANE_CALLS,
    );
    const first = models.acquireLinkage(PARENT_RUN_ID);
    const second = models.acquireLinkage(PARENT_RUN_ID);
    first.read.start();

    // One read, joined — never two projections of one parent run's children.
    expect(second.read).toBe(first.read);
    expect(models.outstandingLinkageLeaseCount).toBe(2);

    first.release();
    expect(models.heldLinkageParentRunId).toBe(PARENT_RUN_ID);
    expect(second.read.isSubscribed).toBe(true);

    second.release();
    expect(models.outstandingLinkageLeaseCount).toBe(0);
    expect(models.heldLinkageParentRunId).toBeUndefined();
    expect(second.read.isSubscribed).toBe(false);
  });

  it("disposes the previous run's read when a different run is acquired", () => {
    const { bridge, scenarioEngine } = unscriptedBridge("agent-linkage-rekey");
    const models = new AgentsPaneModels(
      bridge,
      scenarioEngine.clock,
      initializedStore("session-lease"),
      REJECTING_AGENTS_PANE_CALLS,
    );
    const first = models.acquireLinkage(PARENT_RUN_ID);
    first.read.start();
    const second = models.acquireLinkage(OTHER_PARENT_RUN_ID);

    expect(first.read.isSubscribed).toBe(false);
    expect(second.read).not.toBe(first.read);
    expect(models.heldLinkageParentRunId).toBe(OTHER_PARENT_RUN_ID);

    // A lease on a set the holder has already replaced releases nothing.
    first.release();
    expect(models.heldLinkageParentRunId).toBe(OTHER_PARENT_RUN_ID);

    models.dispose();
    expect(second.read.isSubscribed).toBe(false);
    expect(models.heldLinkageParentRunId).toBeUndefined();
  });
});

// --- A model never belongs to a BRIDGE or a STORE it is not for ---------------

/** The two inputs a mount is handed, replaced one at a time by the cases below. */
interface ModelsProbeInputs {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
}

/** Every set the hook answered after its inputs were replaced, in render order. */
function answersAfterReplacing(
  host: FixtureBridge,
  before: ModelsProbeInputs,
  after: ModelsProbeInputs,
): readonly (AgentsPaneModels | undefined)[] {
  const answered: (AgentsPaneModels | undefined)[] = [];
  const view = renderHook(
    (inputs: ModelsProbeInputs) => {
      const models = useAgentsPaneModels(
        inputs.bridge,
        inputs.sessionStore,
        REJECTING_AGENTS_PANE_CALLS,
      );
      answered.push(models);
      return models;
    },
    { initialProps: before, wrapper: windowOver(host) },
  );
  const beforeReplacement = answered.length;
  view.rerender(after);
  return answered.slice(beforeReplacement);
}

describe("the Agents pane's models — the exact bridge and store they answer for", () => {
  it("answers nothing on the frame where the bridge was replaced under one session", () => {
    const sessionStore = initializedStore("session-reconnect");
    const retired = unscriptedBridge("agent-models-bridge-a");
    const replacement = unscriptedBridge("agent-models-bridge-b").bridge;
    const afterReplacement = answersAfterReplacing(
      retired,
      { bridge: retired.bridge, sessionStore },
      { bridge: replacement, sessionStore },
    );

    // The retired bridge's reads are bound to a transport this mount no longer
    // holds, and the binding column would dispatch every mutation through it.
    expect(afterReplacement[0]).toBeUndefined();
    expect(afterReplacement.at(-1)?.subject.bridge).toBe(replacement);
  });

  it("answers nothing on the frame where the store was rebuilt under one session", () => {
    const fixture = unscriptedBridge("agent-models-store-rebuild");
    const { bridge } = fixture;
    const rebuilt = initializedStore("session-rebuilt");
    const afterReplacement = answersAfterReplacing(
      fixture,
      { bridge, sessionStore: initializedStore("session-rebuilt") },
      { bridge, sessionStore: rebuilt },
    );

    // Same session id, a different projection: the held roster answers from the
    // stream the previous store owned, which nothing is appending to any more.
    expect(afterReplacement[0]).toBeUndefined();
    expect(afterReplacement.at(-1)?.subject.sessionStore).toBe(rebuilt);
  });

  it("negative control: an unchanged pair keeps answering with the set it holds", () => {
    // Without this, the two cases above would pass over a hook that answered
    // `undefined` on every frame it ever rendered.
    const fixture = unscriptedBridge("agent-models-unchanged");
    const inputs: ModelsProbeInputs = {
      bridge: fixture.bridge,
      sessionStore: initializedStore("session-unchanged"),
    };
    const afterRerender = answersAfterReplacing(fixture, inputs, inputs);
    expect(afterRerender.at(-1)?.subject).toStrictEqual(inputs);
  });

  it("negative control: the session-id guard hands the retired bridge's set back", () => {
    // The shape this finding replaced. It is the instrument's proof: the recorder
    // above reports a mismatched frame when the guard cannot see one.
    const sessionStore = initializedStore("session-id-only");
    const retiredFixture = unscriptedBridge("agent-models-id-only-a");
    const retired = retiredFixture.bridge;
    const replacement = unscriptedBridge("agent-models-id-only-b").bridge;
    const answered: (AgentsPaneModels | undefined)[] = [];
    const view = renderHook(
      (inputs: ModelsProbeInputs) => {
        const models = useSessionIdGuardedAgentsPaneModels(inputs.bridge, inputs.sessionStore);
        answered.push(models);
        return models;
      },
      { initialProps: { bridge: retired, sessionStore }, wrapper: windowOver(retiredFixture) },
    );
    const beforeReplacement = answered.length;
    view.rerender({ bridge: replacement, sessionStore });

    expect(
      answered.slice(beforeReplacement).some((models) => models?.subject.bridge === retired),
    ).toBe(true);
  });
});

// --- A model reads on the window's clock, never on one it minted --------------

/**
 * Let continuations run WITHOUT crossing a macrotask boundary.
 *
 * Deliberately not the shared drain in `bridge/fixture/call-plane/bridge.test-support.ts`, and
 * deliberately not under its name: that one is a `setTimeout(…, 0)` boundary, and
 * every case below asserts that nothing fell due while the window's clock stood still.
 * Yielding to the macrotask queue is exactly what would let a due timer fire, so it
 * would settle the reads these cases claim are unscheduled and each one would pass
 * with its subject removed. A counted number of passes is the price of that: four,
 * one more than the deepest `.then` chain a model opening a read arms, and a count
 * this file may tune because what it bounds is its own settling rather than the
 * implementation's.
 */
async function settleWithoutCrossingATimer(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
  }
}

describe("the Agents pane's models — whose clock their reads run on", () => {
  it("performs its opening reads when the window's clock advances", async () => {
    // Driven rather than asserted about a private field. Under the fixture the window
    // runs on the scenario engine's FROZEN clock, and every read a model opens is armed
    // through the refresh chokepoint — so a model that minted its own `RealClock` would
    // arm on wall time inside a window whose scenario beats advance on frozen time, and
    // nothing here would fall due.
    const { bridge, scenarioEngine } = unscriptedBridge("agent-models-clock");
    const sessionStore = initializedStore("session-clock");
    const models = new AgentsPaneModels(
      bridge,
      scenarioEngine.clock,
      sessionStore,
      REJECTING_AGENTS_PANE_CALLS,
    );
    await settleWithoutCrossingATimer();
    expect(models.roster.readCount).toBe(0);

    scenarioEngine.advance(REFRESH_MAX_WAIT_MS);
    await settleWithoutCrossingATimer();

    expect(models.roster.readCount).toBe(1);
    models.dispose();
  });

  it("negative control: with the window's clock held still nothing falls due", async () => {
    // Without this, the case above would pass over a model whose reads were performed
    // eagerly on construction — which is a read nobody scheduled and a clock nothing
    // consults, and would make the advance above incidental rather than the subject.
    const { bridge, scenarioEngine } = unscriptedBridge("agent-models-clock-held");
    const sessionStore = initializedStore("session-clock-held");
    const models = new AgentsPaneModels(
      bridge,
      scenarioEngine.clock,
      sessionStore,
      REJECTING_AGENTS_PANE_CALLS,
    );

    await settleWithoutCrossingATimer();
    await settleWithoutCrossingATimer();

    expect(models.roster.readCount).toBe(0);
    models.dispose();
  });
});
