// The per-device fan-out behind one person's aggregated presence state.
//
// ADDRESSED BY A SUBJECT, AND ASKED ONLY WHEN SOMEBODY ASKS. The roster shows the
// aggregate for everyone; this is the detail behind one row, read when that row is
// opened and never before. Reading it for every row on mount would ask an
// owner/operator-only question about every person in the session in order to render
// something nobody has looked at.
//
// AND KEPT CURRENT FOR AS LONG AS THAT ROW IS OPEN, which is the half a one-shot read
// could not do. A person's devices connect, go idle, and drop while the panel is
// expanded, and the roster row directly above this list is push-driven — it re-reads on
// every `presence.subscribe` signal. So a fan-out asked once, at the instant the row was
// opened, put two readings of one person's presence on one screen and let them disagree,
// with the newer one on the row and the older one under it, for as long as somebody left
// it open. The detail now answers the same signal the roster does, through the seat that
// owns subscribe-then-read: one read per burst on the refresh chokepoint, no poll, no
// second copy of the publisher's model, and no flicker back to the unread state while a
// refresh is in flight.
//
// A READ PER OPEN ROW, AND THE CLOSED ROW IS A READ TOO. The subject is the (session,
// participant) pair, so opening a different row is a different read with its own
// subscription and the previous one is disposed. A row nobody has opened is the same
// model addressed at nothing: it subscribes to nothing and asks nothing, which is why
// the value it answers with is `undefined` rather than an invented empty fan-out.
//
// THE REFUSAL IS THE CONTRACT'S OWN, AND IT IS NOT AN ERROR. `Spec-018` makes the
// aggregated summary the UNAUTHORIZED-DEFAULT projection: a caller who may not see
// the fan-out is not told less than the truth, they are told the summary, which is
// exactly what the roster row already shows. So `presence.permission_denied` renders
// as one sentence saying the detail is not this caller's to see, never as a refusal
// card, and never as a reason to disturb the row it opened from.
//
// AND THE AGGREGATE IS CARRIED BUT NOT PREFERRED. The reply states the aggregate it
// fans out from, and the row beside it already has one from `presence.read`. Where
// they disagree the ROW's is kept — this read is the detail behind the summary, not
// a second answer to it.

import { useCallback, useEffect } from "react";

