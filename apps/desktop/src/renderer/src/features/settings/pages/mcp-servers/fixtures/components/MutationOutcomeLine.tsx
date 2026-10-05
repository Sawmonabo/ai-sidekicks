import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { McpLiveApplicationResult } from "@ai-sidekicks/contracts/mcp/mcp";
import { mcpLiveLegKeyOf } from "../live-leg-key.js";
import type { McpMutationOutcome } from "../mcp-mutation.js";

/**
 * What the last mutation on one binding did: where it took effect, and what happened on each
 * live leg.
 *
 * A partial outcome renders as one: a mutation can commit durably and fail on one session's
 * leg, and one aggregate verdict would leave a session running against a binding the person
 * believes is off. `applied` renders verbatim, never as "done": `live_reconcile` reached
 * running sessions, `user_config_write` reached a file, `next_run` reaches nothing until a run
 * starts, and `daemon_enforced` binds at the daemon and touches no provider configuration. Absent
 * live results (the mutation touched no live binding) and an empty list (the daemon looked and
 * found none) are different facts with different sentences.
 */
export function MutationOutcomeLine(props: { readonly outcome: McpMutationOutcome }): ReactNode {
  const { outcome } = props;
  if (outcome.kind === "idle") {
    return null;
  }
  if (outcome.kind === "sending") {
    return (
      <Nothing
        kind="not-loaded"
        placement="inline"
        title="Asking the background service to apply this."
      />
    );
  }
  if (outcome.kind === "refused") {
    return <InlineRefusal code={outcome.refusal.code} detail={outcome.refusal.detail} />;
  }
  const { result } = outcome;
  return (
    <div className="meridian-mcp__outcome">
      <p className="meridian-settings-page__state">
        Applied as <Chip label={result.applied} mono />
      </p>
      {result.liveResults === undefined ? (
        <p className="meridian-settings-page__aside">
          The background service reported no live leg for this change — nothing was holding this
          binding open when it was applied.
        </p>
      ) : (
        renderLiveResults(result.liveResults)
      )}
    </div>
  );
}

/**
 * The per-leg outcomes, one row each, keyed by the same pair and encoder as the leg list.
 * A helper rather than a second component: one component per file.
 */
function renderLiveResults(results: readonly McpLiveApplicationResult[]): ReactNode {
  if (results.length === 0) {
    return (
      <p className="meridian-settings-page__aside">
        The background service reported an empty set of live legs — it looked, and there were none.
      </p>
    );
  }
  return (
    <ul className="meridian-mcp__live-results">
      {results.map((liveResult) => (
        <li key={mcpLiveLegKeyOf(liveResult)} className="meridian-mcp__live-result">
          <Chip
            label={liveResult.outcome}
            tone={liveResult.outcome === "applied" ? "neutral" : "failure"}
          />
          <span className="meridian-settings-page__aside">in session</span>
          <WireFigure value={liveResult.sessionId} />
          {liveResult.errorCode === undefined ? null : <WireFigure value={liveResult.errorCode} />}
          {liveResult.detail === undefined ? null : (
            <span className="meridian-settings-page__aside">{liveResult.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
