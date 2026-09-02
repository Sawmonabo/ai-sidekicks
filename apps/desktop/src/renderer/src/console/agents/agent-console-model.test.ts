// Who owns the agent console's reads, and for how long.
//
// A model never belongs to a session it is not for. State replaced from an effect
// lags its inputs by a frame, so the mismatched frame has to be watched as it
// happens rather than after it settles.

import { renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { SessionStore } from "../store/index.js";
import { AgentConsoleModels, useAgentConsoleModels } from "./agent-console-model.js";

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
