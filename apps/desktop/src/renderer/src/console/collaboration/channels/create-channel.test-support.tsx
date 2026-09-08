// The cast the create form's own suites drive it with.
//
// A file beside `channels.test-support.tsx` rather than inside it, on the same rule
// that split the surfaces: the directory list and the create form are two components
// with two harnesses, and one file holding both had reached this package's size gate.
// What is SHARED — the id table, the row and roster builders, the scenarios, and the
// bridge every case answers through — stays there and is imported here, because a
// second copy of any of it is two suites disagreeing about the same session.
//
// EVERY CONTROL IS ADDRESSED POSITIONALLY OR THROUGH THE WIRE'S OWN VOCABULARY, never
// by its label. A case that clicked on the word "Direct" would go green against a form
// that had stopped sending `direct`, and the label is the half a person can safely
// change.

import { act, fireEvent, render } from "@testing-library/react";

import {
  GROWTH_CHANNEL_KINDS,
  type ConsoleBridge,
  type GrowthChannelKind,
} from "../../bridge/index.js";
import { CreateChannel } from "./CreateChannel.js";
import {
  LABELS,
  PARTICIPANT_OTHER,
  PARTICIPANT_YOU,
  SESSION_ID,
  channelsBridge,
  viewerOf,
} from "./channels.test-support.js";

/** What a case may steer about the create form it renders on its own. */
export interface CreateChannelOverrides {
  readonly bridge?: ConsoleBridge;
  readonly viewerParticipantId?: string | undefined;
  readonly participantIds?: readonly string[];
  /** Which session the form is for. A case re-addressing the mount passes a second one. */
  readonly sessionId?: string;
}

/**
 * The element itself, so a case can re-address the SAME mount.
 *
 * Declared once and rendered twice rather than spelled again beside a `rerender`, on
 * `channels.test-support.tsx`'s own rule for the directory: a second copy of this prop
 * table is a case whose re-render quietly changes a prop it did not mean to — and the
 * prop that must not move here is the bridge, which the form reads as half of the
 * subject its draft is held under.
 */
export function createChannelElement(
  overrides: CreateChannelOverrides,
  bridge: ConsoleBridge,
): React.JSX.Element {
  return (
    <CreateChannel
      bridge={bridge}
      sessionId={overrides.sessionId ?? SESSION_ID}
      viewerParticipantId={viewerOf(overrides)}
      participantIds={overrides.participantIds ?? [PARTICIPANT_YOU, PARTICIPANT_OTHER]}
      labels={LABELS}
    />
  );
}

/**
 * Render the create form alone, which is how the form's own suites drive it — and hand
 * the bridge back, because a case that re-addresses has to pass the same one.
 */
export function renderCreateChannel(
  overrides: CreateChannelOverrides = {},
): ReturnType<typeof render> & { readonly bridge: ConsoleBridge } {
  const bridge = overrides.bridge ?? channelsBridge();
  return { ...render(createChannelElement(overrides, bridge)), bridge };
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
