// The readings a scenario schedules against its own tick, other than its beats.
//
// A FRAME IS A READ THAT MOVES. `scenario.ts`'s reply table answers one call with one
// fixed value, which is right for a fact nothing in the script changes and wrong for
// every reading here: a roster gains and loses machines, a person starts and stops
// typing, a supervisor steps through a reconnect, a wire goes away and comes back. Each
// of those is scripted as `{atMs, <reading>}` — the same shape a beat has, on the same
// frozen clock — so a fixture resolves it by asking which frame has fallen due rather
// than by answering the same value forever.
//
// ITS OWN MODULE FOR `scenario-pending-invites.ts`'S REASON. `scenario.ts` is what a
// reader opens to learn what a scenario IS, and four independently-reasoned frame
// families in front of that shape bury it. What stays there is the composition and the
// reply table; what leaves is each family's own declaration, which is read by the one
// fixture namespace that resolves it and by nothing else.

import type { ParticipantId, RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

import type { GrowthActivitySnapshot } from "../growth-values/index.js";
import type { ShellReport } from "../../store/index.js";

/**
 * One reading of a session's runtime-node roster, and the tick it becomes current.
 *
 * A frame rather than a single roster, and rather than a scripted reply, because a
 * roster CHANGES: the registered `runtimenode.roster` read is the source of truth
 * for the rendered set and a `runtime_node.*` beat only says WHEN to re-read, so a
 * fixture whose roster could not move would answer every re-read with the same rows
 * and make the whole snapshot-plus-signal discipline untestable. Mirrors
 * `ScenarioBeat` deliberately — same `atMs` measured from scenario start, same
 * "data, never code" posture — so a reader who has understood one has understood
 * the other.
 *
 * `nodes` is the registered `RuntimeNodeRosterEntry` set verbatim, so a scenario
 * carries BOTH health axes the wire carries — the slot axis `state` and the
 * sweep-owned `healthState` / `lastHeartbeatAt` pair — and no collapsed scalar,
 * which the wire does not have either. Reconciling them is the client's render-time
 * concern and a fixture that pre-reconciled them would answer a question the
 * surface exists to ask.
 */
export interface ScenarioRuntimeNodeRosterFrame {
  readonly atMs: number;
  readonly nodes: readonly RuntimeNodeRosterEntry[];
  /**
   * Who holds the session's shared-terminal write lease at this tick.
   *
   * REQUIRED, and required for the same reason `nodes` is: a frame is a whole
   * registered response, and the registered response carries this member on
   * every reply. Optional here, an unstated holder would read as a free lease —
   * a reading the scenario never made — and the deck would grow frames whose
   * holder nobody decided.
   *
   * `null` is a reading rather than a gap, and it deliberately carries two of
   * them at once: the lease is free, or a held lease is read-suppressed because
   * its producing node is server-classified offline. A client cannot tell those
   * apart and neither can a scenario, which is the fail-closed shape the wire
   * has.
   */
  readonly controlHolder: ParticipantId | null;
}

/**
 * One reading of the session's live activity, and the tick it becomes current.
 *
 * A frame rather than a scripted reply, for {@link ScenarioRuntimeNodeRosterFrame}'s
 * reason applied to a faster-moving fact: composing STARTS and STOPS inside one
 * scenario, and a reply table keyed by call name answers every read with one fixed
 * value. A frame table is what lets a scenario show a person begin to type, a second
 * person join them, and the first one stop — which is the only way the indicator's
 * folding rule and its empty state are both reachable from one script.
 *
 * The two Awareness fields are carried TOGETHER because one read answers both, and
 * because a scenario that could move them independently would invite an author to
 * script an agent indicator that outlives the run it belongs to.
 */
export interface ScenarioActivityFrame {
  readonly atMs: number;
  readonly activity: GrowthActivitySnapshot;
}

/**
 * One reading of the shell's own condition, and the tick it becomes current.
 *
 * {@link ScenarioRuntimeNodeRosterFrame}'s shape applied to the other thing a
 * scenario has to be able to MOVE: the supervisor's step, its attempt count, the
 * handshake ack, and the two honesty notices all change over a session's life, and a
 * fixture whose shell condition could not move would let the console ship a
 * reconnect banner nobody had ever seen render.
 *
 * `report` is `ShellReport` verbatim — the console's own vocabulary, declared once in
 * `store/shell-state.ts` and narrowed by nobody twice. A scenario that names no
 * frames has not been asked, and the growth port refuses rather than serving a
 * synthesised "connected", which is the one answer a fixture must never invent.
 */
export interface ScenarioShellStatusFrame {
  readonly atMs: number;
  readonly report: ShellReport;
}

/**
 * One scripted transport outage: when the wire went away, and when it returned.
 *
 * Both instants are measured from scenario start, as a beat's `atMs` is. They are
 * required together because an outage with no end is not a reconnect and would be
 * scripted by simply never restoring — a member carrying one without the other is
 * the shape that reads as an outage and produces no edge.
 */
export interface ScenarioTransportOutage {
  readonly lostAtMs: number;
  readonly restoredAtMs: number;
}
