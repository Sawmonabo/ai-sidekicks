// What every browser suite needs before it can render the browser.
//
// The browser's cases split by concern — what one outcome becomes on screen, the
// handle to the next page, the session handed to the conversational start, and what
// the surface says out loud — and all four mount the same component under the same
// provider against the same real port. One home for that mounting, and for the two
// definitions the pages are built out of, so a change to how the browser is stood up
// is one edit rather than four.
//
// THE ANNOUNCER IS PART OF THE MOUNT, not a convenience. The destination renders the
// browser within the window's live announcer and the browser speaks its own
// settlement, so a harness without one would be testing a mount the console does not
// make — `useAnnounce` throws outside its provider rather than falling silently back
// to a region invented at the moment something spoke.
//
// THE ROW FACTORY IS THE FAMILY'S, not this file's, and it is a FACTORY rather than a
// frozen const on purpose. Five suites across two directories were each stating the
// nine members of `WorkflowDefinitionRow` in their own words, so adding a required
// member to the wire type would have broken some of them and silently left the rest
// asserting against a differently-shaped row for the same type. One factory with
// overrides is the shape that cannot do that: a new required member is one edit here,
// and every caller keeps compiling because it only ever names what it asserts on.
//
// What is deliberately NOT here is anything one suite reads: the scope-group queries,
// the two-page port, the recording announcer, and the start slot's spy each have one
// reader and stay beside it.
//
// THE PROBE IDENTITIES AND THE SETTLE ARE THE FAMILY'S AND NOT THE BROWSER'S. Suites in
// every one of this family's directories address the same session and the same
// participant, and every one of them has to let a read settle before it asserts — and
// each had typed the literal or the helper out for itself. One value in many places is
// many chances to edit one of them, and a suite addressed at a session its neighbours
// are not still passes: every assertion it makes is about the value it sent. So they
// live here, where the row factory that carries the session in `scopeRef` already does.
// The bridge family's `scripted-probe.test-support.ts` keeps a session and a participant
// of its own and says why: those are the identities a BRIDGE probe scripts, and a module
// below this one in the console's order may not reach up here for them.
//
// `settle` IS ONE `act` BOUNDARY, and the microtask awaited inside it is not the part
// that settles anything: React's async `act` drains its own queue and the effects that
// queue schedules on the way out. That is why the copies this module replaced disagreed
// about how many already-resolved promises to await and every one of them passed. One
// boundary, named once, so a suite waiting on a read is not also asserting a count of
// turns nobody chose.

import { act, render } from "@testing-library/react";

import { createRefusingGrowthPort, type GrowthPort } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import type { WorkflowDefinitionRow } from "./definitions/definition-rows.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";

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

/** The browser under the announcer its one caller mounts it inside. */
export function browserUnderAnnouncer(growth: GrowthPort, sessionId: string): React.JSX.Element {
  return (
    <LiveAnnouncerProvider>
      <WorkflowsBrowser growth={growth} sessionId={sessionId} />
    </LiveAnnouncerProvider>
  );
}

export function renderBrowser(growth: GrowthPort): HTMLElement {
  return render(browserUnderAnnouncer(growth, PROBE_SESSION_ID)).container;
}

/** Let every read a surface put reach its own settlement, so an assertion is about answers. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
