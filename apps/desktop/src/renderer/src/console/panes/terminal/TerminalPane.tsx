// The terminal pane: the session's one shared shell, its lease, and the emulator
// that shows it.
//
// WHAT IS LIVE HERE AND WHAT IS NOT. The lease is wire-true today —
// `pty.control_changed` is a registered event type carrying the holder, the holder
// it replaced, and a closed five-member reason — so the holder line, the transition
// ledger, and every state 8.8 names are folded from the session log by
// `lease-model.ts` and are not fixtures. The OUTPUT is not: the byte stream, the
// scrollback, and the resize report are `Plan-023 §Console growth slate` row 3,
// which the growth port refuses by name. So the pane asks for the stream, renders
// the refusal it gets, and mounts the emulator empty.
//
// WHY THE EMULATOR IS MOUNTED WITH NOTHING TO SHOW. An empty grid asserts nothing
// about this session — it is a viewport, and the line above it says in words that
// no stream is registered, so no reader can take the emptiness for "the shell
// printed nothing". Mounting it is also what makes the surface honest in the other
// direction: the pane a person sees is the pane that will carry the bytes, at the
// size and the renderer it will carry them at, rather than a placeholder that gets
// swapped for something with different behaviour on the day the wire lands.
//
// DELETION OBLIGATION. When slate row 3 leaves the table, the served arm of
// `terminalSubscribeOutput` drains into the emulator (an addition to `XtermHost`,
// which owns the adapter) and the refusal line below goes with the row. Nothing
// else on this surface moves.
//
// THE TERMINAL'S IDENTITY. `Spec-023 §Console Design (Meridian)` 8.8 and
// `Spec-003 §Required Behavior` give a session exactly one shared terminal — not
// one per node and not one per pane — and both registered lease methods are
// session-scoped. So the session id IS this terminal's identity in the console's
// own request shapes; it is not a fabricated key, it is the name of the session's
// single shell.
//
// THE VIEWER IS READ, NOT ASSUMED. `callerParticipantRead` is the port's answer to
// which entry in this session's roster this window is, and the fold takes it as the
// input that tells `held-by-you` from `held-by-another`. It used to take a
// hard-coded `undefined`, which made every take the claimant's own lease read as
// somebody else's: the person the daemon had just granted the shell to kept seeing
// Claim, could not release, and typed into nothing. While the read is out — or when
// it is refused — the claim control is WITHHELD rather than offered on a guess, and
// the fold still gets no viewer, so the fail-closed direction is unchanged.
//
// THE HOST'S REACHABILITY IS PROJECTED, NOT ASSUMED. 8.8's degraded state is a
// holder whose node has gone offline, and the lease events carry no node — so this
// pane folds the log's registered `runtime_node.*` presence events beside the lease
// and hands the result in as the vouching input. It answers only where the session
// has exactly one attached node, because that is the only case in which the wire
// leaves no doubt about which host runs the session's single shared shell;
// `node-presence-model.ts` states the rule and why the payload's `actor` is not a
// substitute for the link the wire withholds.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { refusalFromRejection, type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import {
  useCallerMembershipRole,
  useSessionStore,
  type SessionStore,
  type SessionStoreState,
} from "../../store/index.js";
import type { ConsolePaneContext } from "../../seats/index.js";
import { LeaseLine, type TerminalParticipantMark } from "../../terminal/LeaseLine.js";
import { XtermHost } from "../../terminal/XtermHost.js";
import { projectTerminalLease, type TerminalLeaseState } from "../../terminal/lease-model.js";
import { projectNodePresence, resolveSoleHoldingNode } from "../../terminal/node-presence-model.js";
import { useTerminalViewerIdentity } from "../../terminal/viewer-identity.js";

/**
 * What the pane reads off the deck's context, and nothing more.
 *
 * A `Pick` rather than the whole `ConsolePaneContext`, on `BrowserPane`'s rule
 * that a parameter destructured to satisfy a convention is a claim that the body
 * uses it. The registry's `render` still accepts this component, because a context
 * satisfies the narrower shape.
 */
export type TerminalPaneProps = Pick<ConsolePaneContext, "paneId" | "bridge" | "sessionStore">;

/** The pane region's accessible name. */
const TERMINAL_PANE_LABEL = "Terminal";

/** Stored reference, never a built value — the store's own equality rests on it. */
function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}

export function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const { bridge, sessionStore } = props;
  return (
    <section className="meridian-terminal-pane" aria-label={TERMINAL_PANE_LABEL}>
      {sessionStore === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This pane is not bound to a session."
          detail="A session's shared shell is reached through the session it belongs to, and this pane was opened without one. Nothing here says the session has no terminal — only that none was addressed."
        />
      ) : (
        <BoundTerminalPane bridge={bridge} sessionStore={sessionStore} />
      )}
    </section>
  );
}

