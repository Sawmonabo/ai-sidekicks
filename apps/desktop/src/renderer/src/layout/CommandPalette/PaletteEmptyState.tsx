// What the palette renders when the query matched nothing: one plain line. The registry always
// holds the rail's commands, which apply everywhere, so an empty query always lists rows.

/** What the empty state reads. */
export interface PaletteEmptyStateProps {
  readonly query: string;
}

/** The line shown when no command matches the query. */
export function PaletteEmptyState(props: PaletteEmptyStateProps): React.JSX.Element {
  return (
    <div className="command-palette__empty-state">{`Nothing matched "${props.query.trim()}"`}</div>
  );
}
