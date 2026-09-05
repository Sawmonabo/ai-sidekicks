// The rail's workflows destination: the surface, and the session it reads from.
//
// WHY THIS EXISTS AT ALL. `#/workflows` is a bare route, so the surface context's
// `sessionStore` is `undefined` on it by construction — and the definition
// enumeration's request carries a REQUIRED session id. The destination therefore
// used to mount the browser with no session, the read stayed `unasked` forever, and
// the advertised rail destination rendered three empty named groups in every build
// including the fixture that scripts definitions. A surface that can never ask its
// own question is not an empty state; it is a surface with no subject.
//
// WHERE THE SUBJECT COMES FROM, IN ORDER.
//
//   1. **A session this person chose here**, held for the mount.
//   2. **The session this window last opened**, which is `FrameStore`'s
//      `lastOpenedSessionId` — a fact about where this WINDOW has been that no other
//      module records, written by every route transition that names a session and
//      read by the rail's own Workspace entry. A person who opens a session and then
//      presses the workflows destination has that session in hand, and this is the
//      module that knows it.
//   3. **Neither**, which is a question rather than an absence: `WorkflowsScopePicker`
//      offers the node's sessions and this window's open ones, and owns the three
//      different kinds of nothing that read can settle into.
//
// WHY "CHOOSE A DIFFERENT SESSION" IS A STATE AND NOT A CLEARED FIELD. The three
// sources above are three arms of one value (`destination-scope.ts`), not a chosen id
// folded over a retained one. Folded, "choose again" could only be spelled as
// "forget the choice" — which lands straight back on the retained session for anybody
// who has opened one, so the control did nothing for exactly the people most likely to
// press it. Asking is its own arm, and it outranks retention.
//
// WHY THE ARM IS A PROP AND NOT THIS COMPONENT'S STATE. The pane a person opens from
// these lists has to be handed the store of the session those lists were read from,
// and the address it is opened at names a definition or a run and never a session. So
// the answer to "which session" is needed by the surface ABOVE this one as well as by
// this one, and a copy held here would be the copy that is right — while the one the
// pane was built from was the window's retention. `WorkflowsPaneHost.tsx` holds the
// arm and this component renders it; the resolution both of them read is
// `destination-scope.ts`'s one function, so the two cannot disagree about it.
//
// WHY THE CHOICE IS NOT PERSISTED. `persistence/value-classes.ts` would admit it —
// the `selection` class takes a record of identifier-shaped strings and a session id
// is one — and it is still held for the mount, on `FrameStore`'s own recorded
// reasoning about the neighbouring fact: after a reload nothing is open, the registry
// is fresh, and a restored id would scope this surface to a session this window is not
// in and which may since have been deleted, archived, or moved to another node. The
// console would be promising something only the daemon can honour. A person who
// re-opens the console picks again, from a list the node answered a moment ago.
//
// WHAT IS ANNOUNCED, AND EXACTLY ONCE. The scope settlement — that this surface now
// reads from a named session — is the one thing a person navigating by ear cannot
// otherwise learn, because the browser under it renders the same chrome whichever
// session it is reading. It is announced when the scope first settles and when it
// settles on a DIFFERENT session, and on no re-render: a repeat would talk over the
// surface it just described. Each read under it announces its OWN settlement, which
// is a different fact from the scope and is that section's to say.
//
// WHAT THE SURFACE OPENS. Two pane kinds, both this family's: a definition name opens
// `workflow-builder` and a run name opens `workflow-run`. The opener is handed down
// rather than reached for, so the surface that mounts this destination decides where
// an opened pane lands; `WorkflowsPaneHost.tsx` is that surface today and the deck is
// that surface later, and neither fact reaches here.
//
// WHAT IT DELIBERATELY DOES NOT OPEN. It supplies no new-definition action, and that
// is this family's own absence rule rather than an omission: `definitions/DefinitionsBrowser.tsx`
// writes it out — an entry point appears when its caller supplies the action and not
// before — and the wire says this caller cannot. Ten workflow operations sit on the
// growth port and not one of them writes a definition, so a "New definition" control
// here could only open a pane with nothing to author, which is a control that leads
// nowhere. The browser's prop stays optional and unfilled: it is the mechanism, and
// the day an authoring operation is registered, filling it is that wire's act.
//
// WHAT THE SCOPE BUYS, ONCE IT HAS SETTLED. Two reads, not one: the definitions
// visible from this session, and the runs it holds. They are separate sections
// because they are separate questions with separate absences — a session can have
// definitions and no runs — and one of them refusing must not silence the other.

import { useEffect, useRef } from "react";

