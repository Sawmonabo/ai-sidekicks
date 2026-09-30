// One pair of plain stub calls for the whole accelerator's suite.
//
// Three suites drive the same two operations — the paged enumeration and the run
// start — and a stub hand-built beside each would be three answers to what a page and
// a cursor look like.

import type { WorkflowDefinitionId, WorkflowDefinitionSummary } from "@ai-sidekicks/contracts";
import type { ReadWorkflowDefinitionPage } from "./definition-enumeration.js";
import type { WorkflowStartOperations, WorkflowStartRequest } from "./start-workflow-from-line.js";

/** The session every case in this suite addresses. */
export const WORKFLOW_TEST_SESSION_ID = "session-workflow-start";

/** The cursor page `n` is fetched with. Opaque to the code under test, as on the wire. */
const PAGE_CURSOR_PREFIX = "page-";

/** How a fixture definition differs from the default one. */
export interface WorkflowDefinitionSeed {
  readonly name: string;
  /** Defaults to `true`: one definition per name, resolved at this context. */
  readonly resolvesAtThisContext?: boolean;
  /** Defaults to `version-<name>`, so a start's pin is readable in an assertion. */
  readonly latestWorkflowVersionId?: string;
}

/** One page of the enumeration. */
export interface WorkflowDefinitionPageSeed {
  readonly definitions: readonly WorkflowDefinitionSeed[];
}

/** One request each of the two operations was called with, in call order. */
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
    scope: "session",
    scopeRef: WORKFLOW_TEST_SESSION_ID,
    latestVersionNumber: 1,
    latestWorkflowVersionId: seed.latestWorkflowVersionId ?? `version-${seed.name}`,
    contentHash: `hash-${seed.name}`,
    resolvesAtThisContext: seed.resolvesAtThisContext ?? true,
    triggerKind: "trigger.manual",
    enabled: true,
    tags: [],
    runCount: 0,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

/**
 * Stubs for the two workflow operations.
 *
 * The pages are addressed by the cursor the previous page handed back, exactly as the
 * wire's are, so a walk that ignored `nextCursor` reads page one forever here rather
 * than quietly passing.
 */
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
      // An endless enumeration answers every cursor by cycling its pages, which is
      // what a daemon handing back a cursor forever looks like from here.
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

/**
 * Which page a cursor names.
 *
 * An absent cursor is the first page; anything this fixture did not mint is a page
 * that does not exist.
 */
function pageIndexOf(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const index = Number.parseInt(cursor.slice(PAGE_CURSOR_PREFIX.length), 10);
  return Number.isNaN(index) ? Number.MAX_SAFE_INTEGER : index;
}
