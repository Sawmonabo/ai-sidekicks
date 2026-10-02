// What the directory suite needs to watch the hook: a probe that renders nothing and collects
// every directory it is handed.

import type { WorkflowDefinitionId, WorkflowDefinitionSummary } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";

import { SECOND_PAGE_CURSOR, definition } from "../../workflows-probe.test-support.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
  type WorkflowDefinitionListCall,
} from "./useWorkflowDefinitionDirectory.js";

/** Two pages, the first handing back the cursor that reaches the second. */
export function twoPageCall(): WorkflowDefinitionListCall {
  return async (request) =>
    request.cursor === undefined
      ? {
          definitions: [definitionWithId("first"), definitionWithId("second")],
          nextCursor: SECOND_PAGE_CURSOR,
        }
      : { definitions: [definitionWithId("third"), definitionWithId("fourth")] };
}

/**
 * Mount the probe and return every directory it was handed, oldest first.
 *
 * Pass a stable call: the hook re-reads when the call's identity changes.
 */
export function observeDirectory(
  listDefinitions: WorkflowDefinitionListCall,
  sessionId: string | undefined,
): WorkflowDefinitionDirectory[] {
  const observed: WorkflowDefinitionDirectory[] = [];
  render(
    <DirectoryProbe
      listDefinitions={listDefinitions}
      sessionId={sessionId}
      onObserve={(directory) => {
        observed.push(directory);
      }}
    />,
  );
  return observed;
}

/** The newest directory the probe was handed. Throws if the probe never rendered. */
export function latest(
  observed: readonly WorkflowDefinitionDirectory[],
): WorkflowDefinitionDirectory {
  const directory = observed.at(-1);
  if (directory === undefined) {
    throw new Error("the probe never rendered, so there is nothing to read");
  }
  return directory;
}

/** The newest directory's state. */
export function lastState(
  observed: readonly WorkflowDefinitionDirectory[],
): WorkflowDefinitionDirectoryState {
  return latest(observed).state;
}

/** The ids of the served rows in order, or none while the read is unsettled. */
export function definitionIds(state: WorkflowDefinitionDirectoryState): readonly string[] {
  return state.status === "served" ? state.definitions.map((row) => row.id) : [];
}

function DirectoryProbe(props: {
  readonly listDefinitions: WorkflowDefinitionListCall;
  readonly sessionId: string | undefined;
  readonly onObserve: (directory: WorkflowDefinitionDirectory) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowDefinitionDirectory(props.listDefinitions, props.sessionId));
  return <></>;
}

/**
 * One row per id; the id is the only member that says which read committed. Everything else
 * is the shared probe row from `../../workflows-probe.test-support.ts`.
 */
function definitionWithId(id: string): WorkflowDefinitionSummary {
  return definition({
    id: id as WorkflowDefinitionId,
    name: `Definition ${id}`,
    latestVersionNumber: 1,
    latestWorkflowVersionId: `${id}-version-1`,
    contentHash: `b3:${id}`,
  });
}
