/**
 * The live dot on a going run's row. It breathes only while the row is on screen and holds still
 * once scrolled out of view, as `markInView` writes it; reduced motion removes the breath outright.
 * It is decoration: the status chip beside it says the run is going.
 */
export function RunLiveDot(props: {
  readonly markInView: (element: HTMLElement | null) => (() => void) | undefined;
}): React.JSX.Element {
  return (
    <span ref={props.markInView} className="meridian-workflows-runs__live-dot" aria-hidden="true" />
  );
}
