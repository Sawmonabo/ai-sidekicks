// The diff pane's body while a change set is being asked for, and once one exists.
//
// THE HOOK LIVES HERE AND NOT IN THE PANE, and the reason is React's rather than
// taste's: three of the five subjects a diff pane opens over name nothing the create
// wire can be keyed by, so the pane cannot call a creation hook at all — a hook called
// on some addresses and not others is the one thing a component may not do. This
// component is rendered only where a subject resolved, so the hook inside it is
// unconditional.
//
// THE CHANGE SET IS RENDERED BY THE CALLER AND NOT BY THIS DIRECTORY. What this module
// knows is how a diff is minted; how one is DRAWN is the pane's, and it arrives as a
// closure so this directory holds no edge back into the one that owns the renderer.
//
// AND A SETTLED CREATE KEEPS ITS WAY BACK. `Spec-023 §Console Design (Meridian)` rule 8
// admits no dead end: the comparison a person named is one of many they might name, so
// the control that puts the form back is drawn beside the change set rather than the
// pane having to be closed and reopened.

import { Nothing } from "../../../primitives/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import type { SessionStore } from "../../../store/index.js";
import type { ConsoleDiffModel } from "../diff-model.js";
import { useDiffCreation } from "./diff-creation-binding.js";
import { DiffCreateForm } from "./DiffCreateForm.js";
import type { DiffCreateSubject } from "./diff-create-subject.js";

export interface DiffCreateSurfaceProps {
  readonly bridge: ConsoleBridge;
  readonly subject: DiffCreateSubject;
  /** The session whose reconnect edge and repo frames re-ask the attribution. */
  readonly sessionStore: SessionStore;
  /** What this subject's absence says, from the pane's own per-kind table. */
  readonly absence: { readonly title: string; readonly detail: string };
  /** How the pane draws a change set once one exists. */
  readonly renderChangeSet: (diff: ConsoleDiffModel) => React.ReactNode;
}

export function DiffCreateSurface(props: DiffCreateSurfaceProps): React.JSX.Element {
  const binding = useDiffCreation(props.bridge, props.subject, props.sessionStore);
  const { reading } = binding;
  if (reading.act.status === "created") {
    return (
      <div className="meridian-diff-create-surface">
        <div className="meridian-diff-create-surface__again">
          <button type="button" className="meridian-diff-create__retry" onClick={binding.clearAct}>
            Compare two other states
          </button>
        </div>
        {props.renderChangeSet(reading.act.diff)}
      </div>
    );
  }
  return (
    <div className="meridian-diff-pane__absence">
      {/*
        THE ABSENCE COPY STAYS ABOVE THE FORM rather than being replaced by it. It says
        what this subject's changes would be and that nothing has been asked — which is
        still true while a form is open, and is exactly what rule 8's `not-checked`
        stands for.
      */}
      <Nothing
        kind="not-checked"
        placement="surface"
        title={props.absence.title}
        detail={props.absence.detail}
      />
      <DiffCreateForm binding={binding} />
    </div>
  );
}
