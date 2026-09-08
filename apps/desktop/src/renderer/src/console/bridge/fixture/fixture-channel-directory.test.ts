// What `channel.list` answers once frames have landed, and where each row's numbers
// come from.
//
// THE READ SIDE OF THE LIFECYCLE, in its own file for the reason the module it drives
// is: `fixture-channel-lifecycle.ts` is what a press DOES and `fixture-channel-directory.ts`
// is what every reader of that session then sees. The acts' own cases are next door.
//
// WHY A FOLD IS UNDER TEST AT ALL. `channel.list` was answered with the scenario's
// scripted reply verbatim for the whole playback, so a scenario whose script archives a
// channel at a tick reported it archived at tick ZERO, and a served act that moved a row
// was answered with the row's old state. Both look like a working directory.
//
// AND WHERE `participantCount` COMES FROM IS THE SECOND CLAIM. A created row has to
// carry one — the member is required — and the log cannot supply it, since
// `channel.created` is registered as exactly `{channelId, name?}`. Counting the
// creation's AUTHOR answered one member for every channel anybody created and zero for a
// scenario declaring no viewer, neither of which is a fact about a channel: the cases
// below read the two kinds against a room with four people in it, where authorship and
// membership cannot be confused for each other.

import { describe, expect, it } from "vitest";

import {
  CHANNEL_HANDOFF,
  CHANNEL_MAIN,
  CHANNEL_REVIEW,
  COLLABORATION_PARTICIPANTS,
} from "../scenarios/collaboration/identifiers.js";
import { COLLABORATION_SCENARIO } from "../scenarios/collaboration.js";
import {
  createFixture,
  unscriptedScenario,
  type FixtureUnderTest,
} from "./fixture-bridge.test-support.js";
import {
  createdChannelIdIn,
  directoryMemberCountOf,
  directoryRowOf,
  directoryRowsOf,
  directoryStateOf,
} from "./fixture-channel-directory.test-support.js";
import { scenarioAlsoPlaying } from "./scenario-append.test-support.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** Past every beat the collaboration room plays, so an advance leaves nothing due. */
const PAST_EVERY_BEAT_MS = 10_000;

/** Far enough in to have delivered the room's opening beats and no further. */
const INTO_THE_OPENING_MS = 100;

/** A session this room is not, for the frames whose payload names the wrong one. */
const ELSEWHERE_ID = "019b7904-8ce0-7c11-8199-cca0117a0998";

/** A channel no scripted reply and no shipped beat of this room's names. */
const ANNOUNCED_CHANNEL_ID = "019b7904-8ce0-7c11-8145-cca0117a0397";

/** The room, its lifecycle replies scripted, ready to be read from. */
function room(scenario: ConsoleScenario = COLLABORATION_SCENARIO): FixtureUnderTest {
  return createFixture(scenario);
}

