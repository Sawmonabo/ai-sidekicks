/** What {@link RenderFailureCard} needs: the failed region's name, the error, and a retry. */
export interface RenderFailureCardProps {
  /** What failed, in the person's words: "the transcript", "the inspector". */
  readonly regionName: string;
  readonly error: Error;
  readonly onRetry: () => void;
}

/**
 * The error boundary's default fallback: what stopped working, and the one thing that
 * might fix it. The error message is shown because a person who reports a bug needs it.
 */
export function RenderFailureCard(props: RenderFailureCardProps): React.JSX.Element {
  return (
    <div className="meridian-render-failure" role="alert">
      <p className="meridian-render-failure__title">{props.regionName} stopped rendering.</p>
      <p className="meridian-render-failure__detail">{props.error.message}</p>
      <button className="meridian-render-failure__action" type="button" onClick={props.onRetry}>
        Try again
      </button>
    </div>
  );
}
