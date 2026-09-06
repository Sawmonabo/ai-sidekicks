// Which session the workflows destination reads from, when nothing has named one.
//
// The rail's workflows address is BARE — `#/workflows` names no session, by the
// route grammar's own design — while the definition enumeration's request carries a
// required session id, because resolution walks `session` then `project` then
// `shared` FROM somewhere. So the destination has a question to put before it has
// one to ask the daemon, and this is where it is put.
//
// THE SAME TWO SOURCES THE AUXILIARY PICKER OFFERS, AND FOR THE SAME REASON. The
// node's sessions come from the growth port's directory read and this window's open
// ones from `SessionStoreRegistry`, offered as their union: the two answer to
// different authorities and either can hold what the other does not — a node with
// six sessions and a window that has opened none of them is not an empty node, and a
// session created a moment ago may not be on the node's list yet.
// `seats/session-directory.ts` owns both the read and the union, so neither is
// written a second time here.
//
// THE ABSENCES ARE THE READ'S, NOT THIS SURFACE'S GUESS AT IT. A directory read in
// flight is `not-loaded`; an answer with no rows is `empty`; a refusal splits, because
// "the console did not ask" and "the console asked and the asking failed" are two facts
// about the node and only one of them is ever true. A build with no wire registered for
// the read is `not-checked` — the sentence is true there and nowhere else. Any other
// refusal is `error`, carrying the daemon's own code and message, because a closed
// channel reported as an idle console is a claim about the node that nothing checked.
// `bridge/growth-port/growth-outcome.ts` answers which is which, once, beside the code
// it reads. Collapsing any two of these is the conflation
// `Spec-023 §Console Design (Meridian)`'s five kinds of nothing exist to prevent.
//
// A DIRECTORY THAT HAS NOT ANSWERED IS A PARTIAL READ, AND IT SAYS SO — WHICHEVER WAY
// IT HAS NOT ANSWERED. The two sources are a union, so a directory that refused, or
// one still in flight, beside one open session still leaves a usable list — and the
// surface presented that list as though it were the node's own. The refused case is
// the release build's path today, not a corner: the live bridge refuses `sessionList`
// by name, so an operator asking to choose a different session was shown the one
// session already open and nothing saying the rest had not been read. The in-flight
// case is every fixture build's first frames: this window holds one session, the node
// holds six, and for as long as the read is out the picker offered exactly one choice
// with nothing beside it — the prefix presented as the whole answer, which is the
// conflation `definitions/DefinitionsBrowser.tsx` names in its own header. A person
// picks the only session offered and five more appear a beat later.
//
// The choices stay in both cases, because withdrawing a session this window genuinely
// holds helps nobody. What stands above them is an account of how complete the list
// is, and the two arms say different things because they ARE different: the wait is
// the console's shared `PartialRead` notice, which every surface in flight renders the
// same way, while the refusal is this surface's own sentence about its own list beside
// the daemon's verbatim — rule 9 fixes what reaches the screen from a refusal at the
// code and the message, and neither of those says which sessions were offered anyway.
// Both take the definitions browser's shape for its own continuation: the rows held
// are still true, the notice is about what is missing, and both are on screen at once.
//
// NOTHING IS ANNOUNCED HERE. `frame/ContextPicker.tsx` performs this same read and
// announces nothing, and the reason carries over: the three absences above ARE the
// rendering of this settlement, and a live region repeating them would say twice what
// the surface already says once. The settlement this destination does announce is the
// one that follows — that a session came into scope — and `WorkflowsDestination.tsx`
// owns it.

import { useId } from "react";

import { isUnbuiltWireRefusal, type GrowthPort } from "../bridge/index.js";
import { offeredSessionIds, useSessionDirectory } from "../seats/index.js";
import { InlineRefusal, Nothing, PartialRead, WireChoiceList } from "../primitives/index.js";
import { useOpenSessionIds, type SessionStoreRegistry } from "../store/index.js";

/** The question the list is labelled with, written once for the heading and the list. */
const SCOPE_QUESTION = "Which session's workflows should this show?";

