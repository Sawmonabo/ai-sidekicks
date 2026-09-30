// The quiet empty state: a headline and one line, with no badge, error edge or control.

/** A quiet line for the absences that are nobody's fault; only `PaletteEmptyState` renders it. */
export function QuietEmptyState(props: QuietEmptyStateProps): React.JSX.Element {
  return (
    <div className="command-palette__empty-state">
      <span className="command-palette__empty-state-headline">{props.headline}</span>
      <span className="command-palette__empty-state-detail">{props.detail}</span>
    </div>
  );
}

interface QuietEmptyStateProps {
  readonly headline: string;
  readonly detail: string;
}