/**
 * The pane once a session is addressed.
 *
 * Split from the component above because the store hooks below may only be called
 * when there IS a store, and a hook behind a condition is the one React rule a
 * surface cannot bend. The split makes the condition a mount rather than a branch
 * inside one render.
 */
function BoundTerminalPane(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const { bridge, sessionStore } = props;
  const terminalId = sessionStore.sessionId;
  const timeline = useSessionStore(sessionStore, selectTimeline);
  const outputReading = useTerminalOutputStream(bridge, terminalId);
  const viewerIdentity = useTerminalViewerIdentity(bridge, sessionStore.sessionId);
  // The entitlement beside the identity, because the claim control needs both: the
  // fold compares the holder against WHO this window is, and the daemon checks what
  // that participant MAY DO before it moves the shell. The reader is adapted here
  // because `store/` sits below `bridge/` on the console's DAG and may not reach a
  // port; the served arm hands over the participant id and the refusing arm travels
  // as the `ConsoleRefusal` it already is.
  const readCallerParticipant = useCallback(async () => {
    const outcome = await bridge.growth.callerParticipantRead({
      sessionId: sessionStore.sessionId,
    });
    return outcome.status === "served" ? outcome.value.participantId : outcome;
  }, [bridge, sessionStore]);
  const callerRole = useCallerMembershipRole(readCallerParticipant, sessionStore);

  // Derivation under `useMemo`, which is where `store/hooks.ts` puts it: the
  // selector returns the stored array and the fold runs only when that array's
  // identity changes.
  //
  // The host's reported reachability comes off the SAME log, folded separately and
  // handed to the lease fold as its vouching input. Without it the pane could only
  // ever pass `not-checked`, and a shell whose machine had gone silent kept showing
  // the holder from the last take and reading as writable.
  const holdingNode = useMemo(
    () => resolveSoleHoldingNode(projectNodePresence(timeline)),
    [timeline],
  );

  // The viewer the fold compares the holder against, and only on the READ arm: a
  // pending or refused identity passes `undefined`, which keeps every held lease at
  // `held-by-another` and the emulator read-only. The claim control is withheld on
  // those same two arms, so the surface never offers an act it could not attribute.
  const viewerParticipantId =
    viewerIdentity.status === "read" ? viewerIdentity.participantId : undefined;

  const lease: TerminalLeaseState = useMemo(
    () =>
      projectTerminalLease(timeline, {
        viewerParticipantId,
        // Omitted rather than passed as `undefined`, because the member's absence is
        // what the fold reads as "nothing was checked".
        ...(holdingNode === undefined ? {} : { holdingNode }),
      }),
    [timeline, holdingNode, viewerParticipantId],
  );

  const markFor = useMemo(() => {
    const allocator = sessionStore.hueAllocator;
    return (participantId: string): TerminalParticipantMark | undefined => {
      const assignment = allocator.assignmentFor(participantId);
      return assignment === undefined
        ? undefined
        : {
            hueStep: assignment.step,
            ringTreatment: assignment.ringTreatment,
            // No projector claims `participant.joined` yet, so the roster supplies
            // no name and the surface renders the wire id rather than inventing one.
            displayName: undefined,
          };
    };
  }, [sessionStore]);

  return (
    <>
      <LeaseLine
        bridge={bridge}
        sessionId={sessionStore.sessionId}
        state={lease}
        markFor={markFor}
        viewerIdentity={viewerIdentity}
        callerRole={callerRole}
      />
      {outputReading.status === "refused" ? (
        // A REJECTED subscribe is the bridge itself failing, and a bridge that
        // failed with `{ code, message }` — a denied permission, a transport that
        // went away — is telling the person what to do next. The refusal grammar is
        // what puts that code on screen verbatim; an absence would put a sentence
        // this pane wrote where the wire's own diagnosis belongs.
        <InlineRefusal code={outputReading.refusal.code} detail={outputReading.refusal.detail} />
      ) : (
        /* `surface`, not `inline`: the badge form carries its detail on a `title`
           attribute, and the sentence that keeps an empty grid from reading as "the
           shell printed nothing" is exactly the part a tooltip would hide. */
        <Nothing
          kind={outputReading.absence.kind}
          placement="surface"
          title={outputReading.absence.title}
          detail={outputReading.absence.detail}
        />
      )}
      <XtermHost
        terminalId={terminalId}
        isWriteEnabled={lease.holding === "held-by-you"}
        label={`${TERMINAL_PANE_LABEL} output`}
      />
    </>
  );
}

/**
 * Ask for the output stream and render what the answer was.
 *
 * The call is made rather than assumed refused: the port is what says whether a
 * wire is registered, and a surface that skipped the call and hard-coded the
 * absence would keep rendering it for a day after the wire landed. While the call
 * is out the honest reading is that nothing has been established, which is the
 * "computing" absence rather than an empty stream.
 */
