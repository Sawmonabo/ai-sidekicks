// What each attached machine declares about itself, read from the roster read that
// already happened.
//
// THE BLOCK OWNS TWO THINGS AND RENDERS NEITHER: the observation of the absorbed
// roster's own read, and the window trigger that asks that roster to read again when
// this window comes back to the front. The arms are `NodeDeclarationsBody`'s, on the
// family's shape — one component per module, and a block that owned both the reads and
// the branching would be two jobs in one file.
//
// THE RE-READ IS THE ROSTER'S OWN, RAISED FROM HERE. `runtime-node-attach/` belongs to
// the runtime-node surface and this console never edits it, so the refresh runs through
// the seam that view's own
// contract already gives: a presence push says WHEN to re-read, and the view re-reads
// through its own path without re-entering its loading arm. A window regaining focus is
// a legitimate raiser of that signal — the channel stayed open while the window was
// away, and what is unknown is whether every push over it arrived.
//
// THE SESSION STORE IS TAKEN FOR THE LEASE FRAME AND FOR NOTHING RENDERED HERE. The
// block beside this one renders `controlHolder` out of the same recorded read, and
// `pty.control_changed` is the one member of that reply the presence channel never
// announces — so the store this block wires is what keeps the terminal-control line
// current. It is raised from here rather than from there because one raiser per page is
// the rule that block already states, and the seam coalesces the reasons anyway.
//
// NOTHING HERE FIRES ON MOUNT, and `seats/node-roster/node-roster-seam.ts` states why: the mount
// arm is the absorbed view's own initial read, and forwarding it would put a second
// read on the wire for one mount.

import type { ReactNode } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { useNodeRosterObservation, useNodeRosterReReadTriggers } from "../../../seats/index.js";
import type { SessionStore } from "../../../store/index.js";
import { NodeDeclarationsBody } from "./NodeDeclarationsBody.js";

export function NodeDeclarationsBlock(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly sessionStore: SessionStore | undefined;
}): ReactNode {
  const observation = useNodeRosterObservation(props.bridge, props.sessionId);
  useNodeRosterReReadTriggers(props.bridge, props.sessionId, props.sessionStore);
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
