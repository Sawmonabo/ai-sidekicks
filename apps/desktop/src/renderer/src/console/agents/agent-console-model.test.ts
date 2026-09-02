// Who owns the agent console's reads, and for how long.
//
// Two lifetime claims are checked here, because both are claims a rendered surface
// cannot make on its own:
//
//   • **A model never belongs to a session it is not for.** State replaced from an
//     effect lags its inputs by a frame, so the mismatched frame has to be watched
//     as it happens rather than after it settles.
//   • **The linkage has a push signal.** Its watched kinds are two registered
//     `SessionEventType` members, and what the filter admits is counted rather
//     than inferred from a rendered row.

import { act, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { ManualClock, REFRESH_MAX_WAIT_MS } from "../core/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../store/index.js";
import {
  AgentConsoleModels,
  createChildRunLinkage,
  createDriverCatalog,
  useAgentConsoleModels,
} from "./agent-console-model.js";

const PARENT_RUN_ID = "run-7";

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

/** One admitted event of the given kind, numbered so the cursor moves. */
function eventOfKind(
  sessionStore: SessionStore,
  kind: ConsoleSessionEvent["kind"],
  sequence: number,
): ConsoleSessionEvent {
  return {
    sessionId: sessionStore.sessionId,
    sequence,
    kind,
    occurredAt: "2026-01-01T10:06:00.000Z",
    payload: {},
  };
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

// --- The linkage's push signal ------------------------------------------------

/** A started linkage read over a store this case owns, on frozen time. */
function startedLinkage(
  sessionStore: SessionStore,
  clock: ManualClock,
): ReturnType<typeof createChildRunLinkage> {
  const read = createChildRunLinkage(
    unscriptedBridge("agent-linkage-signal"),
    sessionStore,
    PARENT_RUN_ID,
    clock,
  );
  read.start();
  return read;
}

/** Let every refresh armed inside the coalescing window fall due. */
async function settleReads(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_MAX_WAIT_MS);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
}

describe("the agent console's models — what re-reads one run's child links", () => {
  it("re-reads once when a run is queued, and once when a create is refused", async () => {
    const sessionStore = initialisedStore("session-signal");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    await settleReads(clock);
    expect(read.readCount).toBe(afterFirstRead + 1);

    sessionStore.apply(eventOfKind(sessionStore, "orchestration.rejected", 2));
    await settleReads(clock);
    expect(read.readCount).toBe(afterFirstRead + 2);
  });

  it("coalesces a burst of queued runs into one read", async () => {
    const sessionStore = initialisedStore("session-burst");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 2));
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 3));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead + 1);
  });

  it("re-reads nothing for a kind the linkage does not watch", async () => {
    const sessionStore = initialisedStore("session-unwatched");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "assistant.message", 1));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead);
  });

  it("re-reads nothing once the read has been disposed", async () => {
    const sessionStore = initialisedStore("session-disposed");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    read.dispose();
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead);
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: the read whose subscribe is a stated no-op re-reads zero times", async () => {
    // The driver catalog is the shape the linkage had — no signal at all — and it
    // sits beside it in this module. Without this the cases above would pass over
    // an instrument that counted something other than a re-read.
    const sessionStore = initialisedStore("session-no-signal");
    const clock = new ManualClock();
    const catalog = createDriverCatalog(unscriptedBridge("agent-catalog-signal"), clock);
    catalog.start();
    await settleReads(clock);
    const afterFirstRead = catalog.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    await settleReads(clock);

    expect(afterFirstRead).toBeGreaterThan(0);
    expect(catalog.readCount).toBe(afterFirstRead);
    catalog.dispose();
  });
});
