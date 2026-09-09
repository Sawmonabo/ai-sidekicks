// What both new-session suites mount: the fixture bridge the draft calls through, the
// held and queued variants the ordering cases need, and the presses that drive them.
//
// One module rather than a copy in each, because every case in both files opens the
// same control against the same registered `session.create` — and two spellings of
// "a bridge whose create answers" would let one file pass against a wire the other
// never scripts.

import { act, fireEvent, render, screen } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import {
  withDaemonCall,
  type BridgeUnderTest,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { ConsoleScenario } from "../../bridge/scenario/runtime/vocabulary.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { NewSessionControl } from "./NewSessionControl.js";
import type { NewSessionBlockedAct } from "../../seats/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
// The created session's id, from the module that DECLARES it. Both new-session
// scaffolding modules script the same `session.create`, so a second copy of the id
// here would be two spellings of one reply that no gate compares.
import { CREATED_SESSION_ID } from "./new-session-draft.test-support.js";

/**
 * The one call the suspended-bridge helpers below hold, and no other.
 *
 * They used to suspend and answer EVERY call, which was invisible while the composed
 * draft's only sendable axis was a posture and its send stopped at the missing turn.
 * Once the first message is the axis, a send makes two calls — and a helper named for
 * the create that answered `run.queueCreate` with the create's reply would be scripting
 * a wire the daemon cannot produce, and counting a turn as a second create.
 */
const SESSION_CREATE_CALL = "session.create";

/**
 * The destination putting acts normally — what every case that is not about the block
 * mounts against.
 *
 * Both halves say the same thing, which is the reading's own rule: the render-time
 * sentence and the dispatch-time reader are one fact asked at two moments, and a
 * harness whose halves disagreed would be scripting a state the destination cannot
 * produce.
 */
export const NOTHING_BLOCKS_THE_ACT: NewSessionBlockedAct = {
  sentence: undefined,
  readSentence: () => undefined,
};

/** The destination refusing every act, with the cause a control renders. */
export function blockedActSaying(sentence: string): NewSessionBlockedAct {
  return { sentence, readSentence: () => sentence };
}

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

/** A bridge whose `session.create` is held open, and the handle that lets it answer. */
export interface HeldCreate {
  readonly bridge: ConsoleBridge;
  /** Lets the held `session.create` settle on the registered reply. */
  readonly answer: () => void;
}

/** Several suspended creates at once, and the handle that answers them in order. */
export interface QueuedCreates {
  readonly bridge: ConsoleBridge;
  /** Lets the OLDEST still-suspended create proceed to the fixture's reply. */
  readonly answerOldest: () => void;
  readonly pendingCount: () => number;
}

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
  onSessionDirectoryRecheck: () => void = () => undefined,
  blockedAct: NewSessionBlockedAct = NOTHING_BLOCKS_THE_ACT,
): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <NewSessionControl
        bridge={bridge}
        blockedAct={blockedAct}
        onSessionCreated={onSessionCreated}
        onSessionDirectoryRecheck={onSessionDirectoryRecheck}
      />
    </LiveAnnouncerProvider>,
  );
  return container;
}

export function renderControl(options: { readonly scriptsCreate: boolean }): HTMLElement {
  return renderControlOn(bridgeFor(options));
}

/**
 * A bridge whose `session.create` fulfils with a reply the registered schema refuses.
 *
 * Short of `state`, `memberships` and `channels`, so the call door answers
 * `reply-unreadable` — the daemon was reached, ran, and answered, and only this
 * build's reading of what it said failed. That is the state a session may exist in
 * with no name this window holds.
 */
export function bridgeAnsweringCreateUnreadably(): ConsoleBridge {
  const { bridge } = withDaemonCall(bridgeFor({ scriptsCreate: true }), async () => ({
    sessionId: CREATED_SESSION_ID,
  }));
  return bridge;
}

/**
 * The fixture bridge with its `session.create` suspended until told to answer.
 *
 * A send that resolves within the same microtask cannot be observed mid-flight, and
 * "Send is disabled while a send is running" is a claim about exactly that moment.
 * Only the TIMING is the test's: what settles is `CREATE_REPLY`, the same whole
 * registered response every other case here reads.
 *
 * `scriptsFirstTurn` rides through to {@link bridgeFor} rather than being a second
 * suspended bridge, because a case about what a COMPLETED send closes needs both of
 * this draft's calls scripted and the create still held — with only the create
 * scripted every send here settles partial, which is the arm that never closes a
 * draft in the first place.
 *
 * Through `withDaemonCall` rather than a spread written here, because a test reaches
 * `daemon.call` on the same terms production does — `daemon-reply-chokepoint` scans
 * source text and does not care which tier wrote it — and one shared arm is what
 * keeps every suite driving the same door.
 */
export function bridgeHoldingCreate(
  options: { readonly scriptsFirstTurn?: boolean } = {},
): HeldCreate {
  let answer = (): void => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { bridge } = withDaemonCall(
    bridgeFor({ scriptsCreate: true, ...options }),
    async (call, passThrough) => {
      if (call.method !== SESSION_CREATE_CALL) {
        return await passThrough();
      }
      await held;
      return CREATE_REPLY;
    },
  );
  return { bridge, answer };
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
  const { bridge } = withDaemonCall(
    bridgeFor({ scriptsCreate: true }),
    async (call, passThrough) => {
      if (call.method !== SESSION_CREATE_CALL) {
        return await passThrough();
      }
      await new Promise<void>((resolve) => {
        suspended.push(resolve);
      });
      return CREATE_REPLY;
    },
  );
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

/**
 * Open a draft and type its first message — the shortest composition that can be sent.
 *
 * The first message is the ONLY axis this control offers, so it is also the only way a
 * draft reaches `isEmpty === false` from the screen. Which means `first-turn-missing`
 * is unreachable through this control by construction, and the partial arm every case
 * below reads is the unscripted `run.queueCreate` instead — the send makes both calls
 * and reports the second. The missing-turn refusal is still exercised where a draft
 * CAN be composed without one, in `new-session-send.test.ts`.
 */
export async function openDraftWithFirstTurn(): Promise<void> {
  await press("+ New");
  await typeFirstTurn("Start on the migration.");
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
 * Compose and send the one draft whose send COMPLETES — a first message, on a bridge
 * that scripts both calls.
 *
 * Both scripted calls land, so this is the only path in this family that reaches the
 * settlement: `sendNewSessionDraft` reports `sent` exactly when neither leg refused.
 */
export async function composeAndCompleteASend(): Promise<void> {
  await openDraftWithFirstTurn();
  await press("Send");
}

/**
 * The fixture with both calls scripted and every request body recorded.
 *
 * A pass-through arm rather than an answering one: what a case reads here is what the
 * control ASKED for, and a bridge that answered on its own would be recording requests
 * nothing ever sent. `withDaemonCall` is the console's one seam for that, so a case
 * asserting over request bodies drives the same door production does.
 */
export function bridgeRecordingACompleteSend(): BridgeUnderTest {
  return withDaemonCall(
    bridgeFor({ scriptsCreate: true, scriptsFirstTurn: true }),
    async (_call, passThrough) => await passThrough(),
  );
}
