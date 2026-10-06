// What both new-session control suites mount: the held and queued variants of the draft
// suites' bridge that the ordering cases need, and the presses that drive them.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { withDaemonCall } from "#test/helpers/fixture/bridge.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import type { FirstTurnQueueCall } from "../control-contract.js";
import { NewSessionControl } from "./NewSessionControl.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
// The bridge and the reply from the draft suites' module, so one reply has one spelling.
import {
  CREATE_REPLY,
  CREATED_SESSION_ID,
  NEW_SESSION_LEAD,
  bridgeFor,
  type QueuedFirstTurn,
} from "../draft.test-support.js";
import { SESSION_CREATE_METHOD } from "../settlement.js";

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
 * A first-turn call that resolves, and the requests it was asked to queue. Its resolving is
 * what makes a completed send reachable: with the rejecting call every send settles `partial`.
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
 * The control under the window's announcer, where the frame mounts it. The settlement is an
 * option with a default that records nothing, because the destination hands one over on every
 * mount. The first-turn call defaults to the rejecting one, so a send stops after the create
 * unless a case says otherwise.
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
        lead={NEW_SESSION_LEAD}
        onSessionCreated={options.onSessionCreated ?? (() => undefined)}
        onSessionDirectoryRecheck={options.onSessionDirectoryRecheck ?? (() => undefined)}
      />
    </LiveAnnouncerProvider>,
  );
  return container;
}

/** Render the control against a bridge that scripts (or not) the create. */
export function renderControl(options: { readonly scriptsCreate: boolean }): HTMLElement {
  return renderControlOn(bridgeFor(options));
}

/**
 * A bridge whose `session.create` fulfills with a reply the registered schema refuses. Short
 * of `state`, so `callDaemon` answers `reply-unreadable`: the daemon answered and only this
 * build's reading failed, which leaves a session that may exist with no name this window holds.
 */
export function bridgeAnsweringCreateUnreadably(): PlatformBridge {
  const { bridge } = withDaemonCall(bridgeFor({ scriptsCreate: true }), async () => ({
    sessionId: CREATED_SESSION_ID,
  }));
  return bridge;
}

/**
 * The fixture bridge with its `session.create` suspended until told to answer. A send that
 * resolves within one microtask cannot be observed mid-flight, and "Send is disabled while a
 * send is running" is a claim about that moment. Only the timing is the test's; the reply is
 * `CREATE_REPLY`.
 */
export function bridgeHoldingCreate(): HeldCreate {
  let answer = (): void => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { bridge } = withDaemonCall(
    bridgeFor({ scriptsCreate: true }),
    async (call, passThrough) => {
      if (call.method !== SESSION_CREATE_METHOD) {
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
 * {@link bridgeHoldingCreate} holds them behind one promise, which cannot show an old draft's
 * send settling while a new one still runs, where a shared flag and an unguarded continuation
 * do their damage.
 */
export function bridgeQueueingCreates(): QueuedCreates {
  const suspended: (() => void)[] = [];
  const { bridge } = withDaemonCall(
    bridgeFor({ scriptsCreate: true }),
    async (call, passThrough) => {
      if (call.method !== SESSION_CREATE_METHOD) {
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
 * Press a control and let React finish reacting. Unwrapped, an assertion would read a tree one
 * render behind, and the send's promise would resolve outside `act`.
 */
export async function press(name: string | RegExp): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name }).click();
    await crossMacrotaskBoundary();
  });
}

/** The text of the polite live region. */
export function politeText(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/**
 * Open a draft and type its first message, the shortest composition that can be sent. The
 * first message is the only axis this control offers, so `first-turn-missing` is unreachable
 * here and the partial arm comes from the rejecting first-turn call; the missing-turn refusal
 * is exercised in `features/sessions/new-session/draft.test.ts`.
 */
export async function openDraftWithFirstTurn(): Promise<void> {
  await press("+ New");
  await typeFirstTurn("Start on the migration.");
}

/**
 * Type the first message through the field a person types into. `fireEvent` rather than
 * assigning `value`, since the field renders off the draft and a direct assignment would
 * leave the object that decides what is sent untouched.
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
 * Compose and send the one draft whose send completes: a first message with a first-turn call
 * that resolves. The only path here that reaches the settlement.
 */
export async function composeAndCompleteASend(): Promise<void> {
  await openDraftWithFirstTurn();
  await press("Send");
}