import {
  PRESENCE_EVENT_STREAM,
  consoleClockFor,
  type ConsoleBridge,
  type GrowthPresenceDetail,
} from "../../bridge/index.js";
import type { ConsoleClock, ConsoleRefusal } from "../../core/index.js";
import {
  PushDrivenRead,
  servedGrowthValueOrRaise,
  subscribeDaemonEvent,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "../../seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../store/index.js";

/** Names this read in a refusal the call itself did not name. */
export const PRESENCE_DETAIL_ORIGIN = "presence-detail";

/**
 * The refusal code that means "you get the summary", not "something went wrong".
 *
 * Registered under `Spec-018` and rendered as a sentence rather than as a card. It is
 * compared against the code the daemon sent and never produced: the console does not
 * raise refusals, it recognises them.
 */
export const PRESENCE_PERMISSION_DENIED_CODE = "presence.permission_denied";

/**
 * What this read is about: one participant, in one session.
 *
 * BOTH HALVES, because a detail read is about a participant IN a session and a request
 * carrying only the participant would hold an answer from the session being left under
 * a key the arriving session reads as current.
 */
export interface PresenceDetailRequest {
  readonly sessionId: string;
  readonly participantId: string;
}

/** One open row's live fan-out read. `undefined` is the answer for a row nobody opened. */
export type PresenceDetailRead = PushDrivenRead<GrowthPresenceDetail | undefined>;

/** What an opened row holds for that read at any moment. */
export type PresenceDetailState = PushDrivenReadState<GrowthPresenceDetail | undefined>;

/**
 * Build the fan-out read for one row, or for no row at all.
 *
 * Constructed by whoever owns its lifetime — the resource seam below, never a render
 * body — exactly as the presence roster and the terminal-control holder beside it are.
 *
 * THE NO-ROW ARM IS A READ AND NOT A PLACEHOLDER. A hook cannot be called
 * conditionally, so a section with no row expanded still holds one of these; it
 * subscribes to nothing and its read answers `undefined`, which is the honest reading
 * — nobody asked about anybody — and never an empty device list, which would say a
 * person is on no device.
 */
export function createPresenceDetailRead(options: {
  readonly bridge: ConsoleBridge;
  readonly request: PresenceDetailRequest | undefined;
  readonly clock: ConsoleClock;
}): PresenceDetailRead {
  const { bridge, request, clock } = options;
  return new PushDrivenRead<GrowthPresenceDetail | undefined>({
    clock,
    origin: PRESENCE_DETAIL_ORIGIN,
    read: async () =>
      request === undefined
        ? undefined
        : servedGrowthValueOrRaise(await bridge.growth.participantPresenceDetailRead(request)),
    // The same stream the roster above this list reads, and the payload is typed
    // `void`: the push is a signal, and what the devices are now is what the read
    // answers. There is no binding here to open a frame with.
    subscribe:
      request === undefined
        ? () => () => undefined
        : (onChangeSignal) =>
            subscribeDaemonEvent<void>(bridge, PRESENCE_EVENT_STREAM, onChangeSignal),
  });
}

/**
 * The read's own disposal, as one module-level object.
 *
 * Minted once rather than in a render body, because the resource seam holds `dispose`
 * and `isClosed` on dependencies of their own and a fresh literal each pass would
 * restart the lifetime beneath it.
 */
const PRESENCE_DETAIL_DISPOSAL: SubjectScopedDisposal<PresenceDetailRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/**
 * Read one participant's device fan-out for as long as their row is the open one.
 *
 * Held through the resource seam rather than a `useMemo` and a cleanup: the read owns
 * a subscription and a scheduler, so it is exactly the class of value that seam exists
 * to close exactly once — including under a row closed, a row swapped for another, and
 * a session left beneath a live mount.
 */
export function usePresenceDetail(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
  participantId: string | undefined,
): PresenceDetailState {
  const subject =
    sessionId === undefined || participantId === undefined
      ? undefined
      : `${sessionId} ${participantId}`;
  // Resolved inside the resource's own `open`, which runs once per subject: the live
  // arm of `consoleClockFor` MINTS, so reading it in a render body would hand this
  // `dispose()`-bearing read a fresh clock identity on every pass.
  const openRead = useCallback(
    () =>
      createPresenceDetailRead({
        bridge,
        request:
          sessionId === undefined || participantId === undefined
            ? undefined
            : { sessionId, participantId },
        clock: consoleClockFor(bridge),
      }),
    [bridge, sessionId, participantId],
  );
  const { value: read } = useSubjectScopedResource(
    bridge,
    subject,
    openRead,
    PRESENCE_DETAIL_DISPOSAL,
  );
  useEffect(() => {
    // In an effect and not in the render body: `start` opens a subscription and puts a
    // call on the wire, and a render React discards must do neither.
    read.start();
  }, [read]);
  return usePushDrivenRead(read);
}

/** The served fan-out, or `undefined` on every arm that is not a served answer. */
export function presenceDetailValue(state: PresenceDetailState): GrowthPresenceDetail | undefined {
  return state.kind === "loaded" ? state.value : undefined;
}

/** Why the fan-out is not here, or `undefined` where it is or is still coming. */
export function presenceDetailRefusal(state: PresenceDetailState): ConsoleRefusal | undefined {
  return state.kind === "failed" ? state.refusal : undefined;
}

/**
 * Whether a refusal is the authorization answer rather than a failure.
 *
 * One predicate rather than a comparison at each render site, because the two
 * renderings are different SHAPES — a sentence and a refusal line — and a surface
 * that spelled the code itself would be the second place this distinction lives.
 */
export function isPresenceDetailUnauthorized(refusal: ConsoleRefusal | undefined): boolean {
  return refusal?.code === PRESENCE_PERMISSION_DENIED_CODE;
}
