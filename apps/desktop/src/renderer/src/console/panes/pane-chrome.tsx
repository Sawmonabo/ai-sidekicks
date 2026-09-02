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
// `panes/runs/`, `panes/approvals/`, and `panes/inspector/` are the first three
// bodies and they are all one family's. `panes/timeline/`, `panes/diff/`, and the
// rest belong to other families, and every one of them wants this frame. Putting it
// inside the first pane that needed it would make five later families deep-import a
// sibling pane's directory; `apps/desktop/AGENTS.md` says to hoist on the second
// use, and the second use arrived in the same lane as the first.
//
// WHY THE STYLESHEET IS IMPORTED HERE
//
// `panes/index.ts` is the seat board six concurrent branches each replace one line
// in, and every edit above those lines is an edit they all make. This module is the
// single edge into the sheet instead: every pane that renders chrome renders it
// through this component, so a pane can no more arrive without its CSS than a
// primitive can.

import { type ConsoleEntityRef } from "../store/index.js";
import { type PaneKind } from "../workspace/index.js";
import { Glyph, type GlyphName } from "../primitives/index.js";

import "./pane-chrome.css";

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
 * Shared rather than spelled per pane: `ConsolePaneAddress.entity` is `undefined`
 * for the session-scoped kinds, and three panes each writing their own conditional
 * is three chances to render "undefined undefined" in a breadcrumb. The identifier
 * is wire-verbatim — it is a string, so it is rendered as received.
 */
export function paneScopeCrumbs(entity: ConsoleEntityRef | undefined): readonly string[] {
  return entity === undefined ? ["Session"] : ["Session", `${entity.kind} ${entity.id}`];
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
