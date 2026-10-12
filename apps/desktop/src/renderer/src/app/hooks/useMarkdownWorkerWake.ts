// Wakes the app's markdown worker as the app starts, so the parser compiles and the worker loads it
// before any window draws a reply, and again on the app-wide signs that a window will soon
// draw new markdown, and holds it awake while a turn runs in any open session, so its idle stop is
// never felt: a window coming forward, a session shown, and a turn starting. The composer's
// keystrokes and the transcript's scroll wake it where they happen.

import type { RunState } from "@ai-sidekicks/contracts/run/state";
import { useEffect } from "react";

import {
  markdownWorker,
  type MarkdownWorkerConnection,
} from "#renderer/components/Markdown/worker/connection.js";
import { routeSessionId } from "#renderer/routing/readers.js";
import { readRunState } from "#renderer/services/daemon/wire/identifiers.js";
import type { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { OpenWindowStore } from "../window/stores.js";

/**
 * Wake the markdown worker as the app starts, when a window comes forward or shows a session, and
 * when a turn starts in any open session; hold it awake until no open session has a turn running.
 */
export function useMarkdownWorkerWake(
  sessionStoreRegistry: SessionStoreRegistry,
  windows: readonly OpenWindowStore[],
): void {
  useEffect(() => {
    markdownWorker.wake();
  }, []);
  useEffect(
    () => holdAwakeWhileTurnRuns(markdownWorker, sessionStoreRegistry),
    [sessionStoreRegistry],
  );
  useEffect(() => {
    const unsubscribes = windows.map(({ store }) =>
      store.readable.subscribe((state, previous) => {
        const shownSessionId = routeSessionId(state.route);
        if (
          (state.isWindowFocused && !previous.isWindowFocused) ||
          (shownSessionId !== undefined && shownSessionId !== routeSessionId(previous.route))
        ) {
          markdownWorker.wake();
        }
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [windows]);
}

/**
 * The run states of a turn that can still put text on screen. A run waiting on the person, paused
 * or pausing is left out: it may wait for hours, and the person's own act wakes the worker.
 */
const TEXT_PRODUCING_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "queued",
  "starting",
  "running",
]);

/**
 * Hold `worker` awake while any session `registry` has open holds a turn that can still produce
 * text, waking it as the first such turn appears. Each store is read again only when its runs
 * change, so a streaming reply's text costs one identity check per batch.
 */
function holdAwakeWhileTurnRuns(
  worker: MarkdownWorkerConnection,
  registry: SessionStoreRegistry,
): Unsubscribe {
  const storeWatches = new Map<string, Unsubscribe>();
  let releaseHold: Unsubscribe | undefined;
  const reconcile = (): void => {
    const isTurnRunning = registry.openSessionIds.some((sessionId) => {
      const runs = registry.peek(sessionId)?.snapshot().partitions.run ?? {};
      return Object.values(runs).some((run) => {
        const state = run.state === undefined ? undefined : readRunState(run.state);
        return state !== undefined && TEXT_PRODUCING_RUN_STATES.has(state);
      });
    });
    if (isTurnRunning && releaseHold === undefined) {
      worker.wake();
      releaseHold = worker.holdAwake();
    } else if (!isTurnRunning && releaseHold !== undefined) {
      releaseHold();
      releaseHold = undefined;
    }
  };
  const watch = (sessionId: string): void => {
    const store = registry.peek(sessionId);
    if (store === undefined) {
      return;
    }
    storeWatches.get(sessionId)?.();
    let runs = store.snapshot().partitions.run;
    storeWatches.set(
      sessionId,
      store.readable.subscribe((state) => {
        if (state.partitions.run !== runs) {
          runs = state.partitions.run;
          reconcile();
        }
      }),
    );
  };
  for (const sessionId of registry.openSessionIds) {
    watch(sessionId);
  }
  const unsubscribeRegistry = registry.subscribe(({ sessionId, change }) => {
    if (change === "opened") {
      watch(sessionId);
    } else {
      storeWatches.get(sessionId)?.();
      storeWatches.delete(sessionId);
    }
    reconcile();
  });
  reconcile();
  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of storeWatches.values()) {
      unsubscribe();
    }
    releaseHold?.();
  };
}
