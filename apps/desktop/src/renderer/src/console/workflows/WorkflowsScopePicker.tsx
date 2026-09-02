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
// session created a moment ago may not be on the node's list yet. `frame/session-directory.ts`
// owns both the read and the union, so neither is written a second time here.
//
// THE ABSENCES ARE THE READ'S, NOT THIS SURFACE'S GUESS AT IT. A directory read in
// flight is `not-loaded`; an answer with no rows is `empty`; a refusal with nothing
// open in this window is `not-checked` — the console did not ask the node, and says
// so rather than reporting a node with no sessions. Collapsing any two of them is the
// conflation `Spec-023 §Console Design (Meridian)`'s five kinds of nothing exist to
// prevent.
//
// NOTHING IS ANNOUNCED HERE. `frame/ContextPicker.tsx` performs this same read and
// announces nothing, and the reason carries over: the three absences above ARE the
// rendering of this settlement, and a live region repeating them would say twice what
// the surface already says once. The settlement this destination does announce is the
// one that follows — that a session came into scope — and `WorkflowsDestination.tsx`
// owns it.

import type { GrowthPort } from "../bridge/index.js";
import { offeredSessionIds, useSessionDirectory } from "../frame/session-directory.js";
import { WireChoiceList } from "../frame/WireChoiceList.js";
import { Nothing } from "../primitives/index.js";
import { useOpenSessionIds, type SessionStoreRegistry } from "../store/index.js";

/** The question the list is labelled with, written once for the heading and the list. */
const SCOPE_QUESTION = "Which session's workflows should this show?";

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
    return (
      <Nothing
        kind="not-checked"
        title="This window has no session open."
        detail={`Workflow definitions resolve from a session outwards, and the console has not asked the node for the rest. ${directory.refusal.detail}`}
      />
    );
  }

  return (
    <section
      className="meridian-workflows-scope-picker"
      aria-labelledby="meridian-workflows-scope-heading"
    >
      <h2
        className="meridian-workflows-scope-picker__heading"
        id="meridian-workflows-scope-heading"
      >
        {SCOPE_QUESTION}
      </h2>
      <p className="meridian-workflows-scope-picker__reason">
        Definitions resolve session, then project, then shared — from one session outwards — so the
        list below is the scope the daemon would resolve against.
      </p>
      <WireChoiceList values={sessionIds} onSelect={props.onChoose} label={SCOPE_QUESTION} />
    </section>
  );
}
