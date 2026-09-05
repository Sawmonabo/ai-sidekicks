// The chrome every deck pane wears, and the two tables that make it legible.
//
// `Spec-023 §Console Design (Meridian)` puts one entity in one pane behind a single
// mount door. What it does NOT say is that each of the six families should draw its
// own frame — and six frames drawn independently is six spacings, six breadcrumb
// separators, and six answers to where the focus ring goes. So the frame is drawn
// once, here, and a pane body is what a family actually writes.
//
// WHY THIS LIVES IN `panes/` AND NOT IN A PANE'S OWN DIRECTORY
//
// `runs/pane/`, `approvals/pane/`, and `inspector/pane/` are the first three bodies
// and they are all one family's. The `timeline`, `diff`, and workflow kinds belong to
// other families, and every one of them wants this frame. Putting it inside the first
// pane that needed it would make five later VIEW families import a sibling view
// family's directory — the edge `console-view-family-isolation` forbids outright —
// and `apps/desktop/AGENTS.md` says to hoist on the second use, which arrived in the
// same lane as the first. `panes/` is the one place above every family that each of
// them may reach, which is why the frame sits here and no pane BODY does.

import { type ConsoleEntityRef } from "../store/index.js";
import { type ConsolePaneContext, type PaneKind } from "../seats/index.js";
import { Glyph, InlineRefusal, type GlyphName } from "../primitives/index.js";

/**
 * The glyph each pane kind wears, total over the closed set.
 *
 * `Record<PaneKind, …>` rather than a lookup with a fallback: a twelfth pane kind
 * would be a `Spec-023` amendment, and it should fail to compile here rather than
 * render as a nameless square in whichever deck first opened it.
 */
const GLYPH_BY_PANE_KIND: Readonly<Record<PaneKind, GlyphName>> = {
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

/**
 * What a pane kind is called in a breadcrumb and in an accessible name.
 *
 * Total for `GLYPH_BY_PANE_KIND`'s reason, and separate from the kind string
 * because the kind is a wire-shaped identifier (`workflow-run`) and a person reads
 * a phrase (`Workflow run`).
 */
const TITLE_BY_PANE_KIND: Readonly<Record<PaneKind, string>> = {
  timeline: "Timeline",
  inspector: "Inspector",
  runs: "Runs",
  approvals: "Approvals",
  diff: "Diff",
  artifact: "Artifact",
  "workflow-run": "Workflow run",
  "workflow-builder": "Workflow builder",
  browser: "Browser",
  terminal: "Terminal",
  "agent-console": "Agent console",
};

/**
 * The crumbs leading to a pane, from what the deck addressed it with.
 *
 * Shared rather than spelled per pane: three panes each writing their own
 * conditional is three chances to render "undefined undefined" in a breadcrumb. The
 * identifier is wire-verbatim — it is a string, so it is rendered as received.
 *
 * The parameter is OPTIONAL because a session-scoped pane kind has no `entity`
 * member on its address at all — not a member holding `undefined` — so the call it
 * makes is the argument-less one, and a required parameter would have every such
 * pane passing a literal `undefined` that reads as a value it failed to resolve.
 */
export function paneScopeCrumbs(entity?: ConsoleEntityRef): readonly string[] {
  return entity === undefined ? ["Session"] : ["Session", `${entity.kind} ${entity.id}`];
}

/** The context a body of one pane kind is handed, narrowed to that kind's arm. */
export type PaneContextOf<TKind extends PaneKind> = Extract<ConsolePaneContext, { kind: TKind }>;

/** The subsystem a pane-composition refusal names as its author. */
const PANE_COMPOSITION_ORIGIN = "pane-composition";

/**
 * Adapt a body written for ONE pane kind into the render the registry stores.
 *
 * `ConsolePaneDescriptor.render` takes the whole `ConsolePaneContext` union, because
 * one registry holds every kind. A body does not: an inspector reads an entity the
 * runs pane's arm does not carry, which is the property the kind-scoped address union
 * exists to hold. So the narrowing happens once, here, rather than three times in
 * three families with three different answers for the arm that cannot be served.
 *
 * A MISMATCH IS A RENDERED REFUSAL AND NEVER A THROW. The deck looks a body up BY
 * kind and hands it a context addressed at that kind, so the arm below is
 * unreachable through the deck — but the two untyped boundaries (a restored layout
 * row, a typed route) are where an address arrives without the compiler, and
 * `core/refusal.ts`'s rule is that one bad row loses that row rather than the deck.
 * A throw here would take the whole window down for a pane; the refusal keeps the
 * frame and names what was asked for.
 */
export function paneBodyForKind<TKind extends PaneKind>(
  kind: TKind,
  renderBody: (context: PaneContextOf<TKind>) => React.ReactNode,
): (context: ConsolePaneContext) => React.ReactNode {
  return (context) =>
    context.kind === kind ? (
      renderBody(context as PaneContextOf<TKind>)
    ) : (
      <InlineRefusal
        code={`${PANE_COMPOSITION_ORIGIN}.pane-kind-mismatch`}
        detail={`the ${TITLE_BY_PANE_KIND[kind]} pane was mounted at a "${context.kind}" address, which it is not a view of`}
      />
    );
}

/** Carries the pane's attributed hue into the focus ring, as `LedgerRow` does. */
interface PaneFocusRingStyle extends React.CSSProperties {
  readonly "--meridian-pane-hue": string;
}

export interface ConsolePaneChromeProps {
  readonly kind: PaneKind;
  /**
   * The crumbs LEADING TO this pane, outermost first. The pane's own title is
   * appended by the chrome, so no caller can spell it differently from the one the
   * accessible name uses.
   */
  readonly leadingCrumbs: readonly string[];
  /**
   * The focus ring's colour as a `var()` reference, or `undefined` where the deck
   * has no actor to attribute the pane to. Undefined takes the neutral ring, which
   * is the fail-closed answer: an unattributed pane never borrows someone's hue.
   */
  readonly focusHue: string | undefined;
  readonly children: React.ReactNode;
}

/**
 * One pane's frame: kind glyph, breadcrumb, focus ring, body.
 *
 * The section is focusable at `tabIndex={-1}` rather than `0`. A deck holds several
 * panes and every one of them would otherwise sit in the tab order ahead of the
 * controls inside it; `-1` keeps the pane reachable programmatically — which is
 * what a deck's own focus routing needs — without spending a tab stop per pane.
 */
export function ConsolePaneChrome(props: ConsolePaneChromeProps): React.JSX.Element {
  const title = TITLE_BY_PANE_KIND[props.kind];
  const crumbs = [...props.leadingCrumbs, title];
  const focusRingStyle: PaneFocusRingStyle | undefined =
    props.focusHue === undefined ? undefined : { "--meridian-pane-hue": props.focusHue };
  return (
    <section
      className={`meridian-pane meridian-pane--${props.kind}`}
      aria-label={crumbs.join(" — ")}
      tabIndex={-1}
      style={focusRingStyle}
    >
      <header className="meridian-pane__head">
        <span className="meridian-pane__kind">
          <Glyph name={GLYPH_BY_PANE_KIND[props.kind]} size={14} />
        </span>
        <nav className="meridian-pane__breadcrumb" aria-label="Pane location">
          <ol className="meridian-pane__crumbs">
            {crumbs.map((crumb, position) => (
              <li
                className="meridian-pane__crumb"
                key={crumb}
                aria-current={position === crumbs.length - 1 ? "page" : undefined}
              >
                {crumb}
              </li>
            ))}
          </ol>
        </nav>
      </header>
      <div className="meridian-pane__body">{props.children}</div>
    </section>
  );
}
