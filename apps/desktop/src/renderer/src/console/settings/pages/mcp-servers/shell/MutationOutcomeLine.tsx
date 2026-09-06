import type { ReactNode } from "react";

import { Chip, InlineRefusal, Nothing, WireFigure } from "../../../../primitives/index.js";
import type { GrowthMcpLiveApplicationResult } from "../../../../bridge/index.js";
import type { McpMutationOutcome } from "./mcp-mutation.js";

/**
 * What the last mutation on one binding did — where it took effect, and what happened
 * on each live leg.
 *
 * A PARTIAL OUTCOME IS RENDERED AS A PARTIAL OUTCOME. A mutation can commit durably
 * and still fail on one session's leg, and the reply carries both facts. A surface
 * that showed one aggregate verdict would report that as a success and leave a session
 * running against a binding the operator believes is off — which is the failure this
 * whole per-leg shape exists to prevent.
 *
 * `applied` IS RENDERED VERBATIM AND NEVER TRANSLATED INTO "DONE". Where a change took
 * effect is the operator's question: `live_reconcile` reached running sessions,
 * `user_config_write` reached a file, `next_run` reaches nothing until one starts, and
 * `daemon_enforced` binds at the daemon and touches no provider configuration at all.
 * Four different facts, and one word for all of them would be the wrong word for three.
 *
 * NO LIVE RESULTS AND AN EMPTY LIST ARE DIFFERENT FACTS. The member is absent where
 * the mutation touched no live binding; it is an empty array only if the daemon says
 * so. Both are rendered, and they do not share a sentence.
 */
export function MutationOutcomeLine(props: { readonly outcome: McpMutationOutcome }): ReactNode {
  const { outcome } = props;
  if (outcome.kind === "idle") {
    return null;
  }
  if (outcome.kind === "sending") {
    return (
      <Nothing kind="not-loaded" placement="inline" title="Asking the daemon to apply this." />
    );
  }
  if (outcome.kind === "refused") {
    return (
      <p
        className="meridian-settings-page__state meridian-settings-page__state--failed"
        role="alert"
      >
        <InlineRefusal {...outcome.refusal} />
      </p>
    );
  }
  const { result } = outcome;
  return (
    <div className="meridian-mcp__outcome">
      <p className="meridian-settings-page__state">
        Applied as <Chip label={result.applied} mono />
      </p>
      {result.liveResults === undefined ? (
        <p className="meridian-settings-page__aside">
          The daemon reported no live leg for this change — nothing was holding this binding open
          when it was applied.
        </p>
      ) : (
        renderLiveResults(result.liveResults)
      )}
    </div>
  );
}

/**
 * The per-leg outcomes, one row each.
 *
 * A camelCase helper rather than a second component, on the `primitives/Nothing.tsx`
 * precedent: a `.tsx` module declares one component, and this list body has no
 * identity outside its one caller.
 */
function renderLiveResults(results: readonly GrowthMcpLiveApplicationResult[]): ReactNode {
  if (results.length === 0) {
    return (
      <p className="meridian-settings-page__aside">
        The daemon reported an empty set of live legs — it looked, and there were none.
      </p>
    );
  }
  return (
    <ul className="meridian-mcp__live-results">
      {results.map((liveResult) => (
        <li key={liveResult.bindingId} className="meridian-mcp__live-result">
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
