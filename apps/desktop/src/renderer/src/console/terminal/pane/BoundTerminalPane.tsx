// The terminal pane once a session is addressed.
//
// Split from `TerminalPane.tsx` because the store hooks below may only be called when
// there IS a store, and a hook behind a condition is the one React rule a surface
// cannot bend. The split makes the condition a MOUNT rather than a branch inside one
// render — and it is a file boundary rather than a second component in one module,
// which is the same rule stated one level up.
//
// THE TERMINAL'S IDENTITY. `Spec-023 §Console Design (Meridian)` 8.8 and
// `Spec-003 §Required Behavior` give a session exactly one shared terminal — not one
// per node and not one per pane — and both registered lease methods are
// session-scoped. So the session id IS this terminal's identity in the console's own
// request shapes; it is not a fabricated key, it is the name of the session's single
// shell.
//
// THE VIEWER IS READ, NOT ASSUMED. `callerParticipantRead` is the port's answer to
// which entry in this session's roster this window is, and the fold takes it as the
// input that tells `held-by-you` from `held-by-another`. It used to take a hard-coded
// `undefined`, which made every take the claimant's own lease read as somebody else's:
// the person the daemon had just granted the shell to kept seeing Claim, could not
// release, and typed into nothing. While the read is out — or when it is refused — the
// claim control is WITHHELD rather than offered on a guess, and the fold still gets no
// viewer, so the fail-closed direction is unchanged.
//
// THE HOST'S REACHABILITY IS PROJECTED, NOT ASSUMED. 8.8's degraded state is a holder
// whose node has gone offline, and the lease events carry no node — so this pane folds
// the log's registered `runtime_node.*` presence events beside the lease and hands the
// result in as the vouching input. It answers only where the session has exactly one
// attached node, because that is the only case in which the wire leaves no doubt about
// which host runs the session's single shared shell; `node-presence-model.ts` states
// the rule and why the payload's `actor` is not a substitute for the link the wire
// withholds.
//
// WHY THE EMULATOR IS MOUNTED WITH NOTHING TO SHOW. An empty grid asserts nothing
// about this session — it is a viewport, and the line above it says in words that no
// stream is registered, so no reader can take the emptiness for "the shell printed
// nothing". Mounting it is also what makes the surface honest in the other direction:
// the pane a person sees is the pane that will carry the bytes, at the size and the
// renderer it will carry them at, rather than a placeholder that gets swapped for
// something with different behaviour on the day the wire lands.

import { useCallback, useMemo } from "react";

import { membershipRoleOf, type ConsoleBridge } from "../../bridge/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import {
  useCallerMembershipRole,
  useSessionStore,
  type CallerParticipantReader,
  type SessionStore,
  type SessionStoreState,
} from "../../store/index.js";
import { LeaseLine } from "../LeaseLine.js";
import type { TerminalParticipantMark } from "../participant-mark.js";
import { XtermHost } from "../XtermHost.js";
import { projectTerminalLease, type TerminalLeaseState } from "../lease-model.js";
import { projectNodePresence, resolveSoleHoldingNode } from "../node-presence-model.js";
import { useTerminalOutputStream } from "../output-stream.js";
import { useTerminalViewerIdentity } from "../viewer-identity.js";
import { TERMINAL_OUTPUT_LABEL } from "./terminal-pane-labels.js";

export interface BoundTerminalPaneProps {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}

/** Stored reference, never a built value — the store's own equality rests on it. */
function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}

export function BoundTerminalPane(props: BoundTerminalPaneProps): React.JSX.Element {
  const { bridge, sessionStore } = props;
  // The session's id, read once. V1 gives a session one shared shell, so this is also
  // the terminal's id — and naming it here is what lets every subject-keyed hook and
  // callback below take the same identifier rather than re-reading the store.
  const sessionId = sessionStore.sessionId;
  const timeline = useSessionStore(sessionStore, selectTimeline);
  const outputReading = useTerminalOutputStream(bridge, sessionId);
  const viewerIdentity = useTerminalViewerIdentity(bridge, sessionId);
  // The entitlement beside the identity, because the claim control needs both: the
  // fold compares the holder against WHO this window is, and the daemon checks what
  // that participant MAY DO before it moves the shell. The reader is adapted here
  // because `store/` sits below `bridge/` on the console's DAG and may not reach a
  // port; the served arm hands over the participant id and the refusing arm travels
  // as the `ConsoleRefusal` it already is.
  const readCallerParticipant: CallerParticipantReader = useCallback(async () => {
    const outcome = await bridge.growth.callerParticipantRead({ sessionId });
    return outcome.status === "served" ? outcome.value.participantId : outcome;
  }, [bridge, sessionId]);
  const callerRole = useCallerMembershipRole(readCallerParticipant, sessionStore, membershipRoleOf);

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
        sessionId={sessionId}
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
        terminalId={sessionId}
        isWriteEnabled={lease.holding === "held-by-you"}
        label={TERMINAL_OUTPUT_LABEL}
      />
    </>
  );
}
