// The inspector's draft mount point: what a person has typed into a phase's configuration and
// not yet saved. The editor is the workflow engine's body; the console only frames it.
// The durable store is deliberately not on this mount: a draft is prose, which the durable
// store's identifier-shaped write rule refuses, and a copy surviving a restart would sit in an
// origin-scoped database outside every erasure selector.

import { EngineMountPoint } from "../../components/EngineMountPoint.js";
import type { DraftStore } from "@renderer/store/draft-store.js";

/** What the builder pane hands the inspector's draft body. */
export interface DraftsMount {
  /** The definition whose drafts these are. Opaque and wire-verbatim. */
  readonly definitionId: string;
  /**
   * This window's in-memory draft store, never the durable one: unsent text does not survive a
   * restart. It also carries the notice for an evicted draft, which a body rendering drafts
   * should show.
   */
  readonly draftStore: DraftStore;
}

/**
 * A component this pane renders, never a function it calls: a call would put the body's hooks
 * into the wrapper's hook list.
 */
export type DraftsBody = (mount: DraftsMount) => React.ReactNode;

/** The drafts mount plus the body, once there is one. */
export interface DraftsMountPointProps extends DraftsMount {
  /** The body; while it is absent the empty frame stands. */
  readonly body?: DraftsBody;
}

/** The inspector's drafts frame: the engine's body once it is supplied, empty until then. */
export function DraftsMountPoint(props: DraftsMountPointProps): React.JSX.Element {
  const { body, ...mount } = props;
  return <EngineMountPoint body={body} mount={mount} />;
}
