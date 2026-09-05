// Session › channel › run › entity › this pane, as far as a pane's address reaches.
//
// Its own module for the one-component rule, and the ONE crumb derivation in the
// console. Two of them is the drift this file was made out of: a scope helper that
// answered `["Session", "run run-10"]` in prose and a breadcrumb that rendered the
// wire ids straight, so the same pane described itself two ways depending on which
// one a family reached for. There is one now, {@link paneScopeCrumbs}, and the
// component renders what it returns.
//
// EVERY ADDRESS CRUMB IS A WIRE STRING and wears the provenance signature that says
// so (`Spec-023 §Console Design (Meridian)` rule 4), through the one module allowed to
// format one. The LAST crumb is not: it is the pane's own name, prose from the closed
// title table, and it is the crumb the trail is currently on.
//
// A CRUMB THE ADDRESS DOES NOT CARRY IS LEFT OUT rather than rendered as a
// placeholder — the trail describes where this pane is, and an em dash standing in for
// a channel would say the pane is scoped to a channel it has not got. An address that
// carries nothing at all says so, because an empty strip reads as a breadcrumb that
// failed to render.
//
// THE SEPARATOR IS A GLYPH AND NOT GENERATED CONTENT. Both are silent to a reader's
// eye; only one is silent to a screen reader. A `::before { content: "›" }` is
// announced by assistive technology that reads generated content, and a `Glyph` with
// no `title` is `aria-hidden` by that component's own contract — so the mark that
// separates two names cannot be read out as a name.

import { Glyph, WireFigure } from "../primitives/index.js";
import { type ConsoleEntityRef } from "../store/index.js";
import { PANE_CONTROL_GLYPH_SIZE } from "./pane-controls.js";

/**
 * Where a pane is, as far as its address reaches.
 *
 * Every member is REQUIRED and may be `undefined`, on `ConsolePaneContext`'s
 * precedent: an optional member reads identically whether the deck decided the pane is
 * scoped to no channel or forgot to resolve one, and only one of those is an answer.
 */
export interface PaneScopeAddress {
  readonly sessionId: string | undefined;
  readonly channelId: string | undefined;
  readonly runId: string | undefined;
  readonly entity: ConsoleEntityRef | undefined;
}

/**
 * The wire identifiers a pane's address carries, outermost first.
 *
 * The identifiers are wire-verbatim — they are strings, so they are rendered as
 * received. An entity contributes its `id` and not its `kind`: the kind is already
 * said by the pane's own glyph and title, and repeating it in the trail would make
 * `agent agent-01` the crumb for a pane that says "Agent console" two elements away.
 */
export function paneScopeCrumbs(address: PaneScopeAddress): readonly string[] {
  return [address.sessionId, address.channelId, address.runId, address.entity?.id].filter(
    (crumb): crumb is string => crumb !== undefined,
  );
}

/** What the trail says when the address names nothing at all. */
const NO_ADDRESS_CRUMB = "No session";

export interface PaneBreadcrumbProps extends PaneScopeAddress {
  /**
   * The id the pane's `<section>` points its `aria-labelledby` at.
   *
   * It lands on the crumb LIST rather than on the last crumb, because the pane's name
   * is the whole trail: two `runs` panes in one deck are told apart by the session and
   * the run they are scoped to, and a name of "Runs" twice over tells a reader
   * navigating regions nothing at all.
   */
  readonly crumbsId: string;
  /** The pane's own name, prose, and the crumb the trail is on. */
  readonly currentCrumb: string;
}

/** The crumbs the address carries, and nothing standing in for the ones it does not. */
export function PaneBreadcrumb(props: PaneBreadcrumbProps): React.JSX.Element {
  const scopeCrumbs = paneScopeCrumbs(props);
  return (
    <nav className="meridian-pane__breadcrumb" aria-label="Pane location">
      <ol className="meridian-pane__crumbs" id={props.crumbsId}>
        {scopeCrumbs.length === 0 ? (
          // Reachable: the auxiliary timeline window opens on a bare route and the
          // frame resolves its subject through the context picker.
          <li className="meridian-pane__crumb-absent">{NO_ADDRESS_CRUMB}</li>
        ) : (
          scopeCrumbs.map((crumb, position) => (
            <li className="meridian-pane__crumb" key={crumb}>
              {position === 0 ? null : (
                <Glyph name="chevron-right" size={PANE_CONTROL_GLYPH_SIZE} />
              )}
              <WireFigure value={crumb} />
            </li>
          ))
        )}
        <li className="meridian-pane__crumb meridian-pane__heading" aria-current="page">
          <Glyph name="chevron-right" size={PANE_CONTROL_GLYPH_SIZE} />
          {props.currentCrumb}
        </li>
      </ol>
    </nav>
  );
}
