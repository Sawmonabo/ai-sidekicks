// The Agents pane models never belong to a session, bridge or store they are not for (state
// replaced from an effect lags its inputs by a frame, so the mismatched frame is watched as it
// happens), and the child-run links read ends with its last lease.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { FixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { AgentsPaneModels } from "./agents-pane-models.js";
import { useAgentsPaneModels } from "./hooks/useAgentsPaneModels.js";
import { initializedStore } from "@test/helpers/session-store-fixtures.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { REJECTING_AGENTS_PANE_CALLS, unscriptedBridge } from "../agent-reads.test-support.js";

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
});

describe("the Agents pane's models — the child-run links lease", () => {
  it("disposes the read when the last lease on it is given back", () => {
    const { bridge, scenarioEngine } = unscriptedBridge("agent-child-run-links-release");
    const models = new AgentsPaneModels(
      bridge,
      scenarioEngine.clock,
      initializedStore("session-lease"),
      REJECTING_AGENTS_PANE_CALLS,
    );
    const first = models.acquireChildRunLinks();
    const second = models.acquireChildRunLinks();
    first.read.start();

    // One read, joined.
    expect(second.read).toBe(first.read);
    expect(models.outstandingChildRunLinksLeaseCount).toBe(2);

    first.release();
    first.release();
    expect(models.holdsChildRunLinks).toBe(true);
    expect(second.read.isSubscribed).toBe(true);

    second.release();
    expect(models.outstandingChildRunLinksLeaseCount).toBe(0);
    expect(models.holdsChildRunLinks).toBe(false);
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

    // Same session id, a different projection: the held agent list answers from the previous
    // store's stream, which nothing appends to any more.
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
});
