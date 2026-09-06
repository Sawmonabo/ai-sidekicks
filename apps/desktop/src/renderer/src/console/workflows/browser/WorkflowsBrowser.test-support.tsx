// What every browser suite needs before it can render the browser.
//
// The browser's cases split by concern — what one outcome becomes on screen, the handle
// to the next page, the session handed to the conversational start, and what the surface
// says out loud — and all four mount the same component under the same provider against
// the same real port. One home for that mounting, so a change to how the browser is
// stood up is one edit rather than four.
//
// BESIDE THE COMPONENT IT NAMES. This mount was authored one directory up, when the
// component was there too; it stayed behind when the component moved into `browser/`,
// which left a module named for `WorkflowsBrowser` sitting where no `WorkflowsBrowser`
// was and reaching past this directory's own door to find it. What the whole FAMILY
// needs is `../workflows-probe.test-support.ts` — the probe identities, the row factory,
// the settled-page port, and the `act` boundary — and every suite here takes both.
//
// THE ANNOUNCER IS PART OF THE MOUNT, not a convenience. The destination renders the
// browser within the window's live announcer and the browser speaks its own settlement,
// so a harness without one would be testing a mount the console does not make —
// `useAnnounce` throws outside its provider rather than falling silently back to a region
// invented at the moment something spoke.
//
// AND THE COMPONENT COMES FROM THE MODULE THAT DECLARES IT, not from `./index.ts` beside
// it. A directory's own door is for what a SIBLING directory takes; a module inside
// reading it would make the directory reach itself, which is the self-edge
// `seats/surface-registry.ts` was repaired for.

import { render } from "@testing-library/react";

import { type GrowthPort } from "../../bridge/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { PROBE_SESSION_ID } from "../workflows-probe.test-support.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";

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
