// A quiet line, for the three absences that are nobody's fault.
//
// Its own module because `apps/desktop/AGENTS.md` puts one component in a `.tsx`
// file, and because this is the shape rather than the choice: `PaletteEmptyState.tsx`
// beside it decides WHICH of the palette's five kinds of nothing a state is, and
// this decides what the three quiet ones look like — a headline and one line under
// it, with no badge, no error edge, and no control.
//
// It is not on the family door. The three call sites are the arms of the one
// decision next door, and a surface reaching for a quiet line of its own would be
// rendering a palette absence outside the palette.

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
