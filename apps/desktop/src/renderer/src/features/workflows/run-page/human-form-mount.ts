// What the run pane owes the body that answers a phase parked on a person. It lives apart from
// the mount point wrapper so the default body, the submit channel and the submit dispatch
// share the contract without importing the component that renders them. Whether the form may
// be submitted is the daemon's to answer and is never predicted here.

/** The phase whose form is open, as the mounting pane resolved it out of the run read. */
export interface HumanFormPhase {
  /**
   * The run this phase belongs to, wire-verbatim, as the submit is addressed by it.
   *
   * Read off the snapshot the phases came from, so a pane retargeted mid-read never pairs the
   * new run's id with the old run's phases.
   */
  readonly workflowRunId: string;
  /** The phase run whose form this is. Opaque and wire-verbatim. */
  readonly phaseRunId: string;
  /** The definition's id of the phase the form belongs to. */
  readonly phaseId: string;
  /**
   * The revision this attempt's form is composed against, as the run read reported it.
   *
   * Never compared here. The submit sends the value captured when the attempt opened, not this
   * member re-read at press time, which a refresh may have moved under a live form.
   */
  readonly formRevision: number;
  /**
   * What this phase asks, where the run read carried it.
   *
   * Handed over rather than fetched again by the body. Optional because the wire member is:
   * absent means this build was not told, never that the phase asks nothing.
   */
  readonly prompt?: string;
  /**
   * The schema the answer is shaped by, optional on the same reading.
   *
   * `unknown` because deciding what a schema is belongs to the one mapper that draws it.
   */
  readonly inputSchema?: unknown;
}

/** The resolved phase, plus the one act the submit binding keeps and the body may not author. */
export interface HumanFormMount extends HumanFormPhase {
  /**
   * Send this answer, whatever input mode composed it.
   *
   * Bound to the attempt on screen, so a body passes the answer alone: the submit call, guard,
   * revision and rendering of the reply belong to the run pane.
   */
  readonly submit: (answer: unknown) => void;
}

/**
 * A body that stands in the form mount point: a component the mount point renders, never a
 * function it calls.
 *
 * A called body's hooks would join the wrapper's changing hook list, so a supplied body must
 * be a stable reference: an inline component is a new type each render.
 */
export type HumanFormBody = (mount: HumanFormMount) => React.ReactNode;
