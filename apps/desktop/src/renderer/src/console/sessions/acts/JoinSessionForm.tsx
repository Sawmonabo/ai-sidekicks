// Join a session somebody else is already in.
//
// `session.join` is REGISTERED — `packages/contracts` publishes its request and reply
// schemas and the console's call door binds it — so this control is a wire the
// console has rather than one it is waiting on, and it renders no growth-slate
// absence. It sits beside the start control because the two are the same question
// answered twice: the work either does not exist yet, or it exists somewhere else.
//
// WHAT THE FORM ASKS FOR IS WHAT THE WIRE TAKES, and no more: the session's
// identifier and the handle the caller will appear under. Neither is invented and
// neither is defaulted — a handle this console guessed would put a name in a roster
// that its owner never chose, and a session id it inferred would join the wrong
// session silently.
//
// EVERY ARM RENDERS. Unattempted is the form; running disables the control and says
// so; a refusal is the daemon's own sentence against the field that earned it; and a
// settled join navigates, because a join whose only evidence is a form that cleared
// itself is indistinguishable from one that did nothing.
//
// THE NAVIGATION IS RETIRED WHEN THE FORM GOES AWAY. `onJoined` moves the whole
// window, and a slow join that settles after the person has disclosed the form shut
// or left the sessions destination would yank them into a workspace they are no
// longer asking for. Nothing behind the bridge is cancellable, so the call is not
// stopped — the CONTINUATION is retired, through the mount-scoped generation latch
// `store/generation-latch.ts` owns. The act's own settlement still installs (it is
// held on the bridge and survives the mount); only the navigation is dropped.
//
// AND IT IS NEVER RETIRED BY A SECOND PRESS. The claim is taken with `claim`, which
// REFUSES while one is held, and never with `supersedeAndClaim`. Two submissions can
// reach one rendered handler before the disabled state commits — that is the whole
// reason the latch is consulted in the handler rather than a rendered flag — and a
// superseding claim retired the FIRST join's navigation on the way past: the second
// press then read the act as already running and went nowhere, and the join that
// actually landed could no longer settle its own claim. The person was left in a
// session they had durably joined, on a form that said nothing, with neither the
// navigation nor the directory refresh `onJoined` performs. Refusing costs that press
// nothing a person can see: the act would have refused it audibly anyway, and the
// control it was pressed on is disabled by the `running` arm on the next commit.

import { useMemo, useState } from "react";

import { SessionAct, useSessionAct } from "./act-settlement.js";
import { InlineRefusal } from "../../primitives/index.js";
import { callDaemon, type ConsoleBridge } from "../../bridge/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../store/index.js";
import type { SessionId, SessionJoinResponse } from "@ai-sidekicks/contracts";

/** The holder key this form's one act is addressed by, within a bridge. */
const JOIN_ACT_KEY = "session-join";

export interface JoinSessionFormProps {
  readonly bridge: ConsoleBridge;
  /** Where a settled join goes. The same navigation a row press performs. */
  readonly onJoined: (sessionId: string) => void;
  /**
   * Why the control cannot be pressed, or `undefined` where it can.
   *
   * A SENTENCE AND NEVER A BOOLEAN, because a disabled control with no cause is the
   * shape `Spec-023 §Console Design (Meridian)` forbids: a person reads it as broken.
   * The only cause today is the degraded list, whose own sentence is composed once in
   * `session-list-degradation.ts` and handed down.
   */
  readonly blockedReason?: string | undefined;
}

