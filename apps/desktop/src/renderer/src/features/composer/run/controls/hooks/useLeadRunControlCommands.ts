// The composer's run controls: pause or resume and interrupt for the lead's live run, contributed
// to the command palette while the composer is mounted, dispatched through the daemon. A child's
// controls are reached in its own view, never from the composer.

import { useMemo } from "react";

import { callDaemon, unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { readRunState } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useSessionPartition } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { useComposerAddress } from "#renderer/features/composer/hooks/useComposerAddress.js";
import type { RunControlCommandRun } from "../contributions/commands.js";
import type { RunControlCalls } from "../services/dispatch.js";
import { useRunControlCommands } from "./useRunControlCommands.js";
import { useRunControlDispatch } from "./useRunControlDispatch.js";

/** Contribute the lead's live run's controls while the caller is mounted. */
export function useLeadRunControlCommands(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): void {
  const target = useComposerAddress(sessionStore);
  const runs = useSessionPartition(sessionStore, "run");
  const calls = useMemo(() => runControlCallsOver(bridge), [bridge]);
  const dispatchState = useRunControlDispatch(bridge, calls);
  const addressedRun = target.kind === "run" ? runs[target.targetRunId] : undefined;
  const state = addressedRun?.state === undefined ? undefined : readRunState(addressedRun.state);
  const runVersion: unknown = addressedRun?.body?.["runVersion"];
  const leadRun = useMemo<RunControlCommandRun | undefined>(
    () =>
      addressedRun === undefined || state === undefined || typeof runVersion !== "number"
        ? undefined
        : { sessionId: sessionStore.sessionId, runId: addressedRun.id, runVersion, state },
    [addressedRun, state, runVersion, sessionStore.sessionId],
  );
  useRunControlCommands({ run: leadRun, dispatchState });
}

/** The four control calls over the daemon; a refused call rejects with the daemon's refusal. */
function runControlCallsOver(bridge: PlatformBridge): RunControlCalls {
  return {
    pause: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "agent.run.pause", request)),
    resume: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "agent.run.resume", request)),
    intervene: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "agent.run.intervene", request)),
    childSteer: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "agent.childRun.steer", request)),
  };
}
