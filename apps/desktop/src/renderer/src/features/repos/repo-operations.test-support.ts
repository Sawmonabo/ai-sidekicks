// What every test that hands a surface its repository calls builds them from.
//
// Every call rejects until a case scripts it, with an error that names the call, so a
// surface that reaches for a call the case did not expect fails on a sentence instead of on
// an `undefined`. A case scripts only the calls it is about and reads what they were asked
// from the arguments its own stubs receive.

import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import type { ConsoleClock } from "@renderer/lib/clock.js";
import type { RepoOperations } from "./repo-operations.js";

/** The repository calls with the ones a case scripts replaced, and the rest rejecting. */
export function scriptedRepoOperations(script: Partial<RepoOperations> = {}): RepoOperations {
  return {
    readMount: unscriptedCall("readMount"),
    listWorkspaces: unscriptedCall("listWorkspaces"),
    readWorkspaceExecutionModes: unscriptedCall("readWorkspaceExecutionModes"),
    readMountExecutionModes: unscriptedCall("readMountExecutionModes"),
    selectExecutionMode: unscriptedCall("selectExecutionMode"),
    readWorktreeStatus: unscriptedCall("readWorktreeStatus"),
    attachRepository: unscriptedCall("attachRepository"),
    bindWorkspace: unscriptedCall("bindWorkspace"),
    prepareExecutionRoot: unscriptedCall("prepareExecutionRoot"),
    checkWorktreeReuse: unscriptedCall("checkWorktreeReuse"),
    retireWorktree: unscriptedCall("retireWorktree"),
    ...script,
  };
}

/**
 * A bridge whose window runs on this clock, for a case that binds a hook.
 *
 * `consoleClockFor` reads the scenario engine's clock, and `FixtureBridgeOptions` takes no
 * clock, so the engine member is replaced by hand.
 */
export function bridgeOnClock(clock?: ConsoleClock): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: unscriptedScenario("repos") });
  if (clock === undefined) {
    return bridge;
  }
  return { ...bridge, scenarioEngine: { clock } } as ConsoleBridge;
}

/** A call that rejects with a sentence naming it, for every call a case did not script. */
function unscriptedCall(name: keyof RepoOperations): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} was not scripted for this case.`));
}
