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
// WHAT THE LIST CAN HONESTLY SHOW. Two sets, and the surface offers their union.
// The node's sessions come from the growth port's directory read — a wire the
// corpus has not registered, so it is served by the fixture and refused by the live
// bridge — and this window's own open sessions come from `SessionStoreRegistry`,
// the same source the auxiliary window's context picker reads. Neither subsumes the
// other: the directory may not yet name a session this window just created, and the
// open set names nothing this window has not opened.
//
// The absence follows the directory rather than the count, and which of the three
// kinds of nothing it is is `SessionsAbsence.tsx`'s one decision — split out
// because it is the surface's real content whenever there is nothing to list, and
// this file's job is the list, the heading, and the start control.
//
// WHY THE START CONTROL TAKES A FACTORY RATHER THAN IMPORTING THE PROBE. The probe
// reads the installed bridge directly, so it is mountable only under a live one;
// that guard belongs beside the other two legacy mounts in `legacy-surfaces.ts`,
// which owns the table of which shipped family mounts where. Handing the built
// node in keeps one copy of that guard and keeps this file a view.

import { useState, type ReactNode } from "react";

import { offeredSessionIds, useSessionDirectory, type GrowthPort } from "../bridge/index.js";
import { WireChoiceList } from "../primitives/index.js";
import { useOpenSessionIds, type FrameStore, type SessionStoreRegistry } from "../store/index.js";
import { SessionsAbsence } from "./SessionsAbsence.js";

/**
 * How the list names itself, for the heading and for assistive technology.
 *
 * Two headings because there are two questions, and a heading that named the wrong
 * one would be the only part of the surface still claiming the console had asked
 * the node. A window listing its own open sessions says so.
 */
const NODE_SESSIONS_HEADING = "Sessions on this node";
const WINDOW_SESSIONS_HEADING = "Sessions open in this window";

export interface SessionsSurfaceProps {
  readonly frameStore: FrameStore;
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /** The seam the node's session directory is read through. */
  readonly growth: GrowthPort;
  /**
   * Builds what a start request renders. Called on the ACT and never on mount, so
   * a build that creates a session creates exactly one per press.
   */
  readonly startSession: () => ReactNode;
}

export function SessionsSurface(props: SessionsSurfaceProps): React.JSX.Element {
  const openSessionIds = useOpenSessionIds(props.sessionStoreRegistry);
  const directory = useSessionDirectory(props.growth);
  const sessionIds = offeredSessionIds(directory, openSessionIds);
  // Counts presses rather than recording a boolean, so the built node can be keyed
  // on it: a second press remounts and therefore starts a second session, where a
  // boolean would leave the first mount in place and make the control silently
  // inert after its first use.
  const [startRequestCount, setStartRequestCount] = useState(0);

  const heading = directory.status === "served" ? NODE_SESSIONS_HEADING : WINDOW_SESSIONS_HEADING;
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
        {heading}
      </h1>
      {sessionIds.length === 0 ? (
        <SessionsAbsence directory={directory} action={startControl} />
      ) : (
        <>
          <WireChoiceList
            values={sessionIds}
            onSelect={(sessionId) => {
              props.frameStore.navigate({ kind: "workspace", sessionId });
            }}
            label={heading}
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
