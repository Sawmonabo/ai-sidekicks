// Who owns the agent console's reads, and for how long.
//
// Two lifetime claims are checked here, because both are claims a rendered surface
// cannot make on its own:
//
//   • **A model never belongs to a session it is not for.** State replaced from an
//     effect lags its inputs by a frame, so the mismatched frame has to be watched
//     as it happens rather than after it settles.
//   • **Acquiring a linkage read is not starting one.** The split exists so a
//     render body can never open a subscription, and "never started" is only
//     observable on the model itself.
//
// What REFRESHES each read is `agent-console-reads.test.ts`, beside the factories
// that decide it.

import { renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { AgentConsoleModels, useAgentConsoleModels } from "./agent-console-model.js";

const PARENT_RUN_ID = "run-7";
const OTHER_PARENT_RUN_ID = "run-9";

/** A real fixture bridge that scripts no reply, so every read settles as refused. */
function unscriptedBridge(id: string): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario(id), {});
}

/** An initialised store, so an appended event is admitted rather than buffered. */
function initialisedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

// --- A model never belongs to a session it is not for -------------------------

/** Every value the hook answered, in render order, including uncommitted frames. */
function recordedModelSessionIds(
  bridge: ConsoleBridge,
  first: SessionStore,
  second: SessionStore,
): readonly (string | undefined)[] {
  const answered: (string | undefined)[] = [];
  const view = renderHook(
    (sessionStore: SessionStore) => {
      const models = useAgentConsoleModels(bridge, sessionStore);
      answered.push(models?.sessionId);
      return models;
    },
    { initialProps: first },
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
function useUnguardedAgentConsoleModels(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): AgentConsoleModels | undefined {
  return useHeldAgentConsoleModels(bridge, sessionStore);
}

/**
 * The second shape this finding replaced: the guard compared the SESSION ID.
 *
 * A replacement bridge or a rebuilt store under one session passes it, so the first
 * committed render after either hands back a set bound to what was just retired.
 */
function useSessionIdGuardedAgentConsoleModels(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): AgentConsoleModels | undefined {
  const models = useHeldAgentConsoleModels(bridge, sessionStore);
  return models !== undefined && models.sessionId === sessionStore.sessionId ? models : undefined;
}

/** The lifecycle both stand-ins share — a set built and disposed by an effect. */
function useHeldAgentConsoleModels(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): AgentConsoleModels | undefined {
  const [models, setModels] = useState<AgentConsoleModels | undefined>(undefined);
  useEffect(() => {
    const built = new AgentConsoleModels(bridge, sessionStore);
    setModels(built);
    return () => {
      built.dispose();
      setModels(undefined);
    };
  }, [bridge, sessionStore]);
  return models;
}

describe("the agent console's models — the session they belong to", () => {
  it("answers nothing on the frame where the held set is the previous session's", () => {
    const bridge = unscriptedBridge("agent-models-match");
    const afterSwitch = recordedModelSessionIds(
      bridge,
      initialisedStore("session-a"),
      initialisedStore("session-b"),
    );

    // The pane's binding column dispatches attach, config-update, and detach
    // through whatever this answers, so one frame carrying the left session's
    // models would mutate a session the console is no longer showing.
    expect(afterSwitch).not.toContain("session-a");
    expect(afterSwitch.at(-1)).toBe("session-b");
  });

  it("negative control: without the check that same frame carries the previous session", () => {
    const bridge = unscriptedBridge("agent-models-unguarded");
    const answered: (string | undefined)[] = [];
    const view = renderHook(
      (sessionStore: SessionStore) => {
        const models = useUnguardedAgentConsoleModels(bridge, sessionStore);
        answered.push(models?.sessionId);
        return models;
      },
      { initialProps: initialisedStore("session-a") },
    );
    const beforeSwitch = answered.length;
    view.rerender(initialisedStore("session-b"));

    expect(answered.slice(beforeSwitch)).toContain("session-a");
  });

  it("answers nothing at all where the mount resolved no session", () => {
    const bridge = unscriptedBridge("agent-models-storeless");
    const view = renderHook(() => useAgentConsoleModels(bridge, undefined));
    expect(view.result.current).toBeUndefined();
  });
});

// --- Acquiring a linkage read is not starting one -----------------------------

describe("the agent console's models — the linkage lease", () => {
  it("hands out a read that has not subscribed and has read nothing", () => {
    const models = new AgentConsoleModels(
      unscriptedBridge("agent-linkage-acquire"),
      initialisedStore("session-lease"),
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
    const models = new AgentConsoleModels(
      unscriptedBridge("agent-linkage-release"),
      initialisedStore("session-lease"),
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
    const models = new AgentConsoleModels(
      unscriptedBridge("agent-linkage-rekey"),
      initialisedStore("session-lease"),
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
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}

/** Every set the hook answered after its inputs were replaced, in render order. */
function answersAfterReplacing(
  before: ModelsProbeInputs,
  after: ModelsProbeInputs,
): readonly (AgentConsoleModels | undefined)[] {
  const answered: (AgentConsoleModels | undefined)[] = [];
  const view = renderHook(
    (inputs: ModelsProbeInputs) => {
      const models = useAgentConsoleModels(inputs.bridge, inputs.sessionStore);
      answered.push(models);
      return models;
    },
    { initialProps: before },
  );
  const beforeReplacement = answered.length;
  view.rerender(after);
  return answered.slice(beforeReplacement);
}

describe("the agent console's models — the exact bridge and store they answer for", () => {
  it("answers nothing on the frame where the bridge was replaced under one session", () => {
    const sessionStore = initialisedStore("session-reconnect");
    const replacement = unscriptedBridge("agent-models-bridge-b");
    const afterReplacement = answersAfterReplacing(
      { bridge: unscriptedBridge("agent-models-bridge-a"), sessionStore },
      { bridge: replacement, sessionStore },
    );

    // The retired bridge's reads are bound to a transport this mount no longer
    // holds, and the binding column would dispatch every mutation through it.
    expect(afterReplacement[0]).toBeUndefined();
    expect(afterReplacement.at(-1)?.subject.bridge).toBe(replacement);
  });

  it("answers nothing on the frame where the store was rebuilt under one session", () => {
    const bridge = unscriptedBridge("agent-models-store-rebuild");
    const rebuilt = initialisedStore("session-rebuilt");
    const afterReplacement = answersAfterReplacing(
      { bridge, sessionStore: initialisedStore("session-rebuilt") },
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
    const inputs: ModelsProbeInputs = {
      bridge: unscriptedBridge("agent-models-unchanged"),
      sessionStore: initialisedStore("session-unchanged"),
    };
    const afterRerender = answersAfterReplacing(inputs, inputs);
    expect(afterRerender.at(-1)?.subject).toStrictEqual(inputs);
  });

  it("negative control: the session-id guard hands the retired bridge's set back", () => {
    // The shape this finding replaced. It is the instrument's proof: the recorder
    // above reports a mismatched frame when the guard cannot see one.
    const sessionStore = initialisedStore("session-id-only");
    const retired = unscriptedBridge("agent-models-id-only-a");
    const replacement = unscriptedBridge("agent-models-id-only-b");
    const answered: (AgentConsoleModels | undefined)[] = [];
    const view = renderHook(
      (inputs: ModelsProbeInputs) => {
        const models = useSessionIdGuardedAgentConsoleModels(inputs.bridge, inputs.sessionStore);
        answered.push(models);
        return models;
      },
      { initialProps: { bridge: retired, sessionStore } },
    );
    const beforeReplacement = answered.length;
    view.rerender({ bridge: replacement, sessionStore });

    expect(
      answered.slice(beforeReplacement).some((models) => models?.subject.bridge === retired),
    ).toBe(true);
  });
});
