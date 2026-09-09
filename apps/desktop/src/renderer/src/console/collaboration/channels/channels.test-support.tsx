// The cast every channels suite drives these two surfaces with.
//
// Hoisted on this package's second-use rule: the directory's rows, the roster
// enrichment beside them, the three lifecycle moves, and the create form beneath are
// four suites over two components, and all four need one id table, one channel
// builder, one roster builder, and one way of getting a bridge that answers. A second
// copy of the id table is two rows accidentally sharing an id; a second scenario
// builder is two suites disagreeing about how a scripted refusal reaches a surface.
//
// EVERY BRIDGE HERE IS THE REAL FIXTURE, and that is what makes the refusal cases
// worth anything. A scripted daemon refusal travels the growth port's own rejection
// channel — thrown verbatim and unwrapped, exactly as the live seam will throw it once
// these five operations become ordinary bridge calls — so a case naming
// `channel.not_found` drives the path the console will actually take rather than a
// hand-written stub of it, and a surface that stopped settling that channel would
// hang here rather than pass.

import { act, render } from "@testing-library/react";

import { MAIN_CHANNEL_NAME, type ChannelListResponseChannel } from "@ai-sidekicks/contracts";

import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  growthRefusing,
  growthServing,
  unscriptedScenario,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import {
  type ConsoleBridge,
  type GrowthChannelAudience,
  type GrowthChannelKind,
  type GrowthChannelRosterEntry,
  type GrowthPort,
} from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario/runtime/vocabulary.js";
import { ManualClock } from "../../core/index.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../../core/settle.test-support.js";
import type { PushDrivenReadState, SidebarSectionContext } from "../../seats/index.js";
import { ActivityIndicatorRegistry, type ChannelActivityLabels } from "../activity-model.js";
import type { ChannelDirectoryReading } from "./channel-model.js";
import { ChannelSettlementOrder } from "./channel-settlement-order.js";
import { ChannelList } from "./ChannelList.js";

/**
 * The ids these suites send, grouped so two rows cannot accidentally share one.
 *
 * Readable rather than UUID-shaped, which is a fact about which door they cross: the
 * directory arrives as a PROP here and the five channel-plane operations are growth
 * ones, so nothing parses these against a branded wire scalar the way the call door
 * parses an invite's identifiers.
 */
export const SESSION_ID: string = "019b7d10-0000-7000-8000-000000000001";
export const PARTICIPANT_YOU: string = "participant-you";
export const PARTICIPANT_OTHER: string = "participant-other";
export const PARTICIPANT_THIRD: string = "participant-third";
export const CHANNEL_MAIN: string = "channel-main";
export const CHANNEL_REVIEW: string = "channel-review";
export const CHANNEL_RELAY: string = "channel-relay";
export const CHANNEL_DIRECT: string = "channel-direct";
export const CHANNEL_OLD: string = "channel-old";

/** The two people these suites give a friendly name to. Everybody else wears their id. */
const PARTICIPANT_NAMES: Readonly<Record<string, string>> = {
  [PARTICIPANT_OTHER]: "Dana",
  [PARTICIPANT_THIRD]: "Sam",
};

/**
 * The label registry the surfaces resolve participants through.
 *
 * Two of the three ids resolve to a name and the rest fall through to the id, which is
 * the registry's real behaviour: a row labelled by an id is correct rather than
 * degraded, so a case can tell "labelled by the human" from "labelled by the wire".
 */
export const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => PARTICIPANT_NAMES[participantId] ?? participantId,
  runLabel: (runId) => runId,
};

/** What one roster entry may say, spelled member by member. */
export interface RosterEntryOptions {
  readonly name?: string;
  readonly kind?: GrowthChannelKind;
  readonly memberPair?: readonly [string, string];
  readonly audience?: GrowthChannelAudience;
}

/** One row of the directory, in the shape `channel.list` serves it. */
export function channel(
  id: string,
  state: ChannelListResponseChannel["state"],
  name?: string,
): ChannelListResponseChannel {
  return {
    id: id as ChannelListResponseChannel["id"],
    ...(name === undefined ? {} : { name }),
    state,
    participantCount: 4,
  };
}

/**
 * The session's bootstrap row.
 *
 * Named from `MAIN_CHANNEL_NAME` rather than spelled, because that constant is how the
 * ordering rule recognises the row at all: a literal here would keep passing on the
 * day the projection renames it and the hoist stopped firing.
 */
export function mainChannel(): ChannelListResponseChannel {
  return channel(CHANNEL_MAIN, "active", MAIN_CHANNEL_NAME);
}

