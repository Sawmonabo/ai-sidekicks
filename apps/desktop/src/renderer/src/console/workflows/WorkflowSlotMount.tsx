// Where a body another part of the system authors is mounted, and what stands there until it
// is: an empty framed box.
//
// A body is a component, never a call. React attributes a hook to whichever component is
// rendering when the hook runs, so a wrapper that invoked `body(mount)` inside its own
// render would put the body's hooks into the wrapper's hook list, and every one of these
// mounts is conditional. This component builds an element from the body and the mount it
// is handed, and an absent body is an empty frame rather than a call skipped. The caller
// keeps the reciprocal duty: the body must be a stable reference, because a component
// composed inline on each render is a new type each time and React remounts it.

/** What this mount is handed: the body once there is one, and what it is handed to render. */
export interface WorkflowSlotMountProps<TMount extends object> {
  /** The body, or `undefined` while nobody has filled the slot. */
  readonly body: ((mount: TMount) => React.ReactNode) | undefined;
  /**
   * What the mounting surface hands the body.
   *
   * Absent where the surface cannot meet it, which is one slot's real state: the human form
   * is opened from a phase, and a form composed against a phase nobody resolved would be
   * answerable in appearance and unsubmittable in fact. No mount, no body, and the frame
   * stands empty.
   */
  readonly mount: TMount | undefined;
}

/** Mount a body authored elsewhere, or draw the empty frame where it will stand. */
export function WorkflowSlotMount<TMount extends object>(
  props: WorkflowSlotMountProps<TMount>,
): React.JSX.Element {
  const { body: SlotBody, mount } = props;
  return (
    <div className="meridian-workflow__slot">
      {SlotBody === undefined || mount === undefined ? null : <SlotBody {...mount} />}
    </div>
  );
}
