// What both new-session suites mount: the fixture bridge the draft calls through, the
// held and queued variants the ordering cases need, and the presses that drive them.
//
// One module rather than a copy in each, because every case in both files opens the
// same control against the same registered `session.create` — and two spellings of
// "a bridge whose create answers" would let one file pass against a wire the other
// never scripts.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { withDaemonCall, type BridgeUnderTest } from "@test/helpers/fixture-bridge.js";
import type { Scenario } from "../../../../../../../fixtures/scenario.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import type { FirstTurnQueueCall } from "../new-session-control-contract.js";
import { NewSessionControl } from "./NewSessionControl.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
// The created session's id, from the module that DECLARES it. Both new-session
// scaffolding modules script the same `session.create`, so a second copy of the id
// here would be two spellings of one reply that no gate compares.
import { CREATED_SESSION_ID, type QueuedFirstTurn } from "../new-session-draft.test-support.js";

/** The one call the suspended-bridge helpers below hold, and no other. */
const SESSION_CREATE_CALL = "session.create";

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
} = {
  sessionId: CREATED_SESSION_ID,
  state: "active",
};

/** A first-turn call that rejects, so a send stops after the create and settles partial. */
export const REJECTING_FIRST_TURN: FirstTurnQueueCall = () =>
  Promise.reject(new Error("no first turn is scripted"));

/** A bridge whose `session.create` is held open, and the handle that lets it answer. */
export interface HeldCreate {
  readonly bridge: PlatformBridge;
  /** Lets the held `session.create` settle on the registered reply. */
  readonly answer: () => void;
}

/** Several suspended creates at once, and the handle that answers them in order. */
export interface QueuedCreates {
  readonly bridge: PlatformBridge;
  /** Lets the OLDEST still-suspended create proceed to the fixture's reply. */
  readonly answerOldest: () => void;
  readonly pendingCount: () => number;
}

/**
 * A first-turn call that resolves, and the requests it was asked to queue.
 *
 * Its resolving is what makes a COMPLETED send reachable at all: with the rejecting call
 * every send in these suites settles `partial`, which is the state the settlement arm is
 * deliberately not reached from.
 */
export function completingFirstTurn(): {
  readonly call: FirstTurnQueueCall;
  readonly requests: readonly QueuedFirstTurn[];
} {
  const requests: QueuedFirstTurn[] = [];
  return {
    call: (request) => {
      requests.push(request);
      return Promise.resolve();
    },
    requests,
  };
}

/**
 * A bridge whose `session.create` answers, or one whose does not.
 *
 * The fixture bridge rather than a hand-written stub: the draft calls through
 * `bridge.daemon.call`, and a stub of that member would be a second
 * implementation of the one daemon call these suites already drive.
 */
export function bridgeFor(options: { readonly scriptsCreate: boolean }): PlatformBridge {
  const scenario: Scenario = {
    id: "new-session-control",
    label: "New session control",
    purpose: "Drives the composed-draft control's create call.",
    sessionId: "session-draft",
    userIdsInJoinOrder: ["user-you"],
    startedAtIso: "2026-01-01T09:00:00.000Z",
    beats: [],
    replies: options.scriptsCreate ? [{ call: "session.create", result: CREATE_REPLY }] : [],
  };
  return createFixtureBridge({ scenario }).bridge;
}

/**
 * The control under the window's announcer, which is where the frame mounts it.
 *
 * The settlement is an OPTION with a default that records nothing, because the
 * destination hands one over on every mount and a harness that omitted it would be
 * driving a control no composition produces. A case about the settlement passes its
 * own recorder; every other case ignores what the default collects. The first-turn call
 * defaults to the rejecting one, so a send stops after the create unless a case says
 * otherwise.
 */
export function renderControlOn(
  bridge: PlatformBridge,
  options: {
    readonly onSessionCreated?: (sessionId: string) => void;
    readonly onSessionDirectoryRecheck?: () => void;
    readonly queueFirstTurn?: FirstTurnQueueCall;
  } = {},
): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <NewSessionControl
        bridge={bridge}
        queueFirstTurn={options.queueFirstTurn ?? REJECTING_FIRST_TURN}
        onSessionCreated={options.onSessionCreated ?? (() => undefined)}
        onSessionDirectoryRecheck={options.onSessionDirectoryRecheck ?? (() => undefined)}
      />
    </LiveAnnouncerProvider>,
  );
  return container;
}

export function renderControl(options: { readonly scriptsCreate: boolean }): HTMLElement {
  return renderControlOn(bridgeFor(options));
}

/**
 * A bridge whose `session.create` fulfills with a reply the registered schema refuses.
 *
 * Short of `state`, so `callDaemon` answers
 * `reply-unreadable` — the daemon was reached, ran, and answered, and only this
 * build's reading of what it said failed. That is the state a session may exist in
 * with no name this window holds.
 */
export function bridgeAnsweringCreateUnreadably(): PlatformBridge {
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
 * Through `withDaemonCall` rather than a spread written here, because a test reaches
 * `daemon.call` on the same terms production does, and one shared arm is what keeps
 * every suite driving the same `callDaemon` path.
 */
export function bridgeHoldingCreate(): HeldCreate {
  let answer = (): void => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { bridge } = withDaemonCall(
    bridgeFor({ scriptsCreate: true }),
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
 * below reads is the rejecting first-turn call instead — the send makes both calls and
 * reports the second. The missing-turn refusal is still exercised where a draft CAN be
 * composed without one, in `new-session-send.test.ts`.
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
 * Compose and send the one draft whose send COMPLETES — a first message, with a
 * first-turn call that resolves.
 *
 * Both calls land, so this is the only path in these suites that reaches the
 * settlement: `sendNewSessionDraft` reports `sent` exactly when neither leg refused.
 */
export async function composeAndCompleteASend(): Promise<void> {
  await openDraftWithFirstTurn();
  await press("Send");
}

/**
 * The fixture with its create scripted and every request body recorded.
 *
 * A pass-through arm rather than an answering one: what a case reads here is what the
 * control ASKED for, and a bridge that answered on its own would be recording requests
 * nothing ever sent. `withDaemonCall` is the console's one seam for that, so a case
 * asserting over request bodies drives the same `callDaemon` path production does.
 */
export function bridgeRecordingASend(): BridgeUnderTest {
  return withDaemonCall(
    bridgeFor({ scriptsCreate: true }),
    async (_call, passThrough) => await passThrough(),
  );
}