function useTerminalOutputStream(bridge: ConsoleBridge, terminalId: string): TerminalOutputReading {
  const [stamped, setStamped] = useState<StampedTerminalOutputReading | undefined>(undefined);

  useEffect(() => {
    let isMounted = true;
    const publish = (reading: TerminalOutputReading): void => {
      setStamped({ bridge, terminalId, reading });
    };
    void bridge.growth
      .terminalSubscribeOutput({ terminalId })
      .then((outcome) => {
        if (outcome.status === "served") {
          // Unreachable at this revision, and not silently dropped: the stream is
          // closed rather than leaked. The deletion obligation in this file's
          // header is what replaces this arm with a drain into the emulator.
          outcome.value.close();
        }
        if (!isMounted) {
          return;
        }
        publish(
          outcome.status === "unavailable"
            ? absent({ kind: "not-checked", title: "No output stream", detail: outcome.detail })
            : absent({
                kind: "not-checked",
                title: "Output stream not drained",
                detail:
                  "The stream was served, and this revision has no consumer for it. The pane closed it rather than holding a subscription nothing reads.",
              }),
        );
      })
      .catch((failure: unknown) => {
        if (isMounted) {
          publish({
            status: "refused",
            refusal: refusalFromRejection(
              OUTPUT_STREAM_REFUSAL_ORIGIN,
              failure,
              OUTPUT_STREAM_REJECTION_FALLBACK,
            ),
          });
        }
      });
    return () => {
      isMounted = false;
    };
  }, [bridge, terminalId]);

  // The comparison the stamp exists for, on the render that mounts the emulator
  // rather than one after it.
  return stamped !== undefined && stamped.bridge === bridge && stamped.terminalId === terminalId
    ? stamped.reading
    : ASKING_FOR_OUTPUT;
}

/**
 * A settled output reading together with the inputs it was read against.
 *
 * The reading is a fact about ONE shell on ONE bridge, and `BoundTerminalPane`
 * outlives both: a deck that hands the same instance a different bridge or a
 * different session store replaces the effect while the state still holds the
 * previous terminal's answer, and the mount flag cannot help — it is the flag of the
 * effect that is being torn down, and its cleanup runs a pass AFTER the render that
 * has already put the previous shell's absence or refusal on screen for the
 * replacement. A promise from the retired subject can also settle in that same
 * window, before the cleanup that would have flipped the flag.
 *
 * So the reading travels with its subject and the render compares, which is the
 * shape `terminal/viewer-identity.ts` and `browser/navigation-state.ts` already
 * take. A mismatch reads `ASKING_FOR_OUTPUT` — the honest state for a question that
 * has just been put and not yet answered — rather than the previous shell's.
 */
interface StampedTerminalOutputReading {
  readonly bridge: ConsoleBridge;
  readonly terminalId: string;
  readonly reading: TerminalOutputReading;
}

/**
 * The subsystem name every refusal this read raises itself carries.
 *
 * `LeaseLine`'s reason, applied to the other half of this pane: `core/refusal.ts`
 * is the console's one normalizer, and it is what keeps the wire's own code on
 * screen. This arm used to build its own title-plus-stringified-payload pair, so a
 * `permission_denied` and a torn-down transport reached the operator as the same
 * generic sentence with the actionable half serialized into JSON beside it.
 */
const OUTPUT_STREAM_REFUSAL_ORIGIN = "terminal-output";

/**
 * What a rejection carrying NO code of its own says instead.
 *
 * The normalizer spends this only on its fourth arm — a wire envelope, a console
 * refusal, and a `ConsoleRefusalError` all keep what they came with. A codeless
 * rejection here means the bridge never answered at all, and naming the next move
 * beats reporting a transport's own message about a channel a person cannot see.
 */
const OUTPUT_STREAM_REJECTION_FALLBACK = {
  code: "terminal-output-unreachable",
  detail:
    "The console asked this session's shell for its output stream and the bridge never answered. Reopening this pane asks again.",
} as const;

/** What the output line says, as data — so the effect sets a value, not a tree. */
interface TerminalOutputAbsence {
  readonly kind: "computing" | "not-checked";
  readonly title: string;
  /** Always present: every arm here has something to say, and a silent one would
   *  leave the reader with a state name and no next move. */
  readonly detail: string;
}

/**
 * What the read settled as: an ABSENCE the console can describe, or a REFUSAL the
 * wire authored.
 *
 * Two arms rather than a third `kind` on the absence, because they are two
 * different renderings under rule 9 — an absence says what is not here, a refusal
 * carries a machine-readable code the operator acts on — and folding a refusal
 * into an absence is what threw that code away.
 */
type TerminalOutputReading =
  | { readonly status: "absent"; readonly absence: TerminalOutputAbsence }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

function absent(absence: TerminalOutputAbsence): TerminalOutputReading {
  return { status: "absent", absence };
}

const ASKING_FOR_OUTPUT: TerminalOutputReading = absent({
  kind: "computing",
  title: "Asking for the output stream",
  detail:
    "The console has asked the bridge whether this session's shell streams output here, and is waiting for the answer.",
});
