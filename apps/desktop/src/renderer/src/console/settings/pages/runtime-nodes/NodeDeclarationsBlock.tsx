// What each attached machine declares about itself, read from the roster read that
// already happened.
//
// THE BLOCK OWNS TWO THINGS AND RENDERS NEITHER: the observation of the absorbed
// roster's own read, and the window trigger that asks that roster to read again when
// this window comes back to the front. The arms are `NodeDeclarationsBody`'s, on the
// family's shape — one component per module, and a block that owned both the reads and
// the branching would be two jobs in one file.
//
// THE RE-READ IS THE ROSTER'S OWN, RAISED FROM HERE. `runtime-node-attach/` is Plan-003's
// and this console never edits it, so the refresh runs through the seam that view's own
// contract already gives: a presence push says WHEN to re-read, and the view re-reads
// through its own path without re-entering its loading arm. A window regaining focus is
// a legitimate raiser of that signal — the channel stayed open while the window was
// away, and what is unknown is whether every push over it arrived.
//
// NOTHING HERE FIRES ON MOUNT, and `seats/node-roster-seam.ts` states why: the mount
// arm is the absorbed view's own initial read, and forwarding it would put a second
// read on the wire for one mount.

import type { ReactNode } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { useNodeRosterFocusReRead, useNodeRosterObservation } from "../../../seats/index.js";
import { NodeDeclarationsBody } from "./NodeDeclarationsBody.js";

export function NodeDeclarationsBlock(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}): ReactNode {
  const observation = useNodeRosterObservation(props.bridge, props.sessionId);
  useNodeRosterFocusReRead(props.bridge, props.sessionId);
  return (
    <section
      className="meridian-settings-page__block meridian-node-declarations"
      aria-label="What each node declares"
    >
      <h3 className="meridian-settings-page__block-title">What each node declares</h3>
      <p className="meridian-settings-page__aside">
        A node declares its own capability set when it attaches, and the daemon schedules against
        that declaration and nothing else. This is the same roster read the list above performed —
        not a second one — so what a node says it can do and how it is doing are always one answer.
      </p>
      <NodeDeclarationsBody observation={observation} />
    </section>
  );
}
