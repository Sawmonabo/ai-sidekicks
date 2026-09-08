// What both new-session suites mount: the fixture bridge the draft calls through, the
// held and queued variants the ordering cases need, and the presses that drive them.
//
// One module rather than a copy in each, because every case in both files opens the
// same control against the same registered `session.create` — and two spellings of
// "a bridge whose create answers" would let one file pass against a wire the other
// never scripts.

import { act, fireEvent, render, screen } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { NewSessionControl } from "./NewSessionControl.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

export const CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de";

/**
 * The WHOLE registered create response.
 *
 * Whole, because the fixture bridge parses a scripted reply against the method's own
 * shape and refuses one that is short of it — a partial script would have been a
 * console tested against a reply the daemon cannot send. Named once, so the scripted
 * arm and the two suspended arms below settle on the same thing.
 */
export const CREATE_REPLY: {
  readonly sessionId: string;
  readonly state: string;
  readonly memberships: readonly never[];
  readonly channels: readonly never[];
} = {
  sessionId: CREATED_SESSION_ID,
  state: "active",
  memberships: [],
  channels: [],
};

/**
 * The WHOLE registered first-turn response, for the same reason the create's is whole.
 *
 * Scripting it is what makes a COMPLETED send reachable at all. The draft this control
 * composes offers a posture and a first message and no agents, so `session.create` and
 * `run.queueCreate` are the two calls its send makes — script only the first and every
 * send in this family settles `partial`, which is the state the settlement arm is
 * deliberately not reached from.
 */
export const FIRST_TURN_REPLY: {
  readonly queueItemId: string;
  readonly state: string;
  readonly createdAt: string;
} = {
  queueItemId: "019b793b-7b60-7f2a-9a4a-6f0f1f4f4c11",
  state: "queued",
  createdAt: "2026-01-01T09:00:00.000Z",
};

/**
 * A bridge whose `session.create` answers, or one whose does not, and whose first turn
 * is scripted only where a case needs a send to complete.
 *
 * The fixture bridge rather than a hand-written stub: the draft calls through
 * `bridge.sidekicks.daemon.call`, and a stub of that member would be a second
 * implementation of the one door this family's tests already have.
 */
export function bridgeFor(options: {
  readonly scriptsCreate: boolean;
  readonly scriptsFirstTurn?: boolean;
}): ConsoleBridge {
  const scenario: ConsoleScenario = {
    id: "new-session-control",
    label: "New session control",
    purpose: "Drives the composed-draft control's two reachable wire calls.",
    sessionId: "session-draft",
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T09:00:00.000Z",
    beats: [],
    replies: [
      ...(options.scriptsCreate ? [{ call: "session.create", result: CREATE_REPLY }] : []),
      ...(options.scriptsFirstTurn === true
        ? [{ call: "run.queueCreate", result: FIRST_TURN_REPLY }]
        : []),
    ],
  };
  return createFixtureBridge({ scenario });
}

/**
 * The control under the window's announcer, which is where the frame mounts it.
 *
 * The settlement is a PARAMETER with a default that records nothing, because the
 * destination hands one over on every mount and a harness that omitted it would be
 * driving a control no composition produces. A case about the settlement passes its
 * own recorder; every other case ignores what the default collects.
 */
export function renderControlOn(
  bridge: ConsoleBridge,
  onSessionCreated: (sessionId: string) => void = () => undefined,
): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <NewSessionControl bridge={bridge} onSessionCreated={onSessionCreated} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

export function renderControl(options: { readonly scriptsCreate: boolean }): HTMLElement {
  return renderControlOn(bridgeFor(options));
}

/** A bridge whose `session.create` is held open, and the handle that lets it answer. */
export interface HeldCreate {
  readonly bridge: ConsoleBridge;
  /** Lets the held `session.create` settle on the registered reply. */
  readonly answer: () => void;
}

/**
 * The fixture bridge with its `session.create` suspended until told to answer.
 *
 * A send that resolves within the same microtask cannot be observed mid-flight, and
 * "Send is disabled while a send is running" is a claim about exactly that moment.
 * Only the TIMING is the test's: what settles is `CREATE_REPLY`, the same whole
 * registered response every other case here reads.
 *
 * Through `withDaemonCall` rather than a spread written here, because a test reaches
 * `daemon.call` on the same terms production does — `daemon-reply-chokepoint` scans
 * source text and does not care which tier wrote it — and one shared arm is what
 * keeps every suite driving the same door.
 */
export function bridgeHoldingCreate(): HeldCreate {
  let answer = (): void => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { bridge } = withDaemonCall(bridgeFor({ scriptsCreate: true }), async () => {
    await held;
    return CREATE_REPLY;
  });
  return { bridge, answer };
}

/** Several suspended creates at once, and the handle that answers them in order. */
export interface QueuedCreates {
  readonly bridge: ConsoleBridge;
  /** Lets the OLDEST still-suspended create proceed to the fixture's reply. */
  readonly answerOldest: () => void;
  readonly pendingCount: () => number;
}

/**
 * The fixture bridge with every `session.create` suspended, answerable one at a time.
 *
 * {@link bridgeHoldingCreate} holds them all behind one promise, which cannot show
 * what happens when an OLD draft's send settles while a new one is still running —
 * the case where a shared flag and an unguarded continuation do their damage. Every
 * reply is still `CREATE_REPLY`; only their order is the test's.
 */
export function bridgeQueueingCreates(): QueuedCreates {
  const suspended: (() => void)[] = [];
  const { bridge } = withDaemonCall(bridgeFor({ scriptsCreate: true }), async () => {
    await new Promise<void>((resolve) => {
      suspended.push(resolve);
    });
    return CREATE_REPLY;
  });
  return {
    bridge,
    answerOldest: () => {
      suspended.shift()?.();
    },
    pendingCount: () => suspended.length,
  };
}

/**
 * Press a control and let React finish reacting.
 *
 * Unwrapped, an assertion would read a tree one render behind — and the send case
 * would additionally resolve its promise outside `act`, so the announcement it is
 * about would arrive after the assertion that reads for it.
 */
export async function press(name: string | RegExp): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name }).click();
    await crossMacrotaskBoundary();
  });
}

export function politeText(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/** Open a draft and choose a posture — the shortest composition that can be sent. */
export async function openDraftWithPosture(): Promise<void> {
  await press("+ New");
  await act(async () => {
    screen.getByRole("radio", { name: "Trusted" }).click();
    await crossMacrotaskBoundary();
  });
}

/**
 * Type the first message, through the field a person types into.
 *
 * `fireEvent` rather than assigning `value`, because the draft holds the text and the
 * field renders off it: a direct assignment moves the DOM node and leaves the object
 * that decides what gets sent untouched.
 */
export async function typeFirstTurn(firstTurn: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Its first message"), {
      target: { value: firstTurn },
    });
    await crossMacrotaskBoundary();
  });
}

/**
 * Compose and send the one draft whose send COMPLETES — a posture and a first message.
 *
 * Both scripted calls land, so this is the only path in this family that reaches the
 * settlement: `sendNewSessionDraft` reports `sent` exactly when neither leg refused.
 */
export async function composeAndCompleteASend(): Promise<void> {
  await openDraftWithPosture();
  await typeFirstTurn("Start on the migration.");
  await press("Send");
}
