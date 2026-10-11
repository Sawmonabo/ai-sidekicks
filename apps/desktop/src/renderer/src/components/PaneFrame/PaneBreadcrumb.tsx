// Session > run > entity > this pane, as far as a pane's address reaches; the one crumb
// derivation in the app.
//
// Address crumbs are wire strings and wear the mono signature; the last crumb is the pane's own
// prose name. A crumb the address lacks is left out, not drawn as a placeholder; an address that
// names nothing says so. The separator is a `Glyph` (hidden from assistive technology when it has
// no title), not generated content, which some readers announce.

import { Glyph } from "../Glyph/Glyph.js";
import { WireFigure } from "../WireFigure/WireFigure.js";
import { type EntityRef } from "#renderer/lib/entity-kinds.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";

/**
 * Where a pane is, as far as its address reaches. Every member is required and may be
 * `undefined`, so "scoped to no run" cannot be confused with "forgot to resolve one".
 */
export interface PaneScopeAddress {
  readonly sessionId: string | undefined;
  readonly runId: string | undefined;
  readonly entity: EntityRef | undefined;
}

/**
 * Which member of the address a crumb came from; unique per trail, unlike the identifier, so it
 * keys the list.
 */
export type PaneScopeName = "session" | "run" | "entity";

/** One crumb: the scope it came from, and the wire identifier that scope carries. */
export interface PaneScopeCrumb {
  readonly scope: PaneScopeName;
  readonly value: string;
}

/**
 * The wire identifiers a pane's address carries, outermost first, each with its scope. An entity
 * contributes its `id`, not its `kind`, which the pane's glyph and title already say. The scope
 * is the key: two scopes may hold the same string, and a positional key would remount later
 * crumbs when one appears.
 */
export function paneScopeCrumbs(address: PaneScopeAddress): readonly PaneScopeCrumb[] {
  const carried: readonly { readonly scope: PaneScopeName; readonly value: string | undefined }[] =
    [
      { scope: "session", value: address.sessionId },
      { scope: "run", value: address.runId },
      { scope: "entity", value: address.entity?.id },
    ];
  return carried.filter((crumb): crumb is PaneScopeCrumb => crumb.value !== undefined);
}

/** What the trail says when the address names nothing at all. */
const NO_ADDRESS_CRUMB = "No session";

/** Props for `PaneBreadcrumb`: the address, the pane's own name, and the id that names the list. */
export interface PaneBreadcrumbProps extends PaneScopeAddress {
  /**
   * The id the pane's `<section>` points `aria-labelledby` at. It names the whole crumb list,
   * so two panes of one kind are told apart by their session and run.
   */
  readonly crumbsId: string;
  /** The pane's own name, prose, and the crumb the trail is on. */
  readonly currentCrumb: string;
  /** The id the pane's own name carries, where something else is named by it. */
  readonly currentCrumbId?: string | undefined;
}

/** The crumbs the address carries, with nothing standing in for the ones it lacks. */
export function PaneBreadcrumb(props: PaneBreadcrumbProps): React.JSX.Element {
  const scopeCrumbs = paneScopeCrumbs(props);
  return (
    <nav className="meridian-pane__breadcrumb" aria-label="Pane location">
      <ol className="meridian-pane__crumbs" id={props.crumbsId}>
        {scopeCrumbs.length === 0 ? (
          <li className="meridian-pane__crumb-absent">{NO_ADDRESS_CRUMB}</li>
        ) : (
          scopeCrumbs.map((crumb, position) => (
            // Keyed on the scope: the identifier can collide across scopes.
            <li className="meridian-pane__crumb" key={crumb.scope}>
              {position === 0 ? null : <Glyph name="chevron-right" size={GLYPH_SIZE_CHROME} />}
              <WireFigure value={crumb.value} />
            </li>
          ))
        )}
        <li className="meridian-pane__crumb meridian-pane__heading" aria-current="page">
          <Glyph name="chevron-right" size={GLYPH_SIZE_CHROME} />
          <span id={props.currentCrumbId}>{props.currentCrumb}</span>
        </li>
      </ol>
    </nav>
  );
}
