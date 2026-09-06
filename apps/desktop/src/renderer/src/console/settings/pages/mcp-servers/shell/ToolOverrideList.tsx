import type { ReactNode } from "react";

import { Chip, Nothing, WireFigure } from "../../../../primitives/index.js";
import type { GrowthMcpToolOverride } from "../../../../bridge/index.js";

/**
 * The tool overrides pinned on one binding, by facet.
 *
 * AN ABSENT FACET IS RENDERED AS AN ABSENCE AND NEVER AS A DEFAULT. Every facet is
 * independently optional and at least one is present, and an absent one means
 * "inherit" — so a row that filled the blank with the value the daemon would fall back
 * to would be re-deriving the fallback here. `idempotencyClass` is the case that
 * matters: its floor is the manual-reconcile class, recovery depends on it, and a
 * renderer naming that floor would be a second source of truth for a decision the
 * daemon owns.
 *
 * THE LIST IS RENDERED AND NEVER SORTED. The daemon serves the overrides in the order
 * it holds them; re-ordering them here would make two consoles disagree about what one
 * binding declares, for no gain a person could name.
 */
export function ToolOverrideList(props: {
  readonly overrides: readonly GrowthMcpToolOverride[];
}): ReactNode {
  const { overrides } = props;
  if (overrides.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No tool on this binding carries an override."
        detail="Every tool it exposes is offered on the binding's own terms."
      />
    );
  }
  return (
    <ul className="meridian-mcp__overrides">
      {overrides.map((override) => (
        <li key={override.toolName} className="meridian-mcp__override">
          <WireFigure value={override.toolName} />
          {override.enabled === undefined ? null : (
            <Chip
              label={override.enabled ? "enabled" : "disabled"}
              tone={override.enabled ? "neutral" : "attention"}
            />
          )}
          {override.approvalMode === undefined ? null : <Chip label={override.approvalMode} mono />}
          {override.idempotencyClass === undefined ? null : (
            <Chip label={override.idempotencyClass} mono />
          )}
        </li>
      ))}
    </ul>
  );
}