/**
 * What the directory read carries once it has answered.
 *
 * CALLING THIS IS THE MOMENT THE READ WAS ISSUED, which is the whole of what the second
 * argument is for: the answer carries the position it took in the settlement order, and a
 * case that wants a reply from a read the daemon had already moved past builds it BEFORE
 * pressing the control that moves it. Cases that never press a lifecycle control take the
 * default and get an order of their own, which orders nothing because nothing settles in
 * it.
 */
export function loaded(
  channels: readonly ChannelListResponseChannel[],
  settlements: ChannelSettlementOrder = new ChannelSettlementOrder(),
): PushDrivenReadState<ChannelDirectoryReading> {
  return { kind: "loaded", value: { channels, settlements, position: settlements.openRead() } };
}

/**
 * One roster entry, built member by member rather than by spreading a partial.
 *
 * Every optional member is omitted where it was not asked for, never present and
 * `undefined`: an entry carrying `audience: undefined` and one carrying no `audience`
 * are the same value to a reader and different values to `exactOptionalPropertyTypes`,
 * and the surfaces under test branch on absence.
 */
export function rosterEntry(
  id: string,
  options: RosterEntryOptions = {},
): GrowthChannelRosterEntry {
  return {
    id,
    ...(options.name === undefined ? {} : { name: options.name }),
    kind: options.kind ?? "general",
    ...(options.memberPair === undefined ? {} : { memberPair: options.memberPair }),
    config: options.audience === undefined ? {} : { audience: options.audience },
  };
}

/** The scenario id every bridge below plays under. Named once; it rides every refusal. */
const SCENARIO_ID = "collaboration-channels-test";

/**
 * How the roster read answers: one fixed list, the port's own refusal, or a list read
 * at the moment of the call.
 *
 * The third arm is what a REFRESH case needs and the first cannot give: a fixed value
 * answers every read the same way, so a list whose roster arrived after a second read
 * could not be told from one whose roster never moved.
 */
export type ChannelsBridgeRoster =
  | readonly GrowthChannelRosterEntry[]
  | "refused"
  | (() => readonly GrowthChannelRosterEntry[]);

/** How a case wants its bridge to answer: which script, and what the roster read says. */
export interface ChannelsBridgeOptions {
  readonly scenario?: ConsoleScenario;
  readonly roster?: ChannelsBridgeRoster;
}

/** What a case may steer about the directory it renders. */
export interface ChannelListOverrides {
  readonly bridge?: ConsoleBridge;
  readonly viewerParticipantId?: string | undefined;
  readonly participantIds?: readonly string[];
  readonly openPane?: SidebarSectionContext["openPane"];
  readonly isCatchingUp?: boolean;
  readonly onReopen?: () => void;
}

/**
 * A scenario whose scripted replies ANSWER the named calls, one row each.
 *
 * The engine keys its reply table by call, so a case that presses two different verbs in
 * one run — a mute and then the unmute that corrects it — scripts both here rather than
 * building a second bridge the surface would read as a re-address.
 */
export function scenarioAnsweringEach(
  answers: readonly (readonly [call: string, result: unknown])[],
): ConsoleScenario {
  return {
    ...channelsScenario(),
    replies: answers.map(([call, result]) => ({ call, result })),
  };
}

/** A scenario whose one scripted reply ANSWERS the named call. */
export function scenarioAnswering(call: string, result: unknown): ConsoleScenario {
  return scenarioAnsweringEach([[call, result]]);
}

/**
 * A scenario whose one scripted reply REFUSES the named call, in the wire's own shape.
 *
 * `{code, message}` and nothing else, because that is what the daemon sends and what
 * the fixture throws back unwrapped. A refusal built any other way would train these
 * surfaces against a value no bridge produces.
 */
export function scenarioRefusing(call: string, code: string, message: string): ConsoleScenario {
  return { ...channelsScenario(), replies: [{ call, refusal: { code, message } }] };
}

/**
 * The real fixture bridge, scripted as the case asks.
 *
 * The roster is an OVERRIDE rather than a scripted reply because the two answers a
 * case wants from it are the served list and the port's own refusal, and the second of
 * those is a fact about the port rather than about any script. Everything else — the
 * four lifecycle writes included — goes through the scenario, so a write's answer
 * travels the same seam a person's press will.
 */
export function channelsBridge(options: ChannelsBridgeOptions = {}): ConsoleBridge {
  const scenario = options.scenario ?? channelsScenario();
  const { roster } = options;
  return fixtureBridgeWithGrowth(scenario, roster === undefined ? {} : rosterAnswer(roster));
}

/**
 * The viewer these overrides name, defaulting to a KNOWN one.
 *
 * `Object.hasOwn` rather than a coalescing default, because "which participant this
 * window is has not been read" is a state both surfaces draw distinctly and
 * `undefined` is how it is spelled — `??` would make that state unreachable from a
 * case, which is exactly the state the direct arm fails closed on.
 *
 * Exported for the create form's own harness beside this one, which draws the same
 * distinction on the same prop: two readings of it would let one suite treat an unread
 * viewer as absent and the other as a default.
 */
