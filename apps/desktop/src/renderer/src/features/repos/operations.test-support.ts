// The repository calls a component is handed, all rejecting with an error that names the call
// until a case scripts it; a case scripts only what it is about.
import type { RepoOperations } from "./operations.js";

/** The repository calls with the scripted ones replaced and the rest rejecting. */
export function scriptedRepoOperations(script: Partial<RepoOperations> = {}): RepoOperations {
  return {
    readMount: unscriptedCall("readMount"),
    listWorkspaces: unscriptedCall("listWorkspaces"),
    readWorktreeStatus: unscriptedCall("readWorktreeStatus"),
    attachRepository: unscriptedCall("attachRepository"),
    bindWorkspace: unscriptedCall("bindWorkspace"),
    prepareExecutionRoot: unscriptedCall("prepareExecutionRoot"),
    retireWorktree: unscriptedCall("retireWorktree"),
    ...script,
  };
}

/** A call that rejects with a sentence naming it. */
function unscriptedCall(name: keyof RepoOperations): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} was not scripted for this case.`));
}
