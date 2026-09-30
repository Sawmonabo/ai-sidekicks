// How a subject-scoped resource ends: released for reuse, or disposed and recognizable
// afterwards. The hook that holds such a resource and every controller that ends one
// read these shapes from here, so the disposal rule is stated once.

/**
 * A disposal that hands a resource back rather than ending it (a counter advanced, a subscription
 * dropped). The value stays usable and a later commit may hold it again, so there is no closed
 * state to read.
 */
export interface SubjectScopedRelease<TResource> {
  readonly release: (resource: TResource) => void;
}

/**
 * A disposal that ends a resource, and the reading that recognizes one it ended. They travel
 * together: without the reading, a double mount re-commits the closed value.
 */
export interface SubjectScopedTerminalDisposal<TResource> {
  readonly dispose: (resource: TResource) => void;
  readonly isClosed: (resource: TResource) => boolean;
}

/**
 * How a caller's resource ends: released, or disposed and recognizable afterwards. The member
 * names discriminate the arms, so `{ dispose }` without `isClosed` fails to compile.
 */
export type SubjectScopedDisposal<TResource> =
  | SubjectScopedRelease<TResource>
  | SubjectScopedTerminalDisposal<TResource>;

/**
 * What {@link CONTROLLER_DISPOSAL} needs from a controller. Deliberately narrower than a
 * controller's public API, so one constant serves controllers that publish into a host too.
 */
export interface DisposableController {
  /** Whether this controller has already ended. How the resource seam recognizes one. */
  readonly isDisposed: boolean;
  /** Ends the controller; terminal. */
  dispose(): void;
}

/**
 * How one controller ends, and how one already ended is recognized. A module-level object, since
 * a literal minted in a render would change identity every pass and restart the lifetime beneath
 * it. `isClosed` travels with the terminal `dispose`; re-derived in an effect, the seam would
 * commit the disposed controller and call `dispose()` on it a second time.
 */
export const CONTROLLER_DISPOSAL: SubjectScopedDisposal<DisposableController> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};
