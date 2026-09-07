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

import { act, fireEvent, render } from "@testing-library/react";

import { MAIN_CHANNEL_NAME, type ChannelListResponseChannel } from "@ai-sidekicks/contracts";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
  unscriptedScenario,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import {
  GROWTH_CHANNEL_KINDS,
  type ConsoleBridge,
  type GrowthChannelAudience,
  type GrowthChannelKind,
  type GrowthChannelRosterEntry,
} from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { ManualClock } from "../../core/index.js";
import { settle } from "../../core/settle.test-support.js";
import type { PushDrivenReadState, SidebarSectionContext } from "../../seats/index.js";
import { ActivityIndicatorRegistry, type ChannelActivityLabels } from "../activity-model.js";
import { ChannelList } from "./ChannelList.js";
import { CreateChannel } from "./CreateChannel.js";

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

/** What the directory read carries once it has answered. */
export function loaded(
  channels: readonly ChannelListResponseChannel[],
): PushDrivenReadState<readonly ChannelListResponseChannel[]> {
  return { kind: "loaded", value: channels };
}

/** What one roster entry may say, spelled member by member. */
export interface RosterEntryOptions {
  readonly name?: string;
  readonly kind?: GrowthChannelKind;
  readonly memberPair?: readonly [string, string];
  readonly audience?: GrowthChannelAudience;
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

/** A scenario whose one scripted reply ANSWERS the named call. */
export function scenarioAnswering(call: string, result: unknown): ConsoleScenario {
  return { ...unscriptedScenario(SCENARIO_ID), replies: [{ call, result }] };
}

/**
 * A scenario whose one scripted reply REFUSES the named call, in the wire's own shape.
 *
 * `{code, message}` and nothing else, because that is what the daemon sends and what
 * the fixture throws back unwrapped. A refusal built any other way would train these
 * surfaces against a value no bridge produces.
 */
export function scenarioRefusing(call: string, code: string, message: string): ConsoleScenario {
  return { ...unscriptedScenario(SCENARIO_ID), replies: [{ call, refusal: { code, message } }] };
}

/** How a case wants its bridge to answer: which script, and what the roster read says. */
export interface ChannelsBridgeOptions {
  readonly scenario?: ConsoleScenario;
  /** The entries the roster serves, or `"refused"` for the port's own refusal. */
  readonly roster?: readonly GrowthChannelRosterEntry[] | "refused";
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
  const scenario = options.scenario ?? unscriptedScenario(SCENARIO_ID);
  const { roster } = options;
  if (roster === undefined) {
    return fixtureBridgeWithGrowth(scenario, {});
  }
  return fixtureBridgeWithGrowth(scenario, {
    channelRosterRead:
      roster === "refused" ? growthRefusing("channelRosterRead") : growthServing(roster),
  });
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

/** What a case may steer about the create form it renders on its own. */
export interface CreateChannelOverrides {
  readonly bridge?: ConsoleBridge;
  readonly viewerParticipantId?: string | undefined;
  readonly participantIds?: readonly string[];
}

/**
 * The viewer these overrides name, defaulting to a KNOWN one.
 *
 * `Object.hasOwn` rather than a coalescing default, because "which participant this
 * window is has not been read" is a state both surfaces draw distinctly and
 * `undefined` is how it is spelled — `??` would make that state unreachable from a
 * case, which is exactly the state the direct arm fails closed on.
 */
function viewerOf(overrides: {
  readonly viewerParticipantId?: string | undefined;
}): string | undefined {
  return Object.hasOwn(overrides, "viewerParticipantId")
    ? overrides.viewerParticipantId
    : PARTICIPANT_YOU;
}

/** Render the directory, with a real bridge under it. */
export function renderChannelList(
  state: PushDrivenReadState<readonly ChannelListResponseChannel[]>,
  overrides: ChannelListOverrides = {},
): ReturnType<typeof render> {
  return render(
    <ChannelList
      state={state}
      bridge={overrides.bridge ?? channelsBridge()}
      sessionId={SESSION_ID}
      viewerParticipantId={viewerOf(overrides)}
      participantIds={overrides.participantIds ?? [PARTICIPANT_YOU, PARTICIPANT_OTHER]}
      openPane={overrides.openPane ?? (() => undefined)}
      activity={new ActivityIndicatorRegistry(new ManualClock())}
      labels={LABELS}
      isCatchingUp={overrides.isCatchingUp ?? false}
      onReopen={overrides.onReopen ?? (() => undefined)}
    />,
  );
}

/**
 * Render the directory and let its one roster read land.
 *
 * The default for every case that is not ABOUT the moment before the roster answers:
 * a read settling outside React's scope applies its state write without the
 * surrounding commit, so an assertion taken next reads the render before it.
 */
export async function renderChannelListSettled(
  state: PushDrivenReadState<readonly ChannelListResponseChannel[]>,
  overrides: ChannelListOverrides = {},
): Promise<ReturnType<typeof render>> {
  const rendered = renderChannelList(state, overrides);
  await settle();
  return rendered;
}

/** Render the create form alone, which is how the form's own suites drive it. */
export function renderCreateChannel(
  overrides: CreateChannelOverrides = {},
): ReturnType<typeof render> {
  return render(
    <CreateChannel
      bridge={overrides.bridge ?? channelsBridge()}
      sessionId={SESSION_ID}
      viewerParticipantId={viewerOf(overrides)}
      participantIds={overrides.participantIds ?? [PARTICIPANT_YOU, PARTICIPANT_OTHER]}
      labels={LABELS}
    />,
  );
}

/**
 * One element the case cannot proceed without, or a failure naming what it looked for.
 *
 * A throw rather than a non-null assertion, so a selector that stopped matching reports
 * itself instead of surfacing three lines later as a property read on `undefined`.
 */
function requiredElement<TElement extends Element>(
  container: HTMLElement,
  selector: string,
  index = 0,
): TElement {
  const found = container.querySelectorAll<TElement>(selector)[index];
  if (found === undefined) {
    throw new Error(`nothing matched ${selector} at index ${String(index)}`);
  }
  return found;
}

/** Type a name into the form's own name field. */
export function typeName(container: HTMLElement, name: string): void {
  fireEvent.change(requiredElement<HTMLInputElement>(container, ".meridian-create-channel__name"), {
    target: { value: name },
  });
}

/**
 * Choose one kind, addressed through the closed set the form renders from.
 *
 * Indexed off `GROWTH_CHANNEL_KINDS` rather than matched on a label, so a case names
 * the wire's own vocabulary and a relabelled control does not silently pick the other
 * arm.
 */
export function chooseKind(container: HTMLElement, kind: GrowthChannelKind): void {
  const index = GROWTH_CHANNEL_KINDS.indexOf(kind);
  act(() => {
    requiredElement<HTMLButtonElement>(container, ".meridian-create-channel__kind", index).click();
  });
}

/** The five configuration members the general arm collects, each as its own control. */
export interface CreateChannelPolicyControls {
  readonly audience: HTMLSelectElement;
  readonly turnPolicy: HTMLSelectElement;
  readonly roundRobinOrder: HTMLInputElement;
  readonly turnsPerAgent: HTMLInputElement;
  readonly moderationBoxes: readonly HTMLInputElement[];
}

/**
 * The policy controls, in the order the form declares them.
 *
 * Positional because that order is the form's own and a person meets it that way:
 * audience then turn policy among the selects, and the name then the round-robin order
 * then the per-agent cap among the text fields.
 */
export function policyFields(container: HTMLElement): CreateChannelPolicyControls {
  return {
    audience: requiredElement(container, ".meridian-create-channel__select", 0),
    turnPolicy: requiredElement(container, ".meridian-create-channel__select", 1),
    roundRobinOrder: requiredElement(container, ".meridian-create-channel__text", 1),
    turnsPerAgent: requiredElement(container, ".meridian-create-channel__text", 2),
    moderationBoxes: [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')],
  };
}

/** Every note the form writes under a field. */
export function fieldNotes(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-create-channel__field-note")].map(
    (note) => note.textContent ?? "",
  );
}
