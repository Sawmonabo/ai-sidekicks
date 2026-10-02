/** What {@link RenderFailureCard} needs: the failed region's name and a retry. */
export interface RenderFailureCardProps {
  /** What failed, in the person's words: "The transcript", "The inspector". */
  readonly regionName: string;
  readonly onRetry: () => void;
}

/**
 * The error boundary's default fallback: one line naming the region and a faint `Retry` word
 * beside it. The error itself goes to the tripwire report, not the screen.
 */
export function RenderFailureCard(props: RenderFailureCardProps): React.JSX.Element {
  return (
    <p className="meridian-render-failure" role="alert">
      {props.regionName} stopped rendering.{" "}
      <button className="meridian-render-failure__retry" type="button" onClick={props.onRetry}>
        Retry
      </button>
    </p>
  );
}
