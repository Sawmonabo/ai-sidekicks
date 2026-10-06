// One pair of stub calls (paged enumeration and run start) shared by the workflow suites.

import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/definition";
import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type { ReadWorkflowDefinitionPage } from "./definition/enumeration.js";
import type { WorkflowStartOperations, WorkflowStartRequest } from "./start-from-line.js";

/** The session every case in this suite addresses. */
export const WORKFLOW_TEST_SESSION_ID = "session-workflow-start";

const PAGE_CURSOR_PREFIX = "page-";

/** How a fixture definition differs from the default one. */
export interface WorkflowDefinitionSeed {
  readonly name: string;
  /** Defaults to `version-<name>`, so a start's pin is readable in an assertion. */
  readonly latestWorkflowVersionId?: string;
}

/** One page of the enumeration. */
export interface WorkflowDefinitionPageSeed {
  readonly definitions: readonly WorkflowDefinitionSeed[];
}

/** The requests each of the two operations received, in call order. */
export interface WorkflowCalls {
  readonly listed: Parameters<ReadWorkflowDefinitionPage>[0][];
  readonly started: WorkflowStartRequest[];
}

/** What a workflow fixture is built from. */
export interface WorkflowFixtureOptions {
  /** The whole enumeration on one page. The ordinary case. */
  readonly definitions?: readonly WorkflowDefinitionSeed[];
  /** The enumeration across several pages, for the cases about the cursor. */
  readonly pages?: readonly WorkflowDefinitionPageSeed[];
  /** Every page carries a next cursor, so no walk of it ever exhausts. */
  readonly endless?: boolean;
  /** Where each call's request is recorded, for the cases that assert on one. */
  readonly calls?: WorkflowCalls;
  /** Called on each list request, for the cases that need to act between pages. */
  readonly onList?: (request: Parameters<ReadWorkflowDefinitionPage>[0]) => void;
}

/** A wire-shaped definition, so a case never asserts against a partial one. */
export function workflowDefinition(seed: WorkflowDefinitionSeed): WorkflowDefinitionSummary {
  return {
    id: `definition-${seed.name}` as WorkflowDefinitionId,
    name: seed.name,
    latestVersionNumber: 1,
    latestWorkflowVersionId: seed.latestWorkflowVersionId ?? `version-${seed.name}`,
    contentHash: `hash-${seed.name}`,
    triggerKind: "trigger.manual",
    enabled: true,
    tags: [],
    runCount: 0,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

/** Stubs for the two workflow operations, paging by the cursor the previous page returned. */
export function fixtureWorkflowStartOperations(
  options: WorkflowFixtureOptions = {},
): WorkflowStartOperations {
  const pages: readonly WorkflowDefinitionPageSeed[] = options.pages ?? [
    { definitions: options.definitions ?? [] },
  ];
  return {
    readDefinitionPage: async (request) => {
      options.calls?.listed.push(request);
      options.onList?.(request);
      const pageIndex = pageIndexOf(request.cursor);
      // An endless enumeration cycles its pages, like a daemon handing back a cursor forever.
      const page = options.endless === true ? pages[pageIndex % pages.length] : pages[pageIndex];
      if (page === undefined) {
        throw new Error(`the fixture has no page for cursor ${String(request.cursor)}`);
      }
      const hasNextPage = options.endless === true || pageIndex + 1 < pages.length;
      return {
        definitions: page.definitions.map(workflowDefinition),
        nextCursor: hasNextPage ? `${PAGE_CURSOR_PREFIX}${String(pageIndex + 1)}` : undefined,
      };
    },
    startRun: async (request) => {
      options.calls?.started.push(request);
    },
  };
}

/** A fresh recorder, so each case reads only its own calls. */
export function recordedWorkflowCalls(): WorkflowCalls {
  return { listed: [], started: [] };
}

/** Which page a cursor names; an absent cursor is the first page. */
function pageIndexOf(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const index = Number.parseInt(cursor.slice(PAGE_CURSOR_PREFIX.length), 10);
  return Number.isNaN(index) ? Number.MAX_SAFE_INTEGER : index;
}
