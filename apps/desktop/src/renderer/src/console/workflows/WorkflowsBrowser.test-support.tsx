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
// What is deliberately NOT here is anything one suite reads: the scope-group queries,
// the two-page port, the recording announcer, and the start slot's spy each have one
// reader and stay beside it.

import { act, render } from "@testing-library/react";

import { type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import type { WorkflowDefinitionRow } from "./definitions/DefinitionsBrowser.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";

export const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** The continuation token the paged cases hand back. */
export const SECOND_PAGE_CURSOR = "definitions-page-2";

/** One definition, as the enumeration carries it. */
export const SERVED_DEFINITION: WorkflowDefinitionRow = {
  id: "release-checklist",
  name: "Release checklist",
  scope: "session",
  scopeRef: PROBE_SESSION_ID,
  latestVersionNumber: 3,
  latestWorkflowVersionId: "release-checklist-version-3",
  contentHash: "b3:0f1e2d",
  resolvesAtThisContext: true,
  createdAt: "2026-01-01T10:00:00.000Z",
};

/** One settled page, derived from the port's own answer rather than restated. */
export type SettledDefinitionPage = Awaited<ReturnType<GrowthPort["workflowDefinitionList"]>>;

/** The real port answering the enumeration one way, and nothing else changed. */
export function portAnswering(page: SettledDefinitionPage): GrowthPort {
  return { ...createRefusingGrowthPort(), workflowDefinitionList: async () => page };
}

/** The browser under the announcer its one caller mounts it inside. */
export function browserUnderAnnouncer(
  growth: GrowthPort,
  sessionId: string | undefined,
): React.JSX.Element {
  return (
    <LiveAnnouncerProvider>
      <WorkflowsBrowser growth={growth} sessionId={sessionId} />
    </LiveAnnouncerProvider>
  );
}

export function renderBrowser(growth: GrowthPort): HTMLElement {
  return render(browserUnderAnnouncer(growth, PROBE_SESSION_ID)).container;
}

export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
