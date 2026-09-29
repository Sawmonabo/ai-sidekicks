// The chrome every deck pane wears, and the two tables that make it legible.
//
// One entity lives in one pane behind a single mount door, and three of the head's
// contents are fixed — panes are each headed by an entity breadcrumb and a kind glyph,
// with the actor's hue as the focus ring. What no committed document says is that each
// of the six families should draw its own frame, and six frames drawn independently is
// six spacings, six breadcrumb separators, six control strips, and six answers to where
// the focus ring goes. So the frame is drawn once, here, and a pane body is what a family writes.
//
// THE CONTROL STRIP IS THIS MODULE'S, because no committed document enumerates it: the
// kind's own actions and close. The close arrives either explicitly, from a caller that
// owns the pane's lifetime, or from `pane-controls.ts`'s context, which the deck
// provides around every pane body. Explicit wins, so a host that mounts a pane outside a
// deck and still owns its lifetime is not forced through a context. With neither, THE
// CONTROL DOES NOT RENDER: a control whose act nobody can perform is left out rather
// than drawn disabled.
//
// AND THE HEAD IS ALSO THE DRAG HANDLE. Pointer reorder runs on
// `@atlaskit/pragmatic-drag-and-drop`, which binds to an element. The head is the
// strip that means "this pane" in every deck a person has used, and making the whole
// pane draggable would turn selecting text in a body into the start of a drag.
// The registration arrives through the same host context the two controls do, so a
// pane rendered outside a deck is simply not draggable — the absent-not-disabled rule
// again, applied to a gesture.
//
// AND SO IS THE PANE-LEVEL KEY CLAIM, for the same structural reason. A chord that
// means "this pane" has to be heard wherever focus is inside the pane, and the head
// is not inside the body — so a family that wants one cannot get it by wrapping its
// own body, and wrapping the chrome from OUTSIDE puts an element between the deck and
// the section it lays out. The browser pane shipped exactly that adapter, with
// `display: contents` on it to stop the deck seeing a box; the prop below is what it
// was standing in for.
//
import "./PaneFrame.css";

import { useId } from "react";

import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { type ConsoleEntityRef } from "@renderer/lib/entity-kinds.js";
import { GLYPH_DEFAULT_SIZE, GLYPH_SIZE_CHROME, type GlyphName } from "@renderer/styles/glyphs.js";
import { PaneBreadcrumb } from "./PaneBreadcrumb.js";
import { usePaneControls } from "./usePaneControls.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
/**
 * The glyph each pane kind wears, total over the closed set.
 *
 * `Record<PaneKind, …>` rather than a lookup with a fallback: a twelfth pane kind
 * would be a decision taken outside this package, and it should fail to compile here
 * rather than render as a nameless square in whichever deck first opened it. Several
 * kinds share a glyph on purpose — `runs` is a list OF runs and `workflow-run` is a run OF a
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
 * One spelling serves the heading, the trail's current crumb, and the mismatch
 * refusal, which is why the ledger's `title` prop is gone rather than kept as an
 * override: a caller able to pass "Runs" to one pane and "Run list" to the next is a
 * deck that reads as two products.
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
 * Larger than `GLYPH_SIZE_CHROME`, and not by preference: this mark sits beside the
 * 600-weight current crumb and is the pane's identity, while a control glyph sits
 * inside a quiet 26 px target and a separator sits between two ids. It is the
 * console's default size and takes it from the token rather than restating `16`,
 * which is what makes the two sizes one ratio instead of two literals.
 */
const PANE_KIND_GLYPH_SIZE = GLYPH_DEFAULT_SIZE;

/** What one pane's frame needs: its kind, the address it is scoped to, and its body. */
export interface PaneFrameProps {
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
  readonly runId?: string | undefined;
  readonly entity?: ConsoleEntityRef | undefined;
  /**
   * The focus treatments' color as a `var()` reference, or `undefined` where the deck
   * has no actor to attribute the pane to. Undefined takes the neutral ring, which is
   * the fail-closed answer: an unattributed pane never borrows someone's hue.
   */
  readonly focusHue: string | undefined;
  /** The kind's own actions, rendered before the close control. */
  readonly actions?: React.ReactNode;
  /** Overrides the host's close, where the caller owns this pane's lifetime. */
  readonly onClose?: () => void;
  /**
   * A pane-level key claim, bound on the chrome's own `<section>`.
   *
   * IT IS ON THE SECTION AND NOT ON THE BODY, and that is the whole reason the seam
   * exists. What a pane-level chord protects is the WINDOW, so the claim has to cover
   * every element the chord can be pressed on while this pane has focus — and the head
   * this chrome draws is not a descendant of the body a family supplies. A family that
   * wraps `<ConsolePaneChrome>` from the outside to get the capture is drawing a second
   * element around a laid-out pane; the one that shipped had to declare
   * `display: contents` to stop the deck seeing a box, which is an adapter that exists
   * only because this prop did not.
   *
   * CAPTURE and not bubble, on the same reasoning: the claim is the pane's, so it is
   * decided before whatever the person was typing into sees the key. A handler that
   * does not claim the event simply returns — nothing here calls `preventDefault` or
   * `stopPropagation` on the caller's behalf, because which keys belong to the pane is
   * the pane's question and not this frame's.
   */
  readonly onKeyDownCapture?: (event: React.KeyboardEvent<HTMLElement>) => void;
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
export function ConsolePaneChrome(props: PaneFrameProps): React.JSX.Element {
  const mintedHeadingId = useId();
  const headingId = props.headingId ?? mintedHeadingId;
  const hostControls = usePaneControls();
  const onClose = props.onClose ?? hostControls?.onClose;
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
      onKeyDownCapture={props.onKeyDownCapture}
    >
      <header className="meridian-pane__head" ref={registerDragHandle}>
        <span className="meridian-pane__kind">
          <Glyph name={GLYPH_BY_PANE_KIND[props.kind]} size={PANE_KIND_GLYPH_SIZE} />
        </span>
        <PaneBreadcrumb
          crumbsId={headingId}
          currentCrumb={title}
          sessionId={props.sessionId}
          runId={props.runId}
          entity={props.entity}
        />
        <span className="meridian-pane__controls">
          {props.actions}
          {onClose === undefined ? null : (
            <button
              type="button"
              className="meridian-pane__control"
              onClick={onClose}
              aria-label="Close this pane"
            >
              <Glyph name="close" size={GLYPH_SIZE_CHROME} />
            </button>
          )}
        </span>
      </header>
      <div className="meridian-pane__body">{props.children}</div>
    </section>
  );
}

/** Carries the pane's attributed hue into the focus treatments, as `LedgerRow` does. */
interface PaneFocusRingStyle extends React.CSSProperties {
  readonly "--meridian-pane-hue": string;
}