export function viewerOf(overrides: {
  readonly viewerParticipantId?: string | undefined;
}): string | undefined {
  return Object.hasOwn(overrides, "viewerParticipantId")
    ? overrides.viewerParticipantId
    : PARTICIPANT_YOU;
}

/**
 * Render the directory, with a real bridge under it — and answer with that bridge.
 *
 * The bridge travels BACK rather than being resolved twice, because the roster read
 * beneath this list is debounced on the scenario's own frozen clock: a caller that has
 * to advance it has to hold the engine the surface is actually reading, and one
 * resolved a second time would be a second scenario nothing rendered.
 */
export function renderChannelList(
  state: PushDrivenReadState<ChannelDirectoryReading>,
  overrides: ChannelListOverrides = {},
): ReturnType<typeof render> & { readonly bridge: ConsoleBridge } {
  const bridge = overrides.bridge ?? channelsBridge();
  return { ...render(channelListElement(state, overrides, bridge)), bridge };
}

/**
 * Carry this list's debounced reads past their window, and let them land.
 *
 * The roster read is push-driven, so it performs NOTHING until the refresh window
 * closes — and under the fixture the scenario's frozen clock is the only clock this
 * renderer reads, so a case that merely awaited would assert against a read that had
 * never been performed rather than one that had answered.
 */
export async function settleChannelReads(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
  });
  await settle();
}

/**
 * Serve a fresh directory read into a list already on screen, and let it land.
 *
 * The case passes the SAME overrides it rendered with — its own bridge included — so
 * this is one session's list reading again rather than a different session's list
 * mounting, which is a distinction every subject-scoped holder under the surface draws.
 */
export async function serveChannelRead(
  rendered: ReturnType<typeof renderChannelList>,
  state: PushDrivenReadState<ChannelDirectoryReading>,
  overrides: ChannelListOverrides = {},
): Promise<void> {
  rendered.rerender(channelListElement(state, overrides, rendered.bridge));
  await settleChannelReads(rendered.bridge);
}

/**
 * Render the directory and let its roster read land.
 *
 * The default for every case that is not ABOUT the moment before the roster answers:
 * a read settling outside React's scope applies its state write without the
 * surrounding commit, so an assertion taken next reads the render before it.
 */
export async function renderChannelListSettled(
  state: PushDrivenReadState<ChannelDirectoryReading>,
  overrides: ChannelListOverrides = {},
): Promise<ReturnType<typeof renderChannelList>> {
  const rendered = renderChannelList(state, overrides);
  await settleChannelReads(rendered.bridge);
  return rendered;
}

/**
 * A scenario playing the session these suites render, and scripting nothing else.
 *
 * The session is stated rather than left to `unscriptedScenario`'s own, because the
 * surfaces below are rendered with `SESSION_ID` and the fixture's session-scoped
 * answers are scoped to the session the scenario plays: a harness addressing one
 * session while its bridge played another was being answered anyway, and every case
 * built on it was passing for a reason no daemon would reproduce.
 */
function channelsScenario(): ConsoleScenario {
  return { ...unscriptedScenario(SCENARIO_ID), sessionId: SESSION_ID };
}

/** The roster override one of those three arms asks for. */
function rosterAnswer(roster: ChannelsBridgeRoster): Partial<GrowthPort> {
  if (roster === "refused") {
    return { channelRosterRead: growthRefusing("channelRosterRead") };
  }
  return {
    channelRosterRead:
      typeof roster === "function"
        ? growthAnswering(async () => await Promise.resolve(roster()))
        : growthServing(roster),
  };
}

/**
 * The element itself, so a case can serve a SECOND read into the same list.
 *
 * Declared once and rendered twice rather than spelled again beside a `rerender`: a
 * second copy of this prop table is a case whose re-render quietly changes a prop it
 * did not mean to, and the props that must not move — the bridge above all — are
 * exactly the ones a subject-scoped surface reads as a re-address.
 */
function channelListElement(
  state: PushDrivenReadState<ChannelDirectoryReading>,
  overrides: ChannelListOverrides,
  bridge: ConsoleBridge,
): React.JSX.Element {
  return (
    <ChannelList
      state={state}
      bridge={bridge}
      sessionId={SESSION_ID}
      viewerParticipantId={viewerOf(overrides)}
      participantIds={overrides.participantIds ?? [PARTICIPANT_YOU, PARTICIPANT_OTHER]}
      openPane={overrides.openPane ?? (() => undefined)}
      activity={new ActivityIndicatorRegistry(new ManualClock())}
      labels={LABELS}
      isCatchingUp={overrides.isCatchingUp ?? false}
      onReopen={overrides.onReopen ?? (() => undefined)}
    />
  );
}
