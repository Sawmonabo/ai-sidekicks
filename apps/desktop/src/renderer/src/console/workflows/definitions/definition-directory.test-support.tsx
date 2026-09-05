// What both directory suites need before they can watch the hook.
//
// The hook has two halves and a suite each — what one read settles as, and the pages
// beyond the first — and both watch it the same way: mount a probe that renders
// nothing, collect every directory it hands back, and read the last one. A copy of
// that mount per suite would be two places a "the probe never rendered" failure comes
// from, and two chances for one of them to start observing differently.
//
// THE PAGED PORT IS HERE BECAUSE BOTH HALVES ASK FOR TWO PAGES. The settlement suite
// wants a served list to move a scope away from; the paging suite wants the cursor
// that reaches the second page. One port answering per cursor serves both, and the
// value it returns is the registered one, so a page this fixture serves is a page the
// wire could send.
//
// WHAT IS NOT HERE IS WHAT ONE SUITE READS: the scripted-refusal scenario, the second
// session, the first-render reader, and the continuation press each have one reader
// and stay beside it.

import { act, render } from "@testing-library/react";

import { createRefusingGrowthPort, type GrowthPort } from "../../bridge/index.js";
import { definition } from "../WorkflowsBrowser.test-support.js";
import type { WorkflowDefinitionRow } from "./definition-rows.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
} from "./definition-directory.js";

/** The continuation token the first page below hands back. */
export const SECOND_PAGE_CURSOR = "definitions-page-2";

/** One settled page, derived from the port's own answer rather than restated. */
type SettledDefinitionPage = Awaited<ReturnType<GrowthPort["workflowDefinitionList"]>>;

/**
 * One row per id, which is what these cases read back: the id is the only member that
 * says WHICH read committed. Everything else is the family's row, built once at
 * `../WorkflowsBrowser.test-support.tsx` — including `scopeRef`, whose default is this
 * same probe session.
 */
export function definitionWithId(id: string): WorkflowDefinitionRow {
  return definition({
    id,
    name: `Definition ${id}`,
    latestVersionNumber: 1,
    latestWorkflowVersionId: `${id}-version-1`,
    contentHash: `b3:${id}`,
  });
}

/** The real port with the enumeration answered per cursor, and nothing else changed. */
export function pagedGrowthPort(
  answerFor: (cursor: string | undefined) => SettledDefinitionPage,
): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowDefinitionList: async (request) => answerFor(request.cursor),
  };
}

/** Two pages, the first handing back the cursor that reaches the second. */
export function twoPagePort(secondPageIds: readonly string[] = ["third", "fourth"]): GrowthPort {
  return pagedGrowthPort((cursor) =>
    cursor === undefined
      ? {
          status: "served",
          value: {
            definitions: [definitionWithId("first"), definitionWithId("second")],
            nextCursor: SECOND_PAGE_CURSOR,
          },
        }
      : { status: "served", value: { definitions: secondPageIds.map(definitionWithId) } },
  );
}

function DirectoryProbe(props: {
  readonly growth: GrowthPort;
  readonly sessionId: string | undefined;
  readonly onObserve: (directory: WorkflowDefinitionDirectory) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowDefinitionDirectory(props.growth, props.sessionId));
  return <></>;
}

export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export function observeDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowDefinitionDirectory[] {
  return rescopableDirectory(growth, sessionId).observed;
}

/**
 * The same probe, with the handle a scope change needs.
 *
 * The browser is not remounted when the operator moves to another session — it is
 * re-rendered with a different scope, which is the subject of the rescope case below.
 */
export function rescopableDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): {
  readonly observed: WorkflowDefinitionDirectory[];
  readonly rescope: (next: string) => void;
} {
  const observed: WorkflowDefinitionDirectory[] = [];
  const collect = (directory: WorkflowDefinitionDirectory): void => {
    observed.push(directory);
  };
  const view = render(<DirectoryProbe growth={growth} sessionId={sessionId} onObserve={collect} />);
  return {
    observed,
    rescope: (next) => {
      view.rerender(<DirectoryProbe growth={growth} sessionId={next} onObserve={collect} />);
    },
  };
}

export function latest(
  observed: readonly WorkflowDefinitionDirectory[],
): WorkflowDefinitionDirectory {
  const directory = observed.at(-1);
  if (directory === undefined) {
    throw new Error("the probe never rendered, so there is nothing to read");
  }
  return directory;
}

export function lastState(
  observed: readonly WorkflowDefinitionDirectory[],
): WorkflowDefinitionDirectoryState {
  return latest(observed).state;
}

export function definitionIds(state: WorkflowDefinitionDirectoryState): readonly string[] {
  return state.status === "served" ? state.definitions.map((row) => row.id) : [];
}
