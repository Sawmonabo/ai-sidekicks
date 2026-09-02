// The definitions browser with a wire behind it.
//
// `WorkflowsSurface` is the chrome and takes rows; this is the component that goes
// and gets them. Two callers mount it — the rail's workflows destination, and the
// builder pane's no-subject arm — and they differ in exactly one input, which is
// why it is one component rather than two: whether a session is in scope.
//
// THE ENUMERATION IS SESSION-SCOPED, AND THAT IS THE WIRE'S SHAPE RATHER THAN A
// CHOICE. Resolution walks `session` then `project` then `shared` FROM a session, so
// the registered request carries a required session id. A bare rail address names no
// session and therefore has no question to put: the browser renders its three named
// groups with the read unasked, which is also the empty state the design calls for,
// because the scope model has to be legible before anything exists. The same browser
// mounted inside a session does put the question and shows what came back.
//
// WHY THE MAPPING FROM READ STATE TO CHROME STATE LIVES HERE. The chrome is told
// about rows, pending scopes, and which of the absence grammars to reach for; the
// port answers with ONE outcome for the whole enumeration. Turning one answer into
// what the surface shows is a decision, and it is made once here rather than inside
// the chrome, which would then have two ways to be told the same thing.
//
// A REFUSED ENUMERATION IS ONE REFUSAL AND NOT THREE EMPTY GROUPS. A wait does belong
// to all three scopes — one read serves them all, so all three are pending together
// — but a REFUSAL does not distribute the same way: attaching it to each group left
// every group rendering the refusal AND `No <scope> definitions` underneath it,
// which turns one failed read into three asserted empty results about a daemon that
// answered none of them. The refusal is the whole surface's, so it reaches the chrome
// as the `refused` state and the groups are not rendered at all.
//
// AND THERE IS NO PER-SCOPE REFUSAL BESIDE IT, because no registered reply carries
// one. The enumeration's reply is a single envelope — the rows and a cursor — so a
// refusal of it is the call's and not a scope's, and this hook puts ONE unscoped read
// for the resolved union rather than three scoped ones. The refusal that would really
// have belonged to a single scope is an authoring denial at `shared`, and the growth
// port declares no authoring operation at all: its workflow half is the enumeration,
// the run start, read, cancel and resume, the phase-output read, the gate resolve,
// the human-form submit, the gate-chain verify and the run enumeration — ten
// operations, none of which writes a definition. A prop for a refusal nothing in this
// console can raise is a seam that reads as coverage and has no producer, so the
// browser passes none and the surface below declares none.

import { useMemo } from "react";

import type { GrowthPort } from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import { WORKFLOW_DEFINITION_SCOPES, type WorkflowDefinitionScope } from "./DefinitionsBrowser.js";
import { WorkflowsSurface } from "./WorkflowsSurface.js";
import { refusedWorkflowChrome, type WorkflowChromeState } from "./chrome-state.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
} from "./definition-directory.js";

/**
 * Which chrome the surface wears, given one read state.
 *
 * `ready` for every arm that has something to show or something to wait on, and the
 * refusal grammar for the one that does not: a refused enumeration produced no list
 * to group, so the groups do not render and the daemon's own code and message stand
 * in their place.
 */
function chromeStateFor(directory: WorkflowDefinitionDirectoryState): WorkflowChromeState {
  return directory.status === "unavailable"
    ? refusedWorkflowChrome(directory.refusal)
    : { kind: "ready" };
}

/**
 * The continuation control the browser offers, given one read state.
 *
 * Present exactly while the hook would act on it — a cursor in hand and nothing in
 * flight — so "absent, not disabled" is decided once, here, rather than by the
 * browser rendering a control and the hook quietly ignoring it.
 */
function continuationActionFor(
  directory: WorkflowDefinitionDirectoryState,
  continueReading: () => void,
): (() => void) | undefined {
  if (directory.status !== "served") {
    return undefined;
  }
  const { continuation } = directory;
  return continuation.status === "available" || continuation.status === "unavailable"
    ? continueReading
    : undefined;
}

/** The refusal a continuation came back with, if the last one did. */
function continuationRefusalFor(
  directory: WorkflowDefinitionDirectoryState,
): ConsoleRefusal | undefined {
  return directory.status === "served" && directory.continuation.status === "unavailable"
    ? directory.continuation.refusal
    : undefined;
}

/** The scopes whose page is still in flight, given one read state. */
function pendingScopesFor(
  directory: WorkflowDefinitionDirectoryState,
): readonly WorkflowDefinitionScope[] | undefined {
  return directory.status === "reading" ? WORKFLOW_DEFINITION_SCOPES : undefined;
}

export interface WorkflowsBrowserProps {
  readonly growth: GrowthPort;
  /** The session the enumeration is scoped to, or nothing where none is in scope. */
  readonly sessionId: string | undefined;
}

/** The definitions browser, reading the definitions it shows. */
export function WorkflowsBrowser(props: WorkflowsBrowserProps): React.JSX.Element {
  const { state, continueReading } = useWorkflowDefinitionDirectory(props.growth, props.sessionId);
  // Memoized on the read state alone: the derivation is a pure function of it, and
  // rebuilding the scope tuple every render would hand the browser a fresh object
  // identity each time and defeat the row memoization underneath it.
  const pendingScopes = useMemo(() => pendingScopesFor(state), [state]);
  return (
    <WorkflowsSurface
      state={chromeStateFor(state)}
      definitions={state.status === "served" ? state.definitions : undefined}
      pendingScopes={pendingScopes}
      onContinueReading={continuationActionFor(state, continueReading)}
      isContinuing={state.status === "served" && state.continuation.status === "reading"}
      continuationRefusal={continuationRefusalFor(state)}
    />
  );
}
