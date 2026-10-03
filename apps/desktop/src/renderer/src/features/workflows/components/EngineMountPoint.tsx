// Where a body another part of the system authors is mounted, and what stands there until it
// is: an empty framed box. A body is a component, never a call: invoking `body(mount)` would
// put its hooks into the wrapper's hook list, and every mount is conditional. The caller must
// pass a stable body reference, since a component composed inline each render remounts.

/** What this mount is handed: the body once there is one, and what it is handed to render. */
export interface EngineMountPointProps<TMount extends object> {
  /** The body, or `undefined` while nobody has filled the mount point. */
  readonly body: ((mount: TMount) => React.ReactNode) | undefined;
  /**
   * What the view doing the mounting hands the body. Absent where that view cannot supply it
   * (a form composed against an unresolved phase would look answerable but be unsubmittable),
   * and the frame then stands empty.
   */
  readonly mount: TMount | undefined;
}

/** Mount a body authored elsewhere, or draw the empty frame where it will stand. */
export function EngineMountPoint<TMount extends object>(
  props: EngineMountPointProps<TMount>,
): React.JSX.Element {
  const { body: MountPointBody, mount } = props;
  return (
    <div className="meridian-workflow__mount-point">
      {MountPointBody === undefined || mount === undefined ? null : <MountPointBody {...mount} />}
    </div>
  );
}