describe("the fixture's channel directory — what the read answers once frames have landed", () => {
  it("reports a channel live until its archival beat is due, and archived after", async () => {
    // The reading a fixed reply cannot give and the one the scenario is built to show.
    // Before the beat the room has not archived anything, so a read that answered
    // `archived` would be exposing state the script has not reached; after it, the
    // re-read the beat triggers is the transition every directory surface renders.
    const fixture = room();

    fixture.engine.advance(INTO_THE_OPENING_MS);
    const beforeTheBeat = await directoryStateOf(fixture, CHANNEL_HANDOFF);
    fixture.engine.advance(PAST_EVERY_BEAT_MS);
    const afterTheBeat = await directoryStateOf(fixture, CHANNEL_HANDOFF);

    expect(beforeTheBeat).toBe("active");
    expect(afterTheBeat).toBe("archived");
  });

  it("moves a channel a served act archived, which no beat in the script mentions", async () => {
    // The same fold from the other side: an act publishes a frame, and the directory
    // read is what every other reader of that session would then see. A fixture that
    // served the scripted reply back would answer the presser with the row's old state.
    const fixture = room();

    await fixture.bridge.growth.channelArchive({ channelId: CHANNEL_REVIEW });

    expect(await directoryStateOf(fixture, CHANNEL_REVIEW)).toBe("archived");
  });

  it("adds the row a served create minted, which the scripted directory holds none of", async () => {
    // The other half of the create defect. The receipt settled and the form reset, and
    // the channel appeared nowhere: the scripted `channel.list` reply has no row for a
    // channel nobody had created when the script was written, so the only way it can
    // arrive is the fold. A live channel is what a create leaves behind.
    const fixture = room();

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });

    expect(await directoryRowOf(fixture, channelId)).toStrictEqual({
      id: channelId,
      name: "handover",
      state: "active",
      participantCount: COLLABORATION_PARTICIPANTS.length,
    });
  });

  it("counts a created channel's members from the session's roster, never from its author", async () => {
    // The count a created row carries is a fact about the CHANNEL, and the only thing
    // the fold could once read was who wrote the frame: every channel anybody created
    // reported one member. This room has four people in it and one of them pressed the
    // button, so the two readings cannot be mistaken for each other.
    const fixture = room();

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });

    expect(await directoryMemberCountOf(fixture, channelId)).toBe(
      COLLABORATION_PARTICIPANTS.length,
    );
  });

  it("counts a direct channel's members from the pair its create names", async () => {
    // The other arm, and the reason the count is read off the REQUEST rather than
    // restated as a rule: a `direct` channel is exactly the two humans it is between,
    // and the pair is where those two are named. The same room answers four for the
    // kind above, so a fold that had one answer for every creation fails one of the two.
    const fixture = room();
    const [first, second] = COLLABORATION_PARTICIPANTS;

    const channelId = await createdChannelIdIn(fixture, {
      kind: "direct",
      memberPair: [first?.participantId ?? "", second?.participantId ?? ""],
    });

    expect(await directoryMemberCountOf(fixture, channelId)).toBe(2);
  });

  it("negative control: a room that declares no viewer counts its roster all the same", async () => {
    // Without this the two cases above would pass over a fold that had merely swapped
    // one authorship reading for another. A scenario stating no viewer publishes a
    // frame with no actor on it — the reading that used to answer ZERO members — and
    // the roster it counts instead is unchanged by who is at the keyboard.
    // Omitted rather than set to `undefined`: `viewingParticipantId` is an optional
    // member, and under `exactOptionalPropertyTypes` a present-but-undefined one is a
    // different value from an absent one — the scenario the fixture would really be
    // handed is the absent one.
    const { viewingParticipantId: _omittedViewer, ...withoutViewer } = COLLABORATION_SCENARIO;
    const fixture = room(withoutViewer);

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });

    expect(await directoryMemberCountOf(fixture, channelId)).toBe(
      COLLABORATION_PARTICIPANTS.length,
    );
  });

  it("omits the name on a created row whose creation carried none", async () => {
    // `name?` is absent on this wire rather than empty, so a row folded from a
    // creation that named nothing carries no member at all — the shape the directory
    // labels by the other human in the pair.
    const fixture = room();

    const channelId = await createdChannelIdIn(fixture);

    expect(Object.hasOwn((await directoryRowOf(fixture, channelId)) ?? {}, "name")).toBe(false);
  });

  it("moves a created row on, exactly as it moves a row the script opened", async () => {
    // The fold walks the log in order and the last transition wins, so a channel
    // created and then archived in one window reads archived — the created row is an
    // opening state like any other rather than a fixed answer appended past the fold.
    const fixture = room();

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });
    await fixture.bridge.growth.channelArchive({ channelId });

    expect(await directoryStateOf(fixture, channelId)).toBe("archived");
  });

  it("negative control: a create no scenario answers adds no row", async () => {
    // Without this the cases above would pass over a fold that appended a row for the
    // ASKING rather than for what the session was told — a directory listing a channel
    // the daemon refused to create. The room scripts an empty directory and no create,
    // so the only thing that could put a row there is the act.
    const scenario: ConsoleScenario = {
      ...unscriptedScenario("channel-create-directory-unscripted"),
      replies: [{ call: "channel.list", result: { channels: [] } }],
    };
    const fixture = room(scenario);

    const outcome = await fixture.bridge.growth.channelCreate({
      sessionId: scenario.sessionId,
      name: "handover",
    });
    expect(outcome.status).toBe("unavailable");
    expect(await directoryRowsOf(fixture)).toStrictEqual([]);
  });

  it("lists one row for a channel two presses created, because the receipt names one", async () => {
    // A scenario answers one call one way, so a second Create is answered with the same
    // identity — and two rows for one channel is a shape no `channel.list` can send.
    const fixture = room();

    const first = await createdChannelIdIn(fixture, { name: "handover" });
    const second = await createdChannelIdIn(fixture, { name: "handover again" });
    const rows = await directoryRowsOf(fixture);

    expect(second).toBe(first);
    expect(rows.filter((channel) => channel["id"] === first)).toHaveLength(1);
  });

  it("negative control: a room that announces its own channels lists each of them once", async () => {
    // The filter that keeps the appended rows from doubling the directory. This room
    // plays a `channel.created` beat for every channel its scripted reply already
    // carries — every shipped scenario does — so a fold that appended for the creation
    // rather than for the absence would list all four twice.
    const fixture = room();
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const identifiers = (await directoryRowsOf(fixture)).map((channel) => channel["id"]);

    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it("negative control: a channel no frame has moved keeps the state the script opens it in", async () => {
    // Without this, a fold that answered `archived` for every row — or one that
    // replaced the whole reply — would pass both cases above. The bootstrap channel is
    // in no lifecycle frame this room plays and reads live from first tick to last.
    const fixture = room();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(await directoryStateOf(fixture, CHANNEL_MAIN)).toBe("active");
  });

  it("ignores a transition whose payload names a session other than its envelope's", async () => {
    // A transition is keyed by `channelId` alone, so a frame delivered on this session
    // whose payload names another one moved this session's row on the strength of a
    // claim about somebody else's. `Spec-006` makes `sessionId` a member every
    // `membership_change`-shaped payload carries, and the membership projection already
    // refuses this exact contradiction — a fold beside it that admitted the frame would
    // let a fixture experiment accept the attribution regression that projection catches.
    const fixture = room(
      scenarioAlsoPlaying(COLLABORATION_SCENARIO, [
        { kind: "channel.muted", payload: { sessionId: ELSEWHERE_ID, channelId: CHANNEL_REVIEW } },
      ]),
    );

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(await directoryStateOf(fixture, CHANNEL_REVIEW)).toBe("active");
  });

  it("negative control: the same frame naming THIS session mutes the row", async () => {
    // Without this the case above would pass over a fold that had stopped reading
    // transitions at all, or one that dropped every appended frame. The frame is
    // identical but for the session its payload names, so that member is the only thing
    // deciding between the two readings.
    const fixture = room(
      scenarioAlsoPlaying(COLLABORATION_SCENARIO, [
        {
          kind: "channel.muted",
          payload: { sessionId: COLLABORATION_SCENARIO.sessionId, channelId: CHANNEL_REVIEW },
        },
      ]),
    );

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(await directoryStateOf(fixture, CHANNEL_REVIEW)).toBe("muted");
  });

  it("ignores a transition that names no session at all", async () => {
    // The other half of the required arm. These three kinds carry a `sessionId`, so an
    // omission is a malformed frame rather than a terse one — and admitting it would
    // make the guard above reachable only by writing the wrong id, never by writing none.
    const fixture = room(
      scenarioAlsoPlaying(COLLABORATION_SCENARIO, [
        { kind: "channel.archived", payload: { channelId: CHANNEL_REVIEW } },
      ]),
    );

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(await directoryStateOf(fixture, CHANNEL_REVIEW)).toBe("active");
  });

  it("adds a created row for a `channel.created` frame that names no session", async () => {
    // The contradiction arm, and the reason the guard is two rules rather than one.
    // `channel.created` is the one kind here the corpus registers a payload variant for,
    // and it is `{channelId, name?}` with no session in it — so a required rule would
    // refuse every creation this fixture itself publishes and empty the directory.
    const fixture = room(
      scenarioAlsoPlaying(COLLABORATION_SCENARIO, [
        { kind: "channel.created", payload: { channelId: ANNOUNCED_CHANNEL_ID, name: "triage" } },
      ]),
    );

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(await directoryRowOf(fixture, ANNOUNCED_CHANNEL_ID)).toStrictEqual({
      id: ANNOUNCED_CHANNEL_ID,
      name: "triage",
      state: "active",
      participantCount: COLLABORATION_PARTICIPANTS.length,
    });
  });
});
