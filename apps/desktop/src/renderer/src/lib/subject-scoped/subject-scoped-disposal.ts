// How a subject-scoped resource ends: released for reuse, or disposed and recognizable
// afterwards. The hook that holds such a resource and every controller that ends one
// read these shapes from here, so the disposal rule is stated once.

/**
 * A disposal that hands a resource back rather than ending it.
 *
 * A counter advanced, a subscription dropped, a listener detached: the value is still
 * a working value afterwards and a later commit may hold it again. There is no closed
 * state to read, which is why this arm carries no reading — supplying one would be a
 * claim about a lifetime that does not end.
 */
export interface SubjectScopedRelease<TResource> {
  readonly release: (resource: TResource) => void;
}

/**
 * A disposal that ENDS a resource, and the reading that recognizes one it ended.
 *
 * The two travel together because neither is usable alone: a terminal disposal
 * without a reading is the double-mount corpse the header describes, and a reading
 * without a terminal disposal is a claim about a value nothing ever closes.
 */
export interface SubjectScopedTerminalDisposal<TResource> {
  readonly dispose: (resource: TResource) => void;
  readonly isClosed: (resource: TResource) => boolean;
}

/**
 * How a caller's resource ends — released, or disposed and recognizable afterwards.
 *
 * NO `kind` TAG, BECAUSE THE VERB IS THE TAG. `release` and `dispose` are the two
 * facts, and a literal beside them would be a second place to state one of them and
 * a second place to get it wrong. TypeScript discriminates the arms on the member
 * names alone: `{ dispose }` with no reading matches neither, which is the compile
 * error this type exists to produce.
 */
export type SubjectScopedDisposal<TResource> =
  | SubjectScopedRelease<TResource>
  | SubjectScopedTerminalDisposal<TResource>;

/**
 * How any subject-scoped controller ends, and the whole of what {@link CONTROLLER_DISPOSAL}
 * needs from one.
 *
 * NARROWER THAN AN ACT CONTROLLER'S PUBLIC API ON PURPOSE. A controller that publishes
 * into a host rather than off a snapshot of its own has no reading to subscribe to and
 * still has exactly this lifetime, so typing the disposal on the pair it actually
 * calls is what lets one constant serve both shapes.
 */
export interface DisposableController {
  /** Whether this controller has already ended. How the resource seam recognizes one. */
  readonly isDisposed: boolean;
  dispose(): void;
}

/**
 * How one controller ends, and how one already ended is recognized. Declared once.
 *
 * ONE MODULE-LEVEL OBJECT, because the resource seam holds `dispose` and `isClosed` on
 * dependencies of their own: a literal minted in a render body would hand over a fresh
 * identity on every pass and restart the lifetime beneath it. `dispose` is TERMINAL,
 * which is why `isClosed` travels beside it in the same object rather than being
 * re-derived in an effect — re-derived there, the seam records the corpse as committed,
 * the caller publishes a replacement, and the value-change cleanup calls `dispose()` on
 * the corpse a second time.
 */
export const CONTROLLER_DISPOSAL: SubjectScopedDisposal<DisposableController> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};
