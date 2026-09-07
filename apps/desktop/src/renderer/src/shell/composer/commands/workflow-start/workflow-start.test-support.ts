// One growth port for the whole accelerator's suite, built over the real refusing one.
//
// Four suites drive the same two operations — the paged enumeration and the run
// start — and a port hand-built beside each would be four answers to what a page, a
// cursor, and a refusal look like. The base is `createRefusingGrowthPort()` rather
// than an object cast into the port's shape: every operation this accelerator does
// not call answers with the port's OWN refusal, so a module that reached for a third
// wire fails loudly here instead of hitting an undefined method.
//
// The refusals these fixtures serve are the port's too. A hand-written
// `{ status: "unavailable" }` would be a refusal shape the console's own builder never
// produced, and a case asserting a surface renders it would be asserting against a
// value no port can return.

import {
  createRefusingGrowthPort,
  type GrowthPort,
} from "../../../../console/bridge/growth-port/growth-port.js";
import type { WorkflowDefinitionSummary } from "../../../../console/bridge/index.js";

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

/** One page of the enumeration, or the page on which the daemon refuses. */
export type WorkflowDefinitionPage =
  | { readonly definitions: readonly WorkflowDefinitionSeed[] }
  | { readonly refuses: true };

/** A wire-shaped definition, so a case never asserts against a partial one. */
export function workflowDefinition(seed: WorkflowDefinitionSeed): WorkflowDefinitionSummary {
  return {
    id: `definition-${seed.name}`,
    name: seed.name,
    scope: "session",
    scopeRef: WORKFLOW_TEST_SESSION_ID,
    latestVersionNumber: 1,
    latestWorkflowVersionId: seed.latestWorkflowVersionId ?? `version-${seed.name}`,
    contentHash: `hash-${seed.name}`,
    resolvesAtThisContext: seed.resolvesAtThisContext ?? true,
    createdAt: "2026-09-02T09:00:00.000Z",
  };
}

/** One request each of the two operations was called with, in call order. */
export interface WorkflowPortCalls {
  readonly listed: Parameters<GrowthPort["workflowDefinitionList"]>[0][];
  readonly started: Parameters<GrowthPort["workflowRunStart"]>[0][];
}

export interface WorkflowFixtureOptions {
  /** The whole enumeration on one page. The ordinary case. */
  readonly definitions?: readonly WorkflowDefinitionSeed[];
  /** The enumeration across several pages, for the cases about the cursor. */
  readonly pages?: readonly WorkflowDefinitionPage[];
  /** Every page carries a next cursor, so no walk of it ever exhausts. */
  readonly endless?: boolean;
  /** The daemon refuses the start itself, the `workflow.start_denied` arm. */
  readonly startRefuses?: boolean;
  /** Where each call's request is recorded, for the cases that assert on one. */
  readonly calls?: WorkflowPortCalls;
  /** Called on each list request, for the cases that need to act between pages. */
  readonly onList?: (request: Parameters<GrowthPort["workflowDefinitionList"]>[0]) => void;
}

/**
 * A port that serves the two workflow operations and refuses everything else.
 *
 * The pages are addressed by the cursor the previous page handed back, exactly as the
 * wire's are, so a walk that ignored `nextCursor` reads page one forever here rather
 * than quietly passing.
 */
export function fixtureGrowthPort(options: WorkflowFixtureOptions = {}): GrowthPort {
  const refusing = createRefusingGrowthPort();
  const pages: readonly WorkflowDefinitionPage[] = options.pages ?? [
    { definitions: options.definitions ?? [] },
  ];
  return {
    ...refusing,
    workflowDefinitionList: async (request) => {
      options.calls?.listed.push(request);
      options.onList?.(request);
      const pageIndex = pageIndexOf(request.cursor);
      // An endless enumeration answers every cursor by cycling its pages, which is
      // what a daemon handing back a cursor forever looks like from here.
      const page = options.endless === true ? pages[pageIndex % pages.length] : pages[pageIndex];
      if (page === undefined || "refuses" in page) {
        return await refusing.workflowDefinitionList(request);
      }
      const hasNextPage = options.endless === true || pageIndex + 1 < pages.length;
      return {
        status: "served",
        value: {
          definitions: page.definitions.map(workflowDefinition),
          ...(hasNextPage ? { nextCursor: `${PAGE_CURSOR_PREFIX}${String(pageIndex + 1)}` } : {}),
        },
      };
    },
    workflowRunStart: async (request) => {
      options.calls?.started.push(request);
      if (options.startRefuses === true) {
        return await refusing.workflowRunStart(request);
      }
      return {
        status: "served",
        value: {
          workflowRunId: `run-for-${request.workflowVersionId}`,
          state: "running",
          phaseStates: [],
        },
      };
    },
  };
}

/** A fresh recorder, so each case reads only its own calls. */
export function recordedWorkflowCalls(): WorkflowPortCalls {
  return { listed: [], started: [] };
}

/**
 * Which page a cursor names.
 *
 * An absent cursor is the first page; anything this fixture did not mint is a page
 * that does not exist, which the port answers for as a refusal rather than as an
 * empty list — the same distinction the console draws everywhere else.
 */
function pageIndexOf(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const index = Number.parseInt(cursor.slice(PAGE_CURSOR_PREFIX.length), 10);
  return Number.isNaN(index) ? Number.MAX_SAFE_INTEGER : index;
}
