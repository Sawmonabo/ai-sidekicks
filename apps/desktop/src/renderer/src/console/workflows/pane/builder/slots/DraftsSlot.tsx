// The inspector's draft slot — what a person has typed into a phase's configuration
// and not yet saved.
//
// OWNED BY PLAN-017. A `human` phase's form configuration, a gate's settings and a
// back-reference target are edited in the inspector, and the in-progress text is
// participant-authored content the console holds and never stores. The editor is
// the engine's own body; this console frames it. THE SHELL DIES IN THE PLAN-017
// TASK THAT MOUNTS THE BODY, in the same PR as the mount.
//
// THE DURABLE STORE IS DELIBERATELY NOT ON THIS MOUNT, and that absence is the
// whole design rather than an omission. A draft is prose, so the durable store's
// identifier-shaped write rule refuses it by construction, and a copy that survived
// a restart would put a person's unsent words in an origin-scoped database outside
// every erasure selector the corpus defines. The window-lifetime store is what this
// mount carries; a body that wanted durability would have to acquire it itself,
// which is the move the architecture tier is watching for.
//
// GEOMETRY IS NOT A DRAFT, EITHER. The canvas's node positions are client-local too
// but they are coordinates rather than prose, so they go to the durable UI-state
// store under its `layout` value class — the node-graph slot beside this one carries
// that store, and this one does not. Two client-local tiers, two homes, and the
// mount types are what keep them from being confused for each other.
//
// THE KEY SPACE IS FLAT AND ITS NAMESPACE IS NOT MINTED HERE. The draft store is
// keyed by whichever surface owns the composer, and no console family has landed a
// key convention yet. Rather than mint one that nothing else follows, the mount
// hands over the definition the drafts belong to and the body composes its keys
// under it; the convention lands with the first family that has two writers.

import { WorkflowSlotMount } from "../../../WorkflowSlotMount.js";
import { WORKFLOW_DRAFT_SLOT } from "../../../owner-slots.js";
import type { DraftStore } from "../../../../persistence/index.js";

/** What the builder pane hands the inspector's draft body. */
export interface DraftsMount {
  /** The definition whose drafts these are. Opaque and wire-verbatim. */
  readonly workflowDefinitionId: string;
  /**
   * This window's draft store, and never the durable one.
   *
   * Window-lifetime by construction: it holds a map and a disclosure, opens no
   * adapter, and tells the participant once that unsent text does not survive a
   * restart. That disclosure is what makes the non-persistence a stated property
   * rather than a silent loss, so a body that renders drafts renders it too.
   */
  readonly draftStore: DraftStore;
}

/**
 * The body Plan-017 authors: a COMPONENT this pane renders, never a function it
 * calls. `owner-slots.ts` states the reason once for all five slots.
 */
export type DraftsBody = (mount: DraftsMount) => React.ReactNode;

export interface DraftsSlotProps extends DraftsMount {
  /** The body, once there is one. Absent everywhere here, so the shell stands. */
  readonly body?: DraftsBody;
}

/** The inspector's drafts, or the honest statement that they are reserved and unbuilt. */
export function DraftsSlot(props: DraftsSlotProps): React.JSX.Element {
  const { body, ...mount } = props;
  return (
    <WorkflowSlotMount
      seat={WORKFLOW_DRAFT_SLOT}
      body={body}
      mount={mount}
      title="The phase inspector is not built yet."
      detail="A phase's form configuration, tool binding and gate open here; nothing typed into them is ever written to disk."
    />
  );
}
