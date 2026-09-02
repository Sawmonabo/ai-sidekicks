// The sessions destination: what this window has open, and one way to start one.
//
// WHY THIS SURFACE EXISTS AT ALL. The `sessions` slot used to mount the shipped
// Tier-1 `SessionBootstrap` probe directly. That component calls `session.create`
// from its MOUNT EFFECT, which was correct while it was mounted once for the life
// of the renderer — and became a defect the moment a route lifecycle stood in
// front of it: every navigation to Settings and back remounts the slot, so
// visiting a page created a session. A session is a durable object with a cost;
// creating one is an act a person takes, never a side effect of looking at a list.
//
// So the slot mounts this surface, which never creates anything on mount, and the
// probe is built ONLY when the start control is pressed — its mount, and therefore
// its create, is the participant's act. The probe itself is untouched: the console
// absorbs the three shipped Tier-1 components by import and re-authors none of
// them, and `session.create` is the one implementation of creating a session.
//
// WHAT THE LIST CAN HONESTLY SHOW. No `SidekicksBridge` member lists the sessions
// on a node and `Plan-023 §Console growth slate` registers no row for one, so the
// only session set this renderer can name is the set this window has open —
// `SessionStoreRegistry`, the same source the auxiliary window's context picker
// reads. With none open the absence is `not-checked` rather than `empty`, and the
// distinction is the honest one: the console did not ask the daemon for the rest
// and must not report "there are none" for a question it never put.
//
// WHY THE START CONTROL TAKES A FACTORY RATHER THAN IMPORTING THE PROBE. The probe
// reads the installed bridge directly, so it is mountable only under a live one;
// that guard belongs beside the other two legacy mounts in `legacy-surfaces.ts`,
// which owns the table of which shipped family mounts where. Handing the built
// node in keeps one copy of that guard and keeps this file a view.

import { useState, type ReactNode } from "react";

import { Nothing } from "../primitives/index.js";
import { useOpenSessionIds, type FrameStore, type SessionStoreRegistry } from "../store/index.js";
import { OpenSessionList } from "./OpenSessionList.js";

/** How the list names itself, for the heading and for assistive technology. */
const SESSIONS_HEADING = "Sessions open in this window";

export interface SessionsSurfaceProps {
  readonly frameStore: FrameStore;
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /**
   * Builds what a start request renders. Called on the ACT and never on mount, so
   * a build that creates a session creates exactly one per press.
   */
  readonly startSession: () => ReactNode;
}

export function SessionsSurface(props: SessionsSurfaceProps): React.JSX.Element {
  const openSessionIds = useOpenSessionIds(props.sessionStoreRegistry);
  // Counts presses rather than recording a boolean, so the built node can be keyed
  // on it: a second press remounts and therefore starts a second session, where a
  // boolean would leave the first mount in place and make the control silently
  // inert after its first use.
  const [startRequestCount, setStartRequestCount] = useState(0);

  const startControl = (
    <button
      type="button"
      className="meridian-sessions__start"
      onClick={() => {
        setStartRequestCount((previous) => previous + 1);
      }}
    >
      Start a session
    </button>
  );

  return (
    <section className="meridian-sessions" aria-labelledby="meridian-sessions-heading">
      <h1 className="meridian-sessions__heading" id="meridian-sessions-heading">
        {SESSIONS_HEADING}
      </h1>
      {openSessionIds.length === 0 ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No session is open in this window."
          detail="The console shows the sessions this window has opened; it has not asked the daemon for the rest, because no session-directory read is registered yet."
          action={startControl}
        />
      ) : (
        <>
          <OpenSessionList
            sessionIds={openSessionIds}
            onSelect={(sessionId) => {
              props.frameStore.navigate({ kind: "workspace", sessionId });
            }}
            label={SESSIONS_HEADING}
          />
          {startControl}
        </>
      )}
      {startRequestCount === 0 ? null : (
        <div className="meridian-sessions__started" key={startRequestCount}>
          {props.startSession()}
        </div>
      )}
    </section>
  );
}