export function JoinSessionForm(props: JoinSessionFormProps): React.JSX.Element {
  const { bridge, onJoined, blockedReason } = props;
  const [sessionId, setSessionId] = useState("");
  const [identityHandle, setIdentityHandle] = useState("");
  // Keyed on the BRIDGE rather than held for the life of the mount, which is the
  // console's one rule for state addressed by a subject: a `useState` initializer
  // closing over the bridge stays bound to the one the window closed when the bridge
  // or the scenario moved, and the form would then put its next join through a
  // transport nothing is listening on. `store/subject-scoped-state.ts` is the one
  // holder for that, so this act is re-minted during the render that first sees a new
  // bridge and never one commit later.
  const join = useSubjectScopedState(
    bridge,
    JOIN_ACT_KEY,
    () =>
      new SessionAct<{ sessionId: SessionId; identityHandle: string }, SessionJoinResponse>({
        attempt: async (request) => await callDaemon(bridge, "session.join", request),
        describeWhat: "The join",
      }),
  ).value;
  const settlement = useSessionAct(join);
  // The mount's own register, superseded wholesale by its unmount. It answers one
  // question — may THIS submission still navigate — and it is deliberately not the
  // act's single flight, which the act already owns and which is keyed on the bridge
  // rather than on the mount.
  const navigationLatch = useGenerationLatch();

  const trimmedSessionId = sessionId.trim();
  const trimmedHandle = identityHandle.trim();
  const isRunning = settlement.status === "running";
  const isIncomplete = trimmedSessionId.length === 0 || trimmedHandle.length === 0;
  const disabledReason = useMemo(() => {
    if (blockedReason !== undefined) {
      return blockedReason;
    }
    if (isRunning) {
      return "The last join is still running.";
    }
    return isIncomplete ? "Both the session and the handle are needed." : undefined;
  }, [blockedReason, isRunning, isIncomplete]);

  return (
    <form
      className="meridian-session-join"
      aria-label="Join a session"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabledReason !== undefined) {
          return;
        }
        // Taken BEFORE the call, so the round this settlement is measured against is
        // the one that dispatched it, and so the unmount can retire it. Refused
        // rather than superseded while a join this mount put is still out: the join
        // that is running is the one the person is waiting on, and the newest press
        // has nothing to add to it. Nothing is dispatched on that arm either — a
        // second `run` would return the act's own duplicate refusal and then settle
        // against a reading of an act still in flight.
        const navigation = navigationLatch.claim(bridge, JOIN_ACT_KEY);
        if (navigation === undefined) {
          return;
        }
        void join
          .run({ sessionId: typedSessionId(trimmedSessionId), identityHandle: trimmedHandle })
          .then(() => {
            navigation.settle(() => {
              const settled = join.settlement();
              if (settled.status === "settled") {
                onJoined(settled.answer.sessionId);
              }
            });
          })
          // The key goes back on both arms, settled or thrown, so a call that ends in
          // neither of the act's two settlements cannot leave this form refusing
          // every later press for the life of the mount.
          .finally(() => {
            navigation.release();
          });
      }}
    >
      <label className="meridian-session-join__field">
        <span className="meridian-session-join__label">Session</span>
        <input
          className="meridian-session-join__input"
          value={sessionId}
          disabled={isRunning}
          placeholder="The identifier you were given"
          onChange={(event) => {
            setSessionId(event.target.value);
          }}
        />
      </label>
      <label className="meridian-session-join__field">
        <span className="meridian-session-join__label">Your handle</span>
        <input
          className="meridian-session-join__input"
          value={identityHandle}
          disabled={isRunning}
          placeholder="How the others will see you"
          onChange={(event) => {
            setIdentityHandle(event.target.value);
          }}
        />
      </label>
      <button
        type="submit"
        className="meridian-session-join__submit"
        disabled={disabledReason !== undefined}
        title={disabledReason}
      >
        {isRunning ? "Joining…" : "Join"}
      </button>
      {disabledReason === undefined ? null : (
        <p className="meridian-session-join__blocked">{disabledReason}</p>
      )}
      {settlement.status === "refused" ? <InlineRefusal {...settlement.refusal} /> : null}
    </form>
  );
}

/**
 * The identifier a person typed, as the marker the request schema expects.
 *
 * The console never MINTS a session id — `repos/repo-reads.ts` states that rule for
 * an id it was handed — and this is the one place a person supplies one instead. The
 * cast is safe because it decides nothing: `callDaemon` parses the request against
 * `SessionIdSchema` before it sends, so a string that is not an identifier refuses
 * with the call door's own `request-unsendable` and reaches no wire.
 */
function typedSessionId(value: string): SessionId {
  return value as SessionId;
}
