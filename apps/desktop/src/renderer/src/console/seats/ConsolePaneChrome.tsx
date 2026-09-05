// The chrome every deck pane wears, and the two tables that make it legible.
//
// `Spec-023 §Console Design (Meridian)` puts one entity in one pane behind a single
// mount door, and §The surface set fixes three of the head's contents — panes are
// "each headed by an entity breadcrumb and a kind glyph, with the actor's hue as the
// focus ring". What no committed document says is that each of the six families should
// draw its own frame, and six frames drawn independently is six spacings, six
// breadcrumb separators, six control strips, and six answers to where the focus ring
// goes. So the frame is drawn once, here, and a pane body is what a family writes.
//
// WHY IT LIVES IN `seats/`. Every pane BODY lives inside the family that owns it, a
// view family may not import another view family, and the deck that provides the two
// host controls is itself a view family. So the chrome cannot sit in the deck, and it
// cannot sit in whichever family happened to need it first. `seats/` is "the contracts
// through which view families hand each other bodies" — the lowest family that already
// owns `PaneKind` and sits above `store/` for `ConsoleEntityRef` — and it is where a
// contract six siblings share belongs.
//
// THE CONTROL STRIP IS THIS MODULE'S, because no committed document enumerates it: the
// kind's own actions, open-in-window where the host permits it (the auxiliary windows
// §The surface set names), and close. Both host controls arrive either explicitly, from
// a caller that owns the pane's lifetime, or from `pane-controls.ts`'s context, which
// the deck provides around every pane body. Explicit wins, so a host that mounts a pane
// outside a deck and still owns its lifetime is not forced through a context. Both
// absent, NEITHER CONTROL RENDERS: a control whose act nobody can perform is left out
// rather than drawn disabled — the absent-not-disabled rule
// `src/shared/auxiliary-routes.ts` applies to the Window menu, applied here.
//
// AND THE HEAD IS ALSO THE DRAG HANDLE. `Spec-023 §Console Libraries` puts pointer
// reorder on `@atlaskit/pragmatic-drag-and-drop`, which binds to an element. The head
// is the strip that means "this pane" in every deck a person has used, and making the
// whole pane draggable would turn selecting text in a body into the start of a drag.
// The registration arrives through the same host context the two controls do, so a
// pane rendered outside a deck is simply not draggable — the absent-not-disabled rule
// again, applied to a gesture.
//
// ITS STYLESHEET IS IMPORTED BY THE FAMILY DOOR, `seats/index.ts`, which is where
// every other console family imports its own — `primitives/index.ts` and
// `frame/index.ts` are the precedent and `apps/desktop/AGENTS.md` is the rule. The
// door is edited once, here, rather than by each of the six branches that add a body,
// so nothing about the sheet is a line six people have to agree on.

import { useId } from "react";

import { Glyph, InlineRefusal } from "../primitives/index.js";
import { type ConsoleEntityRef } from "../store/index.js";
import { type GlyphName } from "../tokens/index.js";
import { PaneBreadcrumb } from "./PaneBreadcrumb.js";
import { PANE_CONTROL_GLYPH_SIZE, usePaneControls } from "./pane-controls.js";
import { type PaneKind } from "./pane-kinds.js";
import { type ConsolePaneContext } from "./pane-registry.js";

/**
 * The glyph each pane kind wears, total over the closed set.
 *
 * `Record<PaneKind, …>` rather than a lookup with a fallback: a twelfth pane kind
 * would be a `Spec-023` amendment, and it should fail to compile here rather than
 * render as a nameless square in whichever deck first opened it. Several kinds share a
 * glyph on purpose — `runs` is a list OF runs and `workflow-run` is a run OF a
 * workflow — and inventing a distinct mark for each would grow the glyph family past
 * what a person can hold, which is the cost `tokens/glyphs.ts` names.
 */