/**
 * What the directory read is OF, mid-sentence, for the notice that qualifies the list.
 *
 * Written once because the wait's sentence is composed from it by
 * `primitives/partial-read.ts` and a second phrasing here would be the console saying
 * the same absence two ways on one surface.
 */
const DIRECTORY_SUBJECT = "the sessions on this node";

/**
 * What the list holds when the node's directory could not be read.
 *
 * The console's own sentence about its own list, which is a different thing from the
 * daemon's message and stands beside it rather than paraphrasing it: rule 9 fixes what
 * reaches the screen from a refusal at the code and the message, and neither of those
 * says which sessions the surface managed to offer anyway.
 */
const PARTIAL_LIST_NOTE =
  "These are the sessions this window already has open. The node's own list was not read, so it may hold others.";

export interface WorkflowsScopePickerProps {
  readonly growth: GrowthPort;
  /** This window's open sessions — one half of what the picker can offer. */
  readonly registry: SessionStoreRegistry;
  readonly onChoose: (sessionId: string) => void;
}

/** The session choice the workflows destination puts before it can read anything. */
export function WorkflowsScopePicker(props: WorkflowsScopePickerProps): React.JSX.Element {
  const directory = useSessionDirectory(props.growth);
  const openSessionIds = useOpenSessionIds(props.registry);
  const sessionIds = offeredSessionIds(directory, openSessionIds);
  // Minted per mount rather than written as a literal, for the reason
  // `WorkflowsSurface.tsx` states about its own: two of these rendered into one tree —
  // which the tiers do — would carry the same id twice, and both `aria-labelledby`
  // references would then resolve to whichever heading came first. Called before the
  // absent arms below return, because a hook may not sit behind a branch.
  const headingId = useId();

  if (sessionIds.length === 0) {
    if (directory.status === "reading") {
      return <Nothing kind="not-loaded" title="Reading the sessions on this node." />;
    }
    if (directory.status === "served") {
      return (
        <Nothing
          kind="empty"
          title="There are no sessions on this node yet."
          detail="Workflow definitions resolve from a session outwards, so this destination shows what one session can see. Opening a session is what gives it something to resolve from."
        />
      );
    }
    if (!isUnbuiltWireRefusal(directory.refusal)) {
      // The read was put and it FAILED, so what a person acts on is what the daemon
      // said — verbatim, both halves. The sentence below would assert the opposite of
      // the refusal printed under it.
      return (
        <Nothing
          kind="error"
          placement="surface"
          title={directory.refusal.code}
          detail={directory.refusal.detail}
        />
      );
    }
    return (
      <Nothing
        kind="not-checked"
        title="This window has no session open."
        detail={`Workflow definitions resolve from a session outwards, and the console has not asked the node for the rest. ${directory.refusal.detail}`}
      />
    );
  }

  return (
    <section className="meridian-workflows-scope-picker" aria-labelledby={headingId}>
      <h2 className="meridian-workflows-scope-picker__heading" id={headingId}>
        {SCOPE_QUESTION}
      </h2>
      <p className="meridian-workflows-scope-picker__reason">
        Definitions resolve session, then project, then shared — from one session outwards — so the
        list below is the scope the daemon would resolve against.
      </p>
      {directory.status === "reading" ? (
        // The wait stands ABOVE the choices and never instead of them: the sessions
        // this window holds are real and offerable now, and what the notice withdraws
        // is the claim that they are all of them.
        <PartialRead states={[{ kind: "reading" }]} subject={DIRECTORY_SUBJECT} />
      ) : null}
      {directory.status === "unavailable" ? (
        <div className="meridian-workflows-scope-picker__partial">
          <p className="meridian-workflows-scope-picker__partial-note">{PARTIAL_LIST_NOTE}</p>
          <InlineRefusal {...directory.refusal} />
        </div>
      ) : null}
      <WireChoiceList values={sessionIds} onSelect={props.onChoose} label={SCOPE_QUESTION} />
    </section>
  );
}
