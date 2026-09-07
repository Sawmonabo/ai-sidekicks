// What every suite in this family needs before it can assert anything.
//
// THE NAME IS THE FAMILY'S BECAUSE THE CONTENTS ARE. This module was authored as
// `WorkflowsBrowser.test-support.tsx` beside the component it was named for, when the
// browser's four suites were its only readers. By the time the component moved down
// into `browser/` they were four importers of twenty-six — the other twenty-two spread
// across `definitions/`, `destination/`, `pane/run/`, `runs/` and the zone above them —
// so the name claimed the browser's scaffolding for a module whose readers were mostly
// not browser suites, and claimed it from a directory the browser had left. The mount
// half went with the component and is `browser/WorkflowsBrowser.test-support.tsx`, a
// correct name in its new home; what stayed is what any suite in this family needs.
//
// THE PROBE IDENTITIES AND THE SETTLE ARE THE FAMILY'S. Suites in every one of this
// family's directories address the same session and the same participant, and every one
// of them has to let a read settle before it asserts — and each had typed the literal or
// the helper out for itself. One value in many places is many chances to edit one of
// them, and a suite addressed at a session its neighbours are not still passes: every
// assertion it makes is about the value it sent. The bridge family's
// `scripted-probe.test-support.ts` keeps a session and a participant of its own and says
// why: those are the identities a BRIDGE probe scripts, and a module below this one in
// the console's order may not reach up here for them.
//
// THE ROW FACTORY IS A FACTORY RATHER THAN A FROZEN CONST on purpose. Suites across two
// directories were each stating the nine members of `WorkflowDefinitionRow` in their own
// words, so adding a required member to the wire type would have broken some of them and
// silently left the rest asserting against a differently-shaped row for the same type.
// One factory with overrides is the shape that cannot do that: a new required member is
// one edit here, and every caller keeps compiling because it only ever names what it
// asserts on.
//
// `settle` IS ONE `act` BOUNDARY, and what it awaits inside is a MACROTASK boundary
// rather than a count of microtasks: React's async `act` drains its own queue and the
// effects that queue schedules on the way out, and `crossMacrotaskBoundary` lets every
// chain those effects started run to its own end whatever its depth. That is why the
// copies this module replaced disagreed about how many already-resolved promises to
// await and every one of them passed — a number tuned against one promise chain stops
// waiting the day the chain grows a link. One boundary, named once, so a suite waiting
// on a read is not also asserting a count of turns nobody chose.
//
// What is deliberately NOT here is anything one suite reads: the scope-group queries,
// the two-page port, the recording announcer, and the start slot's spy each have one
// reader and stay beside it.

import { act } from "@testing-library/react";

import { type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import type { WorkflowDefinitionRow } from "./definitions/definition-rows.js";

/** The session every workflows suite addresses. One id, so every suite probes one. */
export const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** The other session, for a case whose whole claim is that the scope moved off the first. */
export const SECOND_PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3402";

/** The one participant the family's scripted scenarios join a session with. */
export const PROBE_PARTICIPANT_ID = "019b7a12-0280-79a4-8110-cca0117a0401";

/** The continuation token the paged cases hand back. */
export const SECOND_PAGE_CURSOR = "definitions-page-2";

/** One definition, as the enumeration carries it. Override only what a case asserts on. */
export function definition(overrides: Partial<WorkflowDefinitionRow> = {}): WorkflowDefinitionRow {
  return {
    id: "release-checklist",
    name: "Release checklist",
    scope: "session",
    scopeRef: PROBE_SESSION_ID,
    latestVersionNumber: 3,
    latestWorkflowVersionId: "release-checklist-version-3",
    contentHash: "b3:0f1e2d",
    resolvesAtThisContext: false,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

/** One settled page, derived from the port's own answer rather than restated. */
export type SettledDefinitionPage = Awaited<ReturnType<GrowthPort["workflowDefinitionList"]>>;

/** The real port answering the enumeration one way, and nothing else changed. */
export function portAnswering(page: SettledDefinitionPage): GrowthPort {
  return { ...createRefusingGrowthPort(), workflowDefinitionList: async () => page };
}

/** Let every read a surface put reach its own settlement, so an assertion is about answers. */
export async function settle(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}
