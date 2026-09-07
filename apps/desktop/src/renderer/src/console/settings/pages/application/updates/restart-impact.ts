// What a restart costs, read off the one session this window has open.
//
// A restart quits the shell and relaunches it, so every run on this node stops
// mid-turn. The console cannot enumerate that set: it holds the sessions THIS window
// has open and nothing about the rest of the node, and the daemon publishes no
// node-wide run census the settings surface may read. So this module answers the
// narrower question it can answer honestly — which runs in the retained session are
// still moving — and the sentence built from it names the part it cannot see rather
// than letting a small number stand in for a larger one.
//
// THE PREDICATE IS THE BRIDGE'S. `isLiveRunState` reads the wire's own nine-state
// vocabulary and lives beside the reader that produces it, so this module states no
// second opinion about which states are terminal. The state on a stored entity is a
// wire-verbatim `string`, which is why it goes back through `readRunState` first: a
// word this build has never heard is neither counted live nor asserted finished.

import { INTERRUPTED_RUN_IDS_NAMED_CAP } from "../../../../core/index.js";
import { isLiveRunState, readRunState } from "../../../../bridge/index.js";
import type { ConsoleEntity } from "../../../../store/index.js";
import { byNewestTouchedEntity } from "../../../shared/run-recency.js";

/**
 * The moving runs of one session, as a confirmation sentence needs them.
 *
 * The count and the enumeration are separate members because they answer different
 * halves of the question: the count says how much work a restart ends, and the ids
 * say which rows on the surface behind the dialog those are. `unnamedCount` is what
 * the enumeration left out, carried rather than derived at the render site so the
 * sentence cannot quietly disagree with the list beside it.
 */
export interface LiveRunTally {
  readonly liveRunCount: number;
  readonly namedRunIds: readonly string[];
  readonly unnamedRunCount: number;
}

/**
 * Tally the runs of one session's `run` partition that are still moving.
 *
 * Newest-touched first, so the ids that survive the cap are the ones a person was
 * most recently looking at. A run the store holds with no `touchedAt` sorts last
 * rather than first: an absent timestamp is not evidence of recency, and putting it
 * at the head would name the coldest rows in a sentence about live work.
 */
export function tallyLiveRuns(runs: Readonly<Record<string, ConsoleEntity>>): LiveRunTally {
  const live = Object.values(runs).filter((run) => {
    const state = run.state === undefined ? undefined : readRunState(run.state);
    return state !== undefined && isLiveRunState(state);
  });
  const ordered = [...live].sort(byNewestTouchedEntity);
  const namedRunIds = ordered.slice(0, INTERRUPTED_RUN_IDS_NAMED_CAP).map((run) => run.id);
  return {
    liveRunCount: live.length,
    namedRunIds,
    unnamedRunCount: live.length - namedRunIds.length,
  };
}
