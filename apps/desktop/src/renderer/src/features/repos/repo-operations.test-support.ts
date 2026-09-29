// What every test that hands a surface its repository calls builds them from.
//
// Every call rejects until a case scripts it, with an error that names the call, so a
// surface that reaches for a call the case did not expect fails on a sentence instead of on
// an `undefined`. A case scripts only the calls it is about and reads what they were asked
// from the arguments its own stubs receive.
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

/** A call that rejects with a sentence naming it, for every call a case did not script. */
function unscriptedCall(name: keyof RepoOperations): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} was not scripted for this case.`));
}
