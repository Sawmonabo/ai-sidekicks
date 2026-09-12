// What a RESOLVED call passes through on its way out of the fixture, per call.
//
// A SCRIPTED REPLY IS AN OPENING STATE, NOT A STANDING ANSWER — for a handful of calls
// and for no others. Most of what a scenario scripts is a fact about the session that
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
// which calls fold and nothing about any one of them; the fold for a call belongs to
// the fixture module that owns that plane, which is where the rest of that plane's
// reasoning already is. The table is keyed by the call the caller made, so a scenario
// that scripts no reply for it is untouched — an unscripted call refuses by name one
// layer up, and a fold over a refusal would answer a caller the fixture has just told
// it cannot serve.
//
// AND IT IS A TABLE RATHER THAN A BRANCH IN THE CALL DOOR. The door turns a settlement
// into what a bridge method may do and knows about no plane in particular; a channel
// clause inside it would be the first of a list that grows one plane at a time in the
// one module that is supposed to be generic over all of them.

import { foldChannelDirectoryOverLog } from "../session/channel-directory.js";
import type { ScenarioEngine } from "../../scenario/runtime/index.js";

/** The registered method whose answer is the session's channel directory. */
const CHANNEL_LIST_METHOD = "channel.list";

/** Which calls this bridge folds, and the fold each one takes. */
export type SettledCallFolds = Readonly<Record<string, SettledCallFold>>;

/**
 * Which calls fold, and the fold each one takes.
 *
 * A MODULE CONSTANT RATHER THAN A PER-BRIDGE BUILD, because every fold here is a pure
 * function of the engine and the settled value: the engine carries the log and the
 * clock, and a fold holds nothing between calls. A builder closing over fixture state
 * would be a second place a plane's facts live, and the honest home for a fact the log
 * cannot carry is a named constant in the plane's own module.
 */
export const SETTLED_CALL_FOLDS: SettledCallFolds = Object.freeze({
  [CHANNEL_LIST_METHOD]: (engine: ScenarioEngine, _request: unknown, settled: unknown) =>
    foldChannelDirectoryOverLog(engine, settled),
});

/**
 * Fold one resolved reply, or hand it back untouched.
 *
 * Untouched is the answer for every call not in the table, which is nearly all of them
 * — and it is a real answer rather than a fallback: a call the fixture holds no plane
 * state for is a call whose scripted value IS what it answers.
 */
export function foldSettledCall(
  folds: SettledCallFolds,
  engine: ScenarioEngine,
  call: string,
  request: unknown,
  settled: unknown,
): unknown {
  const fold = Object.hasOwn(folds, call) ? folds[call] : undefined;
  return fold === undefined ? settled : fold(engine, request, settled);
}

/**
 * One call's fold: what the caller receives, given what the scenario settled.
 *
 * THE REQUEST TRAVELS WITH IT, because a receipt does not carry everything the act
 * asked for and a fold built from receipts alone could not say what a mutation
 * granted. A fold that does not need it ignores it, which is cheaper than two tables.
 */
type SettledCallFold = (engine: ScenarioEngine, request: unknown, settled: unknown) => unknown;
