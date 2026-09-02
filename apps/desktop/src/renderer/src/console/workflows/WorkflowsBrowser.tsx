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
// WHY THE MAPPING FROM READ STATE TO GROUP STATE LIVES HERE. The chrome is told
// about rows, pending scopes, and per-scope refusals; the port answers with ONE
// outcome for the whole enumeration. Turning one answer into what three groups show
// is a decision — one read serves all three scopes, so a wait belongs to all three
// and a refusal belongs to all three — and it is made once here rather than inside
// the chrome, which would then have two ways to be told the same thing.

import { useMemo } from "react";

import type { GrowthPort } from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import { WORKFLOW_DEFINITION_SCOPES, type WorkflowDefinitionScope } from "./DefinitionsBrowser.js";
import { WorkflowsSurface } from "./WorkflowsSurface.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
} from "./definition-directory.js";

/** The scopes whose page is still in flight, given one read state. */
function pendingScopesFor(
  directory: WorkflowDefinitionDirectoryState,
): readonly WorkflowDefinitionScope[] | undefined {
  return directory.status === "reading" ? WORKFLOW_DEFINITION_SCOPES : undefined;
}

/**
 * The refusal each group carries, given one read state.
 *
 * All three or none: the enumeration is one call across every visible scope, so a
 * refusal landing on one group and not the others would be inventing a per-scope
 * answer the wire never gave.
 */
function scopeRefusalsFor(
  directory: WorkflowDefinitionDirectoryState,
): Readonly<Partial<Record<WorkflowDefinitionScope, ConsoleRefusal>>> | undefined {
  if (directory.status !== "unavailable") {
    return undefined;
  }
  return Object.fromEntries(WORKFLOW_DEFINITION_SCOPES.map((scope) => [scope, directory.refusal]));
}

export interface WorkflowsBrowserProps {
  readonly growth: GrowthPort;
  /** The session the enumeration is scoped to, or nothing where none is in scope. */
  readonly sessionId: string | undefined;
}

/** The definitions browser, reading the definitions it shows. */
export function WorkflowsBrowser(props: WorkflowsBrowserProps): React.JSX.Element {
  const directory = useWorkflowDefinitionDirectory(props.growth, props.sessionId);
  // Memoized on the read state alone: both derivations are pure functions of it, and
  // rebuilding the refusal record every render would hand the browser a fresh object
  // identity each time and defeat the row memoization underneath it.
  const pendingScopes = useMemo(() => pendingScopesFor(directory), [directory]);
  const scopeRefusals = useMemo(() => scopeRefusalsFor(directory), [directory]);
  return (
    <WorkflowsSurface
      state={{ kind: "ready" }}
      definitions={directory.status === "served" ? directory.definitions : undefined}
      pendingScopes={pendingScopes}
      scopeRefusals={scopeRefusals}
    />
  );
}
