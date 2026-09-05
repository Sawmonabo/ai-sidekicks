// Session › channel › run › entity, as far as a pane's address reaches.
//
// Its own module for the one-component rule. Every crumb is a wire string and wears
// the provenance signature that says so (rule 4), through the one module allowed to
// format one.

import { Glyph, WireFigure } from "../../primitives/index.js";
import { type ConsoleEntityRef } from "../../store/index.js";
import { PANE_CONTROL_GLYPH_SIZE } from "./pane-controls.js";

export interface PaneBreadcrumbProps {
  readonly sessionId: string | undefined;
  readonly channelId: string | undefined;
  readonly runId: string | undefined;
  readonly entity: ConsoleEntityRef | undefined;
}

/**
 * The crumbs the address carries, and nothing standing in for the ones it does not.
 *
 * A crumb the address does not carry is left out rather than rendered as a
 * placeholder — the breadcrumb describes where this pane is, and an em dash standing
 * in for a channel would say the pane is scoped to a channel it has not got.
 */
export function PaneBreadcrumb(props: PaneBreadcrumbProps): React.JSX.Element {
  const crumbs: readonly string[] = [
    props.sessionId,
    props.channelId,
    props.runId,
    props.entity?.id,
  ].filter((crumb): crumb is string => crumb !== undefined);

  if (crumbs.length === 0) {
    // Reachable: the auxiliary timeline window opens on a bare route and the frame
    // resolves its subject through the context picker. Saying so beats an empty
    // strip that reads as a breadcrumb that failed to render.
    return (
      <nav className="meridian-pane__breadcrumb" aria-label="Pane context">
        <span className="meridian-pane__crumb-absent">No session</span>
      </nav>
    );
  }
  return (
    <nav className="meridian-pane__breadcrumb" aria-label="Pane context">
      {crumbs.map((crumb, position) => (
        <span className="meridian-pane__crumb" key={crumb}>
          {position === 0 ? null : <Glyph name="chevron-right" size={PANE_CONTROL_GLYPH_SIZE} />}
          <WireFigure value={crumb} />
        </span>
      ))}
    </nav>
  );
}