import type { GrowthPort } from "../bridge/index.js";
import { WireFigure, useAnnounce } from "../primitives/index.js";
import { useFrameStore, type FrameStore, type SessionStoreRegistry } from "../store/index.js";
import type { ConsolePaneOpener } from "../seats/index.js";
import {
  AWAITING_SESSION_CHOICE,
  chosenScope,
  scopeSessionIdFor,
  type WorkflowsScopeState,
} from "./destination-scope.js";
import { WorkflowRuns } from "./runs/WorkflowRuns.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";
import { WorkflowsScopePicker } from "./WorkflowsScopePicker.js";

export interface WorkflowsDestinationProps {
  readonly growth: GrowthPort;
  /**
   * The window store, read for the one member this surface needs: the session this
   * window most recently had in hand.
   *
   * The STORE rather than the value, so the subscription is this surface's own and
   * goes through the family's one selector seam. A resolved id passed down by the
   * frame would be read at the moment the surface context was built, and a person
   * who opens a session and then presses this destination would arrive at a scope
   * resolved before the session was opened.
   */
  readonly frameStore: FrameStore;
  /** This window's open sessions, for the picker's half of what it can offer. */
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /**
   * Which of the three arms the scope is on. Controlled, for the header's reason:
   * the surface above needs this same answer to hand an opened pane its store.
   */
  readonly scope: WorkflowsScopeState;
  /** Where a person's pick and their "choose again" go. */
  readonly onScopeChange: (scope: WorkflowsScopeState) => void;
  /**
   * Where an opened pane goes. Required, not optional: this destination's specified
   * job includes opening the builder, so a mount that supplied no opener would be a
   * surface that can display definitions and open none of them — which is the state
   * every definition name rendering as a plain span came from.
   */
  readonly openPane: ConsolePaneOpener;
}

/** The workflows destination, scoped to the session it reads from. */
export function WorkflowsDestination(props: WorkflowsDestinationProps): React.JSX.Element {
  // The arm is the caller's and the resolution is the model's — three arms, one
  // function, and a test that pins the arm the old fold could not express.
  const retainedSessionId = useFrameStore(props.frameStore, (state) => state.lastOpenedSessionId);
  const sessionId = scopeSessionIdFor(props.scope, retainedSessionId);
  useScopeSettlementAnnouncement(sessionId);

  if (sessionId === undefined) {
    return (
      <div className="meridian-workflows-destination">
        <WorkflowsScopePicker
          growth={props.growth}
          registry={props.sessionStoreRegistry}
          onChoose={(chosenSessionId) => {
            props.onScopeChange(chosenScope(chosenSessionId));
          }}
        />
      </div>
    );
  }

  return (
    <div className="meridian-workflows-destination">
      <p className="meridian-workflows-destination__scope">
        Definitions visible from session <WireFigure value={sessionId} />
        <button
          type="button"
          className="meridian-workflows-destination__rescope"
          onClick={() => {
            // To the question, and not to the absence of a choice. Those were the same
            // value under the old fold, so this control put the surface straight back
            // on the session the person had just asked to leave.
            props.onScopeChange(AWAITING_SESSION_CHOICE);
          }}
        >
          Choose a different session
        </button>
      </p>
      <WorkflowsBrowser
        growth={props.growth}
        sessionId={sessionId}
        onOpenDefinition={(definition) => {
          props.openPane({
            kind: "workflow-builder",
            entity: { kind: "workflow-definition", id: definition.id },
          });
        }}
      />
      <WorkflowRuns
        growth={props.growth}
        sessionId={sessionId}
        onOpenRun={(row) => {
          props.openPane({
            kind: "workflow-run",
            entity: { kind: "workflow-run", id: row.run.workflowRunId },
          });
        }}
      />
    </div>
  );
}

/**
 * Say, once, which session this surface settled on.
 *
 * The announced id is held in a ref rather than a piece of state: it is a record of
 * what has been SAID, read only to decide whether to say it again, and holding it in
 * state would re-render the surface every time it spoke. The ref is compared rather
 * than a boolean flag, so a move to a different session is a second, real settlement
 * and a re-render of the same one is silent.
 *
 * Polite, never assertive. `frame/banner-announcements.ts` reserves the assertive
 * lane for a refusal that changed what the whole room can do; this is a surface
 * describing its own subject, and interrupting a reader for it would spend the one
 * loud channel on the quietest fact the console has.
 */
function useScopeSettlementAnnouncement(sessionId: string | undefined): void {
  const announce = useAnnounce();
  const announcedSessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (sessionId === undefined || announcedSessionIdRef.current === sessionId) {
      return;
    }
    announcedSessionIdRef.current = sessionId;
    announce(`Workflows scoped to session ${sessionId}.`, "polite");
  }, [sessionId, announce]);
}
