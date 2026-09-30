// What the palette renders when it has nothing to list. Each absence renders differently because
// the next move differs, and an empty query is not "no results". The three quiet arms share
// `QuietEmptyState.tsx`; the skeleton, badge and error arms render once, from one branch each.

import { formatCount } from "@renderer/lib/wire-figures.js";
import type { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { QuietEmptyState } from "./QuietEmptyState.js";

/**
 * Why the palette might have nothing to show that is not about the query. The frame supplies it
 * because only the frame knows whether contributions arrived and its context keys were evaluated.
 * Defaults to `ready`.
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

/** What the empty state reads to choose which absence to render. */
export interface PaletteEmptyStateProps {
  readonly readiness: PaletteReadiness;
  readonly registry: CommandRegistry;
  readonly query: string;
  /** How many commands are offered in this context, ignoring the query. */
  readonly visibleCount: number;
}

/**
 * Renders the absence that applies. A parse failure outranks the quiet arms, because a hidden
 * command looks like one nobody contributed; readiness outranks the query arms, because "still
 * arriving" is not "nothing matched".
 */
export function PaletteEmptyState(props: PaletteEmptyStateProps): React.JSX.Element {
  const { readiness, registry, query, visibleCount } = props;

  if (readiness.status === "loading") {
    return (
      <div className="command-palette__empty-state" aria-hidden="true">
        <div className="command-palette__skeleton-row" />
        <div className="command-palette__skeleton-row" />
        <div className="command-palette__skeleton-row" />
      </div>
    );
  }

  if (readiness.status === "failed") {
    return (
      <div className="command-palette__empty-state command-palette__empty-state--error">
        <span className="command-palette__empty-state-headline">
          The command list could not load
        </span>
        <span className="command-palette__error-code">{readiness.code}</span>
        <span className="command-palette__empty-state-detail">{readiness.message}</span>
      </div>
    );
  }

  const clauseDiagnostics = registry.clauseDiagnostics();
  if (clauseDiagnostics.length > 0) {
    return (
      <div className="command-palette__empty-state command-palette__empty-state--error">
        <span className="command-palette__empty-state-headline">
          {formatCount(clauseDiagnostics.length)} command
          {clauseDiagnostics.length === 1 ? " is" : "s are"} hidden by a scope that did not parse
        </span>
        <ul className="command-palette__error-list">
          {clauseDiagnostics.map((diagnostic) => (
            <li key={diagnostic.commandId}>
              <span className="command-palette__error-code">{diagnostic.commandId}</span>
              {` — ${diagnostic.error.message}`}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (readiness.status === "computing") {
    return (
      <div className="command-palette__empty-state">
        <span className="command-palette__badge command-palette__badge--computing">
          {"\u{1F553} Still computing"}
        </span>
        <span className="command-palette__empty-state-detail">{readiness.detail}</span>
      </div>
    );
  }

  if (readiness.status === "unchecked") {
    return (
      <div className="command-palette__empty-state">
        <span className="command-palette__badge">Not checked</span>
        <span className="command-palette__empty-state-detail">{readiness.detail}</span>
      </div>
    );
  }

  if (registry.size === 0) {
    return (
      <QuietEmptyState
        headline="No commands are registered in this window"
        detail="An auxiliary window carries only the commands it can perform. The main window has the full set."
      />
    );
  }

  if (query.trim().length === 0 && visibleCount === 0) {
    return (
      <QuietEmptyState
        headline="No commands apply here"
        detail="Every registered command is scoped to a context this window is not in. Open a session to reach the session commands."
      />
    );
  }

  return (
    <QuietEmptyState
      headline={`Nothing matched "${query.trim()}"`}
      detail="Try fewer characters, or the name of the category the command sits under."
    />
  );
}
