// Reading a fixture's channel directory the way a surface reads it.
//
// ONE HOME FOR THE READ because two suites make it. `fixture-channel-directory.test.ts`
// asserts what the fold answers, and `fixture-session-membership.test.ts` asserts the
// number one of its rows carries — different subjects reached through the same call, and
// a second copy of that call is one edit away from two suites disagreeing about what
// `channel.list` was even asked.
//
// EVERY READ IS ADDRESSED AT THE SESSION BEING PLAYED, taken off the engine's own
// scenario rather than off a room constant a caller imports. A scenario plays one
// session, so a helper that named a room by hand would answer for that room and quietly
// answer nothing for the next one — and a fixture whose reads were scoped to somewhere
// else is exactly the defect these suites exist to catch.

import { callBridge, type FixtureUnderTest } from "./fixture-bridge.test-support.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";

/** Every row `channel.list` answers with for the session being played, right now. */
export async function directoryRowsOf(
  fixture: FixtureUnderTest,
): Promise<readonly Record<string, unknown>[]> {
  const reply = await callBridge(fixture.bridge, "channel.list", {
    sessionId: fixture.engine.scenario.sessionId,
  });
  return (reply as { readonly channels: readonly Record<string, unknown>[] }).channels;
}

/** One row of that directory, or `undefined` where the read carries none for it. */
export async function directoryRowOf(
  fixture: FixtureUnderTest,
  channelId: string,
): Promise<Record<string, unknown> | undefined> {
  return (await directoryRowsOf(fixture)).find((channel) => channel["id"] === channelId);
}

/** The state that directory reports for one channel, right now. */
export async function directoryStateOf(
  fixture: FixtureUnderTest,
  channelId: string,
): Promise<unknown> {
  return (await directoryRowOf(fixture, channelId))?.["state"];
}

/** How many members that directory reports for one channel, right now. */
export async function directoryMemberCountOf(
  fixture: FixtureUnderTest,
  channelId: string,
): Promise<unknown> {
  return (await directoryRowOf(fixture, channelId))?.["participantCount"];
}

/**
 * Create one channel in the session being played, and answer with the id it minted.
 *
 * The request travels as the caller wrote it rather than through a name parameter,
 * because the membership arm reads the KIND and the PAIR and a helper that took only a
 * name could reach one of the two arms.
 *
 * Throws rather than returning a settlement, because every caller is asserting something
 * about the row a SERVED create left behind: a room that refused the create has failed
 * the case's premise, and reporting that as a missing row would name the wrong defect.
 */
export async function createdChannelIdIn(
  fixture: FixtureUnderTest,
  request: Omit<GrowthOperationSignatures["channelCreate"]["request"], "sessionId"> = {},
): Promise<string> {
  const outcome = await fixture.bridge.growth.channelCreate({
    sessionId: fixture.engine.scenario.sessionId,
    ...request,
  });
  if (outcome.status !== "served") {
    throw new Error("this room scripts a create receipt, so the create should have been served");
  }
  return outcome.value.channelId;
}
