// The Agents pane models' lifetime claims, which a rendered pane cannot make: a model never
// belongs to a session, bridge or store it is not for (state replaced from an effect lags its
// inputs by a frame, so the mismatched frame is watched as it happens), and acquiring a linkage
// read does not start it. What refreshes each read is `../agent-reads.test.ts`.

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

/** The provider a hook under test is mounted in: that fixture's bridge, on its frozen clock. */
function windowOver(
  fixture: FixtureBridge,
): (props: { readonly children: React.ReactNode }) => React.JSX.Element {
  return bridgeWrapper(fixture.bridge, fixture.scenarioEngine.clock);
}

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
 * A stand-in without the match check. The negative control: it shows the recorder reports a
 * mismatched frame when there is one, rather than passing over a hook that answers `undefined`.
 */
function useUnguardedAgentsPaneModels(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): AgentsPaneModels | undefined {
  return useHeldAgentsPaneModels(bridge, sessionStore);
}

/**
 * A stand-in whose guard compares the session id. A replacement bridge or rebuilt store under
 * one session passes it, so the first committed render hands back a set bound to the retired one.
 */
function useSessionIdGuardedAgentsPaneModels(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): AgentsPaneModels | undefined {
  const models = useHeldAgentsPaneModels(bridge, sessionStore);
  return models !== undefined && models.sessionId === sessionStore.sessionId ? models : undefined;
}

/** The lifecycle both stand-ins share: a set built and disposed by an effect. */
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

    // The binding column dispatches mutations through this, so a frame carrying the left
    // session's models would mutate a session the console has left.
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

describe("the Agents pane's models — the linkage lease", () => {
  it("hands out a read that has not subscribed and has read nothing", () => {
    const { bridge, scenarioEngine } = unscriptedBridge("agent-linkage-acquire");
    const models = new AgentsPaneModels(
      bridge,
      scenarioEngine.clock,
      initializedStore("session-lease"),
      REJECTING_AGENTS_PANE_CALLS,
    );
    const lease = models.acquireLinkage();

    expect(lease.read.isSubscribed).toBe(false);
    expect(lease.read.readCount).toBe(0);
    expect(models.holdsLinkage).toBe(true);

    // The caller starting it does subscribe, so the case above is about who starts the read.
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
    const first = models.acquireLinkage();
    const second = models.acquireLinkage();
    first.read.start();

    // One read, joined.
    expect(second.read).toBe(first.read);
    expect(models.outstandingLinkageLeaseCount).toBe(2);

    first.release();
    first.release();
    expect(models.holdsLinkage).toBe(true);
    expect(second.read.isSubscribed).toBe(true);

    second.release();
    expect(models.outstandingLinkageLeaseCount).toBe(0);
    expect(models.holdsLinkage).toBe(false);
    expect(second.read.isSubscribed).toBe(false);
  });
});

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

    // The retired bridge's reads are bound to a transport this mount has dropped.
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

    // Same session id, a different projection: the held roster answers from the previous store's
    // stream, which nothing appends to any more.
    expect(afterReplacement[0]).toBeUndefined();
    expect(afterReplacement.at(-1)?.subject.sessionStore).toBe(rebuilt);
  });

  it("negative control: an unchanged pair keeps answering with the set it holds", () => {
    // Guards against a hook that answered `undefined` on every frame.
    const fixture = unscriptedBridge("agent-models-unchanged");
    const inputs: ModelsProbeInputs = {
      bridge: fixture.bridge,
      sessionStore: initializedStore("session-unchanged"),
    };
    const afterRerender = answersAfterReplacing(fixture, inputs, inputs);
    expect(afterRerender.at(-1)?.subject).toStrictEqual(inputs);
  });

  it("negative control: the session-id guard hands the retired bridge's set back", () => {
    // The session-id guard's shape, shown to fail: the recorder reports what it cannot see.
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

/**
 * Let continuations run without crossing a macrotask boundary. Not the shared
 * `crossMacrotaskBoundary`: yielding to the macrotask queue would let a due timer fire, and
 * every case below asserts nothing fell due while the window's clock stood still. Four passes,
 * one more than the deepest `.then` chain a model opening a read arms.
 */
async function settleWithoutCrossingATimer(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
  }
}

describe("the Agents pane's models — whose clock their reads run on", () => {
  it("performs its opening reads when the window's clock advances", async () => {
    // Under the fixture the window runs on the scenario engine's frozen clock, and reads arm
    // through the refresh chokepoint, so a model that minted its own `RealClock` would arm on
    // wall time and nothing here would fall due.
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
    // Guards against reads performed eagerly on construction, which would make the advance
    // above incidental.
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
