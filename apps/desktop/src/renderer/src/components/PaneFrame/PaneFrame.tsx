// The chrome every pane wears, drawn once so six features do not draw six frames.
//
// The control strip holds the kind's own actions and close. Close comes from an explicit prop or
// from `controls.ts`'s context (explicit wins); with neither, the control is left out rather
// than drawn disabled. The head is also the drag handle, so selecting text in a body never starts
// a drag; the registration arrives through the same context, and a pane outside a pane layout is
// simply not draggable. The pane-level key claim is a prop for the same reason: the head is not
// inside the body, and wrapping the chrome from outside would put a box around the section.
import "./PaneFrame.css";

import { useId } from "react";

import { Glyph } from "../Glyph/Glyph.js";
import { useOverlayScrollbar } from "#renderer/hooks/useOverlayScrollbar.js";
import { type EntityRef } from "#renderer/lib/entity-kinds.js";
import { GLYPH_DEFAULT_SIZE, GLYPH_SIZE_CHROME, type GlyphName } from "#renderer/styles/glyphs.js";
import { PaneBreadcrumb } from "./PaneBreadcrumb.js";
import { usePaneControls } from "./usePaneControls.js";
import { type PaneKind } from "#renderer/routing/panes/kinds.js";

/**
 * The glyph each pane kind wears, total over the closed set so a new kind fails to compile here.
 * `workflow-builder` wears the rail's workflows glyph, so the glyph set stays small.
 */
export const GLYPH_BY_PANE_KIND: Readonly<Record<PaneKind, GlyphName>> = {
  transcript: "transcript",
  inspector: "inspector",
  diff: "diff",
  "workflow-builder": "workflow",
  browser: "browser",
  terminal: "terminal",
  agents: "agent",
};

/**
 * What a pane kind is called everywhere: the heading, the trail's current crumb and the
 * mismatch refusal. Total like `GLYPH_BY_PANE_KIND`; the kind string is a wire-shaped identifier
 * (`workflow-builder`) and a person reads a phrase (`Workflow builder`).
 */
export const TITLE_BY_PANE_KIND: Readonly<Record<PaneKind, string>> = {
  transcript: "Transcript",
  inspector: "Inspector",
  diff: "Review",
  "workflow-builder": "Workflow builder",
  browser: "Preview",
  terminal: "Terminal",
  agents: "Sidekicks",
};

/**
 * The kind glyph's size in CSS pixels: the default size, larger than the chrome's control glyphs.
 */
const PANE_KIND_GLYPH_SIZE = GLYPH_DEFAULT_SIZE;

/** Props for `PaneFrame`: its kind, the address it is scoped to, and its body. */
export interface PaneFrameProps {
  readonly kind: PaneKind;
  /** The id the pane's `<section>` names itself by; minted with `useId` when absent. */
  readonly headingId?: string;
  readonly sessionId: string | undefined;
  readonly runId?: string | undefined;
  readonly entity?: EntityRef | undefined;
  /** The kind's own actions, rendered before the close control. */
  readonly actions?: React.ReactNode;
  /** Overrides the host's close, where the caller owns this pane's lifetime. */
  readonly onClose?: () => void;
  /**
   * A pane-level key claim, bound in the capture phase on the `<section>` so it covers the head
   * as well as the body and is decided before a focused input sees the key. The frame never
   * calls `preventDefault` or `stopPropagation` for the caller.
   */
  readonly onKeyDownCapture?: (event: React.KeyboardEvent<HTMLElement>) => void;
  readonly children?: React.ReactNode;
}

/**
 * One pane's frame: kind glyph, breadcrumb, control strip, body. The section has `tabIndex={-1}`
 * so the pane layout can route focus to it without a tab stop per pane. It is named by its whole
 * trail through `aria-labelledby`, so its name is "session-1 worktree-01 Inspector" rather than
 * "Inspector" for every such pane.
 */
export function PaneFrame(props: PaneFrameProps): React.JSX.Element {
  const mintedHeadingId = useId();
  const headingId = props.headingId ?? mintedHeadingId;
  const hostControls = usePaneControls();
  const onClose = props.onClose ?? hostControls?.onClose;
  const registerDragHandle = hostControls?.registerDragHandle;
  const title = TITLE_BY_PANE_KIND[props.kind];
  const bodyScrollbarRef = useOverlayScrollbar<HTMLDivElement>();

  return (
    <section
      className={`meridian-pane meridian-pane--${props.kind} meridian-focus-inset`}
      aria-labelledby={headingId}
      tabIndex={-1}
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
      <div className="meridian-pane__body" ref={bodyScrollbarRef}>
        {props.children}
      </div>
    </section>
  );
}