export const GLYPH_BY_PANE_KIND: Readonly<Record<PaneKind, GlyphName>> = {
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
 * What a pane kind is called, everywhere it is called anything.
 *
 * One spelling serves the heading, the trail's current crumb, the open-in-window
 * label, and the mismatch refusal, which is why the ledger's `title` prop is gone
 * rather than kept as an override: a caller able to pass "Runs" to one pane and "Run
 * list" to the next is a deck that reads as two products.
 *
 * Total for `GLYPH_BY_PANE_KIND`'s reason, and separate from the kind string because
 * the kind is a wire-shaped identifier (`workflow-run`) and a person reads a phrase
 * (`Workflow run`).
 */
export const TITLE_BY_PANE_KIND: Readonly<Record<PaneKind, string>> = {
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
 * How large the kind glyph is drawn, in CSS pixels.
 *
 * Larger than `PANE_CONTROL_GLYPH_SIZE`, and not by preference: this mark sits beside
 * the 600-weight current crumb and is the pane's identity, while a control glyph sits
 * inside a quiet 26 px target and a separator sits between two ids.
 */
const PANE_KIND_GLYPH_SIZE = 16;

/** The subsystem a pane-composition refusal names as its author. */
const PANE_COMPOSITION_ORIGIN = "pane-composition";

/** The context a body of one pane kind is handed, narrowed to that kind's arm. */
export type PaneContextOf<TKind extends PaneKind> = Extract<ConsolePaneContext, { kind: TKind }>;

/**
 * Adapt a body written for ONE pane kind into the render the registry stores.
 *
 * `ConsolePaneDescriptor.render` takes the whole `ConsolePaneContext` union, because
 * one registry holds every kind. A body does not: an inspector reads an entity the
 * runs pane's arm does not carry, which is the property the kind-scoped address union
 * exists to hold. So the narrowing happens once, here, rather than six times in six
 * families with six different answers for the arm that cannot be served.
 *
 * A MISMATCH IS A RENDERED REFUSAL AND NEVER A THROW. The deck looks a body up BY kind
 * and hands it a context addressed at that kind, so the arm below is unreachable
 * through the deck — but the two untyped boundaries (a restored layout row, a typed
 * route) are where an address arrives without the compiler, and `core/refusal.ts`'s
 * rule is that one bad row loses that row rather than the deck. A throw here would take
 * the whole window down for a pane; the refusal keeps the frame and names what was
 * asked for.
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

/** Carries the pane's attributed hue into the focus treatments, as `LedgerRow` does. */
interface PaneFocusRingStyle extends React.CSSProperties {
  readonly "--meridian-pane-hue": string;
}

export interface ConsolePaneChromeProps {
  readonly kind: PaneKind;
  /**
   * The id the pane's `<section>` names itself by, minted here when absent.
   *
   * A prop AND a mint, because both callers exist: a host that has already written
   * `aria-controls` or a heading reference at the id it chose passes it, and a family
   * mounting a body through the registry has no id to pass and must not have to invent
   * one. `useId` is what makes the second case safe — two panes of one kind in one deck
   * would otherwise collide on any literal.
   */
  readonly headingId?: string;
  readonly sessionId: string | undefined;
  readonly channelId?: string | undefined;
  readonly runId?: string | undefined;
  readonly entity?: ConsoleEntityRef | undefined;
  /**
   * The focus treatments' colour as a `var()` reference, or `undefined` where the deck
   * has no actor to attribute the pane to. Undefined takes the neutral ring, which is
   * the fail-closed answer: an unattributed pane never borrows someone's hue.
   */
  readonly focusHue: string | undefined;
  /** The kind's own actions, rendered before the two host controls. */
  readonly actions?: React.ReactNode;
  /** Overrides the host's close, where the caller owns this pane's lifetime. */
  readonly onClose?: () => void;
  /** Overrides the host's detach, on the same terms. */
  readonly onOpenInWindow?: () => void;
  readonly children: React.ReactNode;
}

/**
 * One pane's frame: kind glyph, breadcrumb, control strip, focus treatments, body.
 *
 * The section is focusable at `tabIndex={-1}` rather than `0`. A deck holds several
 * panes and every one of them would otherwise sit in the tab order ahead of the
 * controls inside it; `-1` keeps the pane reachable programmatically — which is what a
 * deck's own focus routing needs — without spending a tab stop per pane.
 *
 * IT IS NAMED BY ITS TRAIL AND NOT BY A SECOND ATTRIBUTE. `aria-labelledby` and
 * `aria-label` cannot both name one element: the accessible-name algorithm prefers the
 * reference, so an `aria-label` beside it is text nothing ever reads. The reference
 * points at the crumb list, whose last crumb is this pane's own name — so the name is
 * "session-1 run-01 Runs" rather than "Runs" for every runs pane in the deck.
 */
export function ConsolePaneChrome(props: ConsolePaneChromeProps): React.JSX.Element {
  const mintedHeadingId = useId();
  const headingId = props.headingId ?? mintedHeadingId;
  const hostControls = usePaneControls();
  const onClose = props.onClose ?? hostControls?.onClose;
  const onOpenInWindow = props.onOpenInWindow ?? hostControls?.onOpenInWindow;
  const registerDragHandle = hostControls?.registerDragHandle;
  const title = TITLE_BY_PANE_KIND[props.kind];
  const focusRingStyle: PaneFocusRingStyle | undefined =
    props.focusHue === undefined ? undefined : { "--meridian-pane-hue": props.focusHue };

  return (
    <section
      className={`meridian-pane meridian-pane--${props.kind}`}
      aria-labelledby={headingId}
      tabIndex={-1}
      style={focusRingStyle}
    >
      <header className="meridian-pane__head" ref={registerDragHandle}>
        <span className="meridian-pane__kind">
          <Glyph name={GLYPH_BY_PANE_KIND[props.kind]} size={PANE_KIND_GLYPH_SIZE} />
        </span>
        <PaneBreadcrumb
          crumbsId={headingId}
          currentCrumb={title}
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
              aria-label={`Open this ${title.toLowerCase()} in its own window`}
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
      <div className="meridian-pane__body">{props.children}</div>
    </section>
  );
}
