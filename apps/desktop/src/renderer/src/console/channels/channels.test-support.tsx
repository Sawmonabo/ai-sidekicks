// The cast every channels suite drives these two surfaces with.
//
// Hoisted on this package's second-use rule: the directory's rows, the three lifecycle
// moves, and the create form beneath are suites over two components, and all of them
// need one id table, one channel builder, and one way of getting a bridge that answers.
// A second copy of the id table is two rows accidentally sharing an id; a second
// scenario builder is two suites disagreeing about how a scripted refusal reaches a
// surface.
//
// EVERY BRIDGE HERE IS THE REAL FIXTURE, and that is what makes the refusal cases
// worth anything. A scripted daemon refusal travels the growth port's own rejection
// channel — thrown verbatim and unwrapped, exactly as the live seam will throw it once
// these four operations become ordinary bridge calls — so a case naming
// `channel.not_found` drives the path the console will actually take rather than a
// hand-written stub of it, and a surface that stopped settling that channel would
// hang here rather than pass.

import { act, render } from "@testing-library/react";

import { MAIN_CHANNEL_NAME, type ChannelListResponseChannel } from "@ai-sidekicks/contracts";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../bridge/fixture/call-plane/bridge.test-support.js";
import { type ConsoleBridge } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario/runtime/vocabulary.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../core/settle.test-support.js";
import type { PushDrivenReadState, SidebarSectionContext } from "../seats/index.js";
import { ActivityIndicatorRegistry, type ChannelActivityLabels } from "./activity-model.js";
import type { ChannelDirectoryReading } from "./channel-model.js";
import { ChannelSettlementOrder } from "./channel-settlement-order.js";
import { ChannelList } from "./ChannelList.js";

/**
 * The ids these suites send, grouped so two rows cannot accidentally share one.
 *
 * Readable rather than UUID-shaped, which is a fact about which door they cross: the
 * directory arrives as a PROP here and the four channel-plane operations are growth
 * ones, so nothing parses these against a branded wire scalar the way the call door
 * parses a daemon method's identifiers.
 */
export const SESSION_ID: string = "019b7d10-0000-7000-8000-000000000001";
export const CHANNEL_MAIN: string = "channel-main";
export const CHANNEL_REVIEW: string = "channel-review";
export const CHANNEL_RELAY: string = "channel-relay";
export const CHANNEL_OLD: string = "channel-old";

/**
 * The label registry the surfaces resolve run ids through.
 *
 * Every id falls through to itself, which is the registry's real behaviour where the
 * projection names no agent: a row labelled by an id is correct rather than degraded.
 */
export const LABELS: ChannelActivityLabels = {
  runLabel: (runId) => runId,
};

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
    // Required on the wire row and rendered by nothing: the directory's rows carry
    // their own name and state and nothing else the surface reads.
    userCount: 1,
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

/** The scenario id every bridge below plays under. Named once; it rides every refusal. */
const SCENARIO_ID = "channels-test";

/** How a case wants its bridge to answer: which script it plays. */
export interface ChannelsBridgeOptions {
  readonly scenario?: ConsoleScenario;
}

/** What a case may steer about the directory it renders. */
export interface ChannelListOverrides {
  readonly bridge?: ConsoleBridge;
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
 * Every answer — the four lifecycle writes included — goes through the scenario, so a
 * write's answer travels the same seam a person's press will.
 */
export function channelsBridge(options: ChannelsBridgeOptions = {}): ConsoleBridge {
  return fixtureBridgeWithGrowth(options.scenario ?? channelsScenario(), {});
}

/**
 * Render the directory, with a real bridge under it — and answer with that bridge.
 *
 * The bridge travels BACK rather than being resolved twice, because the work beneath
 * this list runs on the scenario's own frozen clock: a caller that has to advance it
 * has to hold the engine the surface is actually reading, and one resolved a second
 * time would be a second scenario nothing rendered.
 */
export function renderChannelList(
  state: PushDrivenReadState<ChannelDirectoryReading>,
  overrides: ChannelListOverrides = {},
): ReturnType<typeof render> & { readonly bridge: ConsoleBridge } {
  const bridge = overrides.bridge ?? channelsBridge();
  return { ...render(channelListElement(state, overrides, bridge)), bridge };
}

/**
 * Carry this list's debounced work past its window, and let it land.
 *
 * Under the fixture the scenario's frozen clock is the only clock this renderer reads,
 * so a case that merely awaited would assert against work that had never been performed
 * rather than work that had settled.
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
 * Render the directory and let its pending work land.
 *
 * The default for every case: work settling outside React's scope applies its state
 * write without the surrounding commit, so an assertion taken next reads the render
 * before it.
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
      openPane={overrides.openPane ?? (() => undefined)}
      activity={new ActivityIndicatorRegistry()}
      labels={LABELS}
      isCatchingUp={overrides.isCatchingUp ?? false}
      onReopen={overrides.onReopen ?? (() => undefined)}
    />
  );
}
