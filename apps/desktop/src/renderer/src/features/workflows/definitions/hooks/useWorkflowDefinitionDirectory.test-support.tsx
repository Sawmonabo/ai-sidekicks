// What the directory suites need before they can watch the hook.
//
// Each suite mounts a probe that renders nothing, collects every directory it hands back,
// and reads the last one; the mount lives here once so a "the probe never rendered"
// failure has one source. The two-page call is here because both the settlement and the
// paging suite want a served list with a cursor that reaches a second page.

import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";

import { SECOND_PAGE_CURSOR, definition } from "../../workflows-probe.test-support.js";
import type { WorkflowDefinitionRow } from "../definition-rows.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
  type WorkflowDefinitionListCall,
} from "./useWorkflowDefinitionDirectory.js";

/**
 * One row per id, which is what these cases read back: the id is the only member that
 * says WHICH read committed. Everything else is the workflows feature's shared row, built once at
 * `../workflows-probe.test-support.ts` — including `scopeRef`, whose default is this
 * same probe session.
 */
export function definitionWithId(id: string): WorkflowDefinitionRow {
  return definition({
    id: id as WorkflowDefinitionId,
    name: `Definition ${id}`,
    latestVersionNumber: 1,
    latestWorkflowVersionId: `${id}-version-1`,
    contentHash: `b3:${id}`,
  });
}

/** Two pages, the first handing back the cursor that reaches the second. */
export function twoPageCall(
  secondPageIds: readonly string[] = ["third", "fourth"],
): WorkflowDefinitionListCall {
  return async (request) =>
    request.cursor === undefined
      ? {
          definitions: [definitionWithId("first"), definitionWithId("second")],
          nextCursor: SECOND_PAGE_CURSOR,
        }
      : { definitions: secondPageIds.map(definitionWithId) };
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
  return rescopableDirectory(listDefinitions, sessionId).observed;
}

/**
 * The same probe, with the handle a scope change needs.
 *
 * The browser is not remounted when the operator moves to another session — it is
 * re-rendered with a different scope, which is the subject of the rescope case below.
 */
export function rescopableDirectory(
  listDefinitions: WorkflowDefinitionListCall,
  sessionId: string | undefined,
): {
  readonly observed: WorkflowDefinitionDirectory[];
  readonly rescope: (next: string) => void;
} {
  const observed: WorkflowDefinitionDirectory[] = [];
  const collect = (directory: WorkflowDefinitionDirectory): void => {
    observed.push(directory);
  };
  const view = render(
    <DirectoryProbe listDefinitions={listDefinitions} sessionId={sessionId} onObserve={collect} />,
  );
  return {
    observed,
    rescope: (next) => {
      view.rerender(
        <DirectoryProbe listDefinitions={listDefinitions} sessionId={next} onObserve={collect} />,
      );
    },
  };
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
