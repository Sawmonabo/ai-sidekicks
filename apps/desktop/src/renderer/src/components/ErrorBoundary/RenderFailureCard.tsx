import { TryAgainButton } from "../TryAgainButton/TryAgainButton.js";
import { AnnouncedLine } from "../AnnouncedLine/AnnouncedLine.js";

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
    // `Retry` is not read out.
    <AnnouncedLine
      element="p"
      className="meridian-render-failure"
      words={`${props.regionName} stopped rendering.`}
      politeness="assertive"
    >
      {props.regionName} stopped rendering. <TryAgainButton word="Retry" onPress={props.onRetry} />
    </AnnouncedLine>
  );
}
