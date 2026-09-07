// The reads whose answer the daemon derives from the session log, and what a scripted
// reply for one of them means.
//
// A SCRIPTED REPLY IS AN OPENING STATE, NOT A STANDING ANSWER — for this class of call
// and for no other. Most of what a scenario scripts is a fact about the session that
// nothing in the script moves: the node's own identity, what a channel is FOR, the
// devices behind one person's presence. Those are answered with the scripted value and
// answered the same way every time, which is right.
//
// A handful are not. `channel.list` is a projection the daemon rebuilds from
// `channel.*` rows, so what it answers at a tick is a function of which rows have
// landed by then — and a fixture that served one fixed value for it made two claims at
// once that are both false: at tick zero it answered with state the script does not
// reach until later, and after the beat that moves the row it answered with the state
// from before. Both readings look like a working directory, which is why neither was
// caught by anything: the row was simply always in the state its author had in mind at
// the end.
//
// SO THE CLASS IS NAMED HERE AND THE FOLDS LIVE WITH THEIR SUBJECT. This module holds
// which calls are log-projected and nothing about any one of them; the fold for a call
// belongs to the fixture module that owns that plane, which is where the rest of that
// plane's reasoning already is. The table is keyed by the call the caller made, so a
// scenario that scripts no reply for it is untouched — an unscripted call refuses by
// name one layer up, and a projection over a refusal would answer a caller the fixture
// has just told it cannot serve.
//
// AND IT IS A TABLE RATHER THAN A BRANCH IN THE CALL DOOR. The door turns a settlement
// into what a bridge method may do and knows about no plane in particular; a channel
// clause inside it would be the first of a list that grows one plane at a time in the
// one module that is supposed to be generic over all of them.

import { foldChannelDirectoryOverLog } from "./fixture-channel-lifecycle.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";

/** The registered method whose answer is the session's channel directory. */
const CHANNEL_LIST_METHOD = "channel.list";

/** One call's fold: the reply the scenario scripts, moved by what has been delivered. */
type LogProjectedRead = (engine: ScenarioEngine, scripted: unknown) => unknown;

const LOG_PROJECTED_READS: Readonly<Record<string, LogProjectedRead>> = Object.freeze({
  [CHANNEL_LIST_METHOD]: foldChannelDirectoryOverLog,
});

/**
 * Project one resolved reply over the log, or hand it back untouched.
 *
 * Untouched is the answer for every call not in the table, which is nearly all of them
 * — and it is a real answer rather than a fallback: a read the daemon does not derive
 * from the log is a read whose scripted value IS what it answers.
 */
export function projectScriptedReplyOverLog(
  engine: ScenarioEngine,
  call: string,
  scripted: unknown,
): unknown {
  const project = Object.hasOwn(LOG_PROJECTED_READS, call) ? LOG_PROJECTED_READS[call] : undefined;
  return project === undefined ? scripted : project(engine, scripted);
}
