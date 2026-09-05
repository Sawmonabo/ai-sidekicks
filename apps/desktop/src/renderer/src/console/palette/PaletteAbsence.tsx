// The palette's five kinds of nothing.
//
// `Spec-023 §Console Design (Meridian)` rule 8: "A renderer that collapses two of
// these into one is wrong." The palette can be empty for five distinct reasons
// and renders five distinct things — a skeleton while contributions are still
// arriving, three different quiet lines (nothing registered / nothing offered
// here / nothing matched), a red-edged row when a `when` clause failed to parse
// and hid its command, a dotted badge when the frame has not evaluated its
// context keys, and a clock badge while something is still being computed. An
// empty query is NOT "no results".
//
// This is its own module rather than a block inside `PaletteOverlay.tsx` because
// the choice between the five is a decision with an order (below), and the
// overlay's job is composition — the combobox, the dialog, and the open chord.
// The readiness value the frame supplies lives here too, since the only thing it
// exists to do is pick one of these.
//
// WHAT IS HERE IS THE CHOICE, and the one shape three of the arms share is beside
// it: `QuietAbsence.tsx` renders a headline and a line, which is what "nothing
// registered", "nothing offered here", and "nothing matched" all look like. The
// skeleton, the two badge arms, and the two error arms are the arms themselves —
// each is rendered once, from one branch, and takes nothing a caller supplies.

import { formatCount } from "../primitives/index.js";
import type { CommandRegistry } from "./command-registry.js";
import { QuietAbsence } from "./QuietAbsence.js";

/**
 * Why the palette might have nothing to show that is not about the query.
 *
 * Supplied by the frame, because only the frame knows whether command
 * contributions have finished arriving or whether its context keys have been
 * evaluated. Defaults to `ready`, so a surface that does not care says nothing.
 */
export type PaletteReadiness =
  | { readonly status: "ready" }
  /** not loaded — contributions are still arriving. */
  | { readonly status: "loading" }
  /** unknown, still computing — a value the offer set depends on is in flight. */
  | { readonly status: "computing"; readonly detail: string }
  /** not checked — the frame has not evaluated the context keys yet. */
  | { readonly status: "unchecked"; readonly detail: string }
  /** error — the command source itself failed. Code and message render verbatim. */
  | { readonly status: "failed"; readonly code: string; readonly message: string };

export interface PaletteAbsenceProps {
  readonly readiness: PaletteReadiness;
  readonly registry: CommandRegistry;
  readonly query: string;
  /** How many commands are offered in this context, ignoring the query. */
  readonly visibleCount: number;
}

/**
 * Decide which absence to render.
 *
 * The order is deliberate. A parse failure outranks every quiet absence, because
 * a hidden command with no visible cause looks exactly like a command nobody
 * contributed, and those two absences need different fixes. Readiness outranks
 * the query arms, because "still arriving" is not "nothing matched".
 */
export function PaletteAbsence(props: PaletteAbsenceProps): React.JSX.Element {
  const { readiness, registry, query, visibleCount } = props;

  if (readiness.status === "loading") {
    // Inline rather than a component of its own: three rows with nothing in them,
    // rendered from this one branch and taking nothing a caller supplies. A
    // component here would be a name for markup that has no second reader.
    return (
      <div className="console-palette__absence" aria-hidden="true">
        <div className="console-palette__skeleton-row" />
        <div className="console-palette__skeleton-row" />
        <div className="console-palette__skeleton-row" />
      </div>
    );
  }

  if (readiness.status === "failed") {
    return (
      <div className="console-palette__absence console-palette__absence--error">
        <span className="console-palette__absence-headline">The command list could not load</span>
        <span className="console-palette__error-code">{readiness.code}</span>
        <span className="console-palette__absence-detail">{readiness.message}</span>
      </div>
    );
  }

  const clauseDiagnostics = registry.clauseDiagnostics();
  if (clauseDiagnostics.length > 0) {
    return (
      <div className="console-palette__absence console-palette__absence--error">
        <span className="console-palette__absence-headline">
          {formatCount(clauseDiagnostics.length)} command
          {clauseDiagnostics.length === 1 ? " is" : "s are"} hidden by a scope that did not parse
        </span>
        <ul className="console-palette__error-list">
          {clauseDiagnostics.map((diagnostic) => (
            <li key={diagnostic.commandId}>
              <span className="console-palette__error-code">{diagnostic.commandId}</span>
              {` — ${diagnostic.error.message}`}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (readiness.status === "computing") {
    return (
      <div className="console-palette__absence">
        <span className="console-palette__badge console-palette__badge--computing">
          {"\u{1F553} Still computing"}
        </span>
        <span className="console-palette__absence-detail">{readiness.detail}</span>
      </div>
    );
  }

  if (readiness.status === "unchecked") {
    return (
      <div className="console-palette__absence">
        <span className="console-palette__badge">Not checked</span>
        <span className="console-palette__absence-detail">{readiness.detail}</span>
      </div>
    );
  }

  if (registry.size === 0) {
    return (
      <QuietAbsence
        headline="No commands are registered in this window"
        detail="An auxiliary window carries only the commands it can perform. The main window has the full set."
      />
    );
  }

  if (query.trim().length === 0 && visibleCount === 0) {
    return (
      <QuietAbsence
        headline="No commands apply here"
        detail="Every registered command is scoped to a context this window is not in. Open a session to reach the session commands."
      />
    );
  }

  return (
    <QuietAbsence
      headline={`Nothing matched "${query.trim()}"`}
      detail="Try fewer characters, or the name of the category the command sits under."
    />
  );
}
