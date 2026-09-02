// The rail's workflows destination: the surface, and the session it reads from.
//
// WHY THIS EXISTS AT ALL. `#/workflows` is a bare route, so the surface context's
// `sessionStore` is `undefined` on it by construction — and the definition
// enumeration's request carries a REQUIRED session id. The destination therefore
// used to mount the browser with no session, the read stayed `unasked` forever, and
// the advertised rail destination rendered three empty named groups in every build
// including the fixture that scripts definitions. A surface that can never ask its
// own question is not an empty state; it is a surface with no subject.
//
// WHERE THE SUBJECT COMES FROM, IN ORDER.
//
//   1. **A session this person chose here**, held for the mount.
//   2. **The session this window last opened**, which is `FrameStore`'s
//      `lastOpenedSessionId` — a fact about where this WINDOW has been that no other
//      module records, written by every route transition that names a session and
//      read by the rail's own Workspace entry. A person who opens a session and then
//      presses the workflows destination has that session in hand, and this is the
//      module that knows it.
//   3. **Neither**, which is a question rather than an absence: `WorkflowsScopePicker`
//      offers the node's sessions and this window's open ones, and owns the three
//      different kinds of nothing that read can settle into.
//
// WHY THE CHOICE IS NOT PERSISTED. `persistence/value-classes.ts` would admit it —
// the `selection` class takes a record of identifier-shaped strings and a session id
// is one — and it is still held for the mount, on `FrameStore`'s own recorded
// reasoning about the neighbouring fact: after a reload nothing is open, the registry
// is fresh, and a restored id would scope this surface to a session this window is not
// in and which may since have been deleted, archived, or moved to another node. The
// console would be promising something only the daemon can honour. A person who
// re-opens the console picks again, from a list the node answered a moment ago.
//
// WHAT IS ANNOUNCED, AND EXACTLY ONCE. The scope settlement — that this surface now
// reads from a named session — is the one thing a person navigating by ear cannot
// otherwise learn, because the browser under it renders the same chrome whichever
// session it is reading. It is announced when the scope first settles and when it
// settles on a DIFFERENT session, and on no re-render: a repeat would talk over the
// surface it just described.

import { useEffect, useRef, useState } from "react";

import "./workflows-destination.css";

import type { GrowthPort } from "../bridge/index.js";
import { WireFigure, useAnnounce } from "../primitives/index.js";
import { useFrameStore, type FrameStore, type SessionStoreRegistry } from "../store/index.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";
import { WorkflowsScopePicker } from "./WorkflowsScopePicker.js";

export interface WorkflowsDestinationProps {
  readonly growth: GrowthPort;
  /**
   * The window store, read for the one member this surface needs: the session this
   * window most recently had in hand.
   *
   * The STORE rather than the value, so the subscription is this surface's own and
   * goes through the family's one selector seam. A resolved id passed down by the
   * frame would be read at the moment the surface context was built, and a person
   * who opens a session and then presses this destination would arrive at a scope
   * resolved before the session was opened.
   */
  readonly frameStore: FrameStore;
  /** This window's open sessions, for the picker's half of what it can offer. */
  readonly sessionStoreRegistry: SessionStoreRegistry;
}

/** The workflows destination, scoped to the session it reads from. */
export function WorkflowsDestination(props: WorkflowsDestinationProps): React.JSX.Element {
  // Held for the mount and not written anywhere durable — the header says why. A
  // choice overrides the retained session rather than merging with it: a person who
  // has just picked a session is looking at that one, and falling back to the
  // retained id after a choice would undo the act on the next render.
  const [chosenSessionId, setChosenSessionId] = useState<string | undefined>(undefined);
  const retainedSessionId = useFrameStore(props.frameStore, (state) => state.lastOpenedSessionId);
  const sessionId = chosenSessionId ?? retainedSessionId;
  useScopeSettlementAnnouncement(sessionId);

  if (sessionId === undefined) {
    return (
      <div className="meridian-workflows-destination">
        <WorkflowsScopePicker
          growth={props.growth}
          registry={props.sessionStoreRegistry}
          onChoose={setChosenSessionId}
        />
      </div>
    );
  }

  return (
    <div className="meridian-workflows-destination">
      <p className="meridian-workflows-destination__scope">
        Definitions visible from session <WireFigure value={sessionId} />
        <button
          type="button"
          className="meridian-workflows-destination__rescope"
          onClick={() => {
            // Back to the question rather than to the retained session: clearing the
            // choice while a retained id stood would put the surface straight back on
            // the session the person just asked to leave.
            setChosenSessionId(undefined);
          }}
        >
          Choose a different session
        </button>
      </p>
      <WorkflowsBrowser growth={props.growth} sessionId={sessionId} />
    </div>
  );
}

/**
 * Say, once, which session this surface settled on.
 *
 * The announced id is held in a ref rather than a piece of state: it is a record of
 * what has been SAID, read only to decide whether to say it again, and holding it in
 * state would re-render the surface every time it spoke. The ref is compared rather
 * than a boolean flag, so a move to a different session is a second, real settlement
 * and a re-render of the same one is silent.
 *
 * Polite, never assertive. `frame/banner-announcements.ts` reserves the assertive
 * lane for a refusal that changed what the whole room can do; this is a surface
 * describing its own subject, and interrupting a reader for it would spend the one
 * loud channel on the quietest fact the console has.
 */
function useScopeSettlementAnnouncement(sessionId: string | undefined): void {
  const announce = useAnnounce();
  const announcedSessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (sessionId === undefined || announcedSessionIdRef.current === sessionId) {
      return;
    }
    announcedSessionIdRef.current = sessionId;
    announce(`Workflows scoped to session ${sessionId}.`, "polite");
  }, [sessionId, announce]);
}
