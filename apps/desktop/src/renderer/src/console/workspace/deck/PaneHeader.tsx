// A pane's header — the one implementation of it.
//
// `Spec-023 §The surface set` fixes three of the contents — panes are "each headed by
// an entity breadcrumb and a kind glyph, with the actor's hue as the focus ring". THE
// CONTROL STRIP IS THIS MODULE'S, because no committed document enumerates it: close,
// open-in-window where the kind permits (the auxiliary windows that same heading names),
// and the kind's own actions. The breadcrumb reads session › channel › run › entity, and
// the ring is neutral where the pane's entity is neither a run nor an agent.
//
// WHY IT IS SHARED AND NOT PER PANE KIND. Eleven pane kinds across six view
// families each want the same strip. Written per family it is six breadcrumbs, six
// control rows, and six sets of accessible names that agree until one of them
// ships. The header is the same in every pane by design — that is what makes the
// deck read as one surface — so it is one component, and the parts that genuinely
// differ (the kind glyph, the title, the kind's own actions) are parameters.
//
// WHERE THE TWO DECK CONTROLS COME FROM. Either explicitly, from a caller that owns
// the pane's lifetime, or from `pane-controls.ts`'s context, which the deck
// provides around every pane body. Explicit wins, so a host that mounts a pane
// outside a deck and still owns its lifetime is not forced through a context. Both
// absent, NEITHER CONTROL RENDERS: a control whose act nobody can perform is left
// out rather than drawn disabled — the absent-not-disabled rule
// `src/shared/auxiliary-routes.ts` applies to the Window menu, applied here.
//
// The heading id is a PROP rather than minted here, because the `<section>` that
// wraps a pane is the element that carries `aria-labelledby` and only the pane
// knows its own id.
//
// AND WHY THE HEADER IS ALSO THE DRAG HANDLE. `Spec-023 §Console Libraries` puts
// pointer reorder on `@atlaskit/pragmatic-drag-and-drop`, which binds to an element.
// The header is the strip that means "this pane" in every deck a person has used,
// and making the whole pane draggable would turn selecting text in a pane body into
// the start of a drag. The registration arrives through the same host context the
// two deck controls do, so a header rendered outside a deck is simply not draggable
// — the absent-not-disabled rule again, applied to a gesture.

import { Glyph, WireFigure } from "../../primitives/index.js";
import { type ConsoleEntityRef } from "../../store/index.js";
import { type GlyphName } from "../../tokens/index.js";
import { type PaneKind } from "../../seats/index.js";
import { usePaneControls } from "./pane-controls.js";

/**
 * The glyph each pane kind wears, as a total record over the closed set.
 *
 * Total, so a twelfth pane kind is a compile error here until somebody picks its
 * glyph — a kind that silently fell back to a default would be a kind the
 * breadcrumb cannot tell from its neighbour. Several kinds share a glyph on
 * purpose: `runs` is a list OF runs and `workflow-run` is a run OF a workflow, and
 * inventing a distinct mark for each would grow the glyph family past what a person
 * can hold, which is the cost `tokens/glyphs.ts` names.
 */
export const PANE_KIND_GLYPHS: Readonly<Record<PaneKind, GlyphName>> = {
  timeline: "timeline",
  inspector: "inspector",
  runs: "run",
  approvals: "approval",
  diff: "diff",
  artifact: "artifact",
  "workflow-run": "workflow",
  "workflow-builder": "workflow",
  browser: "browser",
  terminal: "terminal",
  "agent-console": "agent",
};

const PANE_CONTROL_GLYPH_SIZE = 14;
const PANE_KIND_GLYPH_SIZE = 16;

export interface PaneHeaderProps {
  readonly kind: PaneKind;
  /** The pane's name, sentence case. Also the noun the open-in-window label uses. */
  readonly title: string;
  /** The id the pane's own `aria-labelledby` points at. */
  readonly headingId: string;
  readonly sessionId: string | undefined;
  readonly channelId?: string;
  readonly runId?: string;
  readonly entity: ConsoleEntityRef | undefined;
  /** Overrides the host's close, where the caller owns this pane's lifetime. */
  readonly onClose?: () => void;
  /** Overrides the host's detach, on the same terms. */
  readonly onOpenInWindow?: () => void;
  /** The kind's own actions, rendered before the two host controls. */
  readonly actions?: React.ReactNode;
}

export function PaneHeader(props: PaneHeaderProps): React.JSX.Element {
  const hostControls = usePaneControls();
  const onClose = props.onClose ?? hostControls?.onClose;
  const onOpenInWindow = props.onOpenInWindow ?? hostControls?.onOpenInWindow;
  const registerDragHandle = hostControls?.registerDragHandle;

  return (
    <header className="meridian-pane__header" ref={registerDragHandle}>
      <span className="meridian-pane__kind">
        <Glyph name={PANE_KIND_GLYPHS[props.kind]} size={PANE_KIND_GLYPH_SIZE} />
        <span className="meridian-pane__heading" id={props.headingId}>
          {props.title}
        </span>
      </span>
      <PaneBreadcrumb
        sessionId={props.sessionId}
        channelId={props.channelId}
        runId={props.runId}
        entity={props.entity}
      />
      <span className="meridian-pane__controls">
        {props.actions}
        {onOpenInWindow === undefined ? null : (
          <button
            type="button"
            className="meridian-pane__control"
            onClick={onOpenInWindow}
            aria-label={`Open this ${props.title.toLowerCase()} in its own window`}
          >
            <Glyph name="external" size={PANE_CONTROL_GLYPH_SIZE} />
          </button>
        )}
        {onClose === undefined ? null : (
          <button
            type="button"
            className="meridian-pane__control"
            onClick={onClose}
            aria-label="Close this pane"
          >
            <Glyph name="close" size={PANE_CONTROL_GLYPH_SIZE} />
          </button>
        )}
      </span>
    </header>
  );
}

interface PaneBreadcrumbProps {
  readonly sessionId: string | undefined;
  readonly channelId: string | undefined;
  readonly runId: string | undefined;
  readonly entity: ConsoleEntityRef | undefined;
}

/**
 * Session › channel › run › entity, as far as the pane's address reaches.
 *
 * Every crumb is a wire string and wears the provenance signature that says so
 * (rule 4), through the one module allowed to format one. A crumb the address does
 * not carry is left out rather than rendered as a placeholder — the breadcrumb
 * describes where this pane is, and an em dash standing in for a channel would say
 * the pane is scoped to a channel it has not got.
 */
function PaneBreadcrumb(props: PaneBreadcrumbProps): React.JSX.Element {
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
