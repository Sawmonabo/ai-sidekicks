// The Agents pane's list of what the session dispatched: one tree of every child run and provider
// helper in the order the work happened, each row naming its agent, model, effort and the agent
// asked for a peer call, with its tokens and spend in the foot. A finished row dims where it stands.
// The tree is one read of the daemon's child-run links, held by the session's models for as long
// as this list is mounted and asked again on every run, helper or refused-create event.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ChildRunLink } from "@ai-sidekicks/contracts/orchestration";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { formatCompactCount, formatUsdMicros } from "#renderer/lib/wire/figures.js";
import { agentNameOf, type SessionAgentListState } from "#renderer/store/agents/list.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import type { ChildRunLinksRead } from "#renderer/services/daemon/child-run-links.js";
import { childRunTreeRows, isChildRunSettled } from "../child-run-tree.js";
import { type AgentsPaneModels } from "../models.js";

/** What the list reads from: the session's models and its agent list, which names each child. */
export interface ChildRunTreeProps {
  readonly models: AgentsPaneModels;
  readonly agentListState: SessionAgentListState;
}

/** The session's dispatched children as one tree, or the line saying why there is none. */
export function ChildRunTree(props: ChildRunTreeProps): React.JSX.Element {
  const read = useChildRunLinksLease(props.models);
  const state = usePushDrivenRead(read);
  const readAgain = useCallback(() => {
    read?.refresh("user-request");
  }, [read]);
  const rows = useMemo(
    () => (state.kind === "loaded" ? childRunTreeRows(state.value.children) : []),
    [state],
  );

  if (state.kind === "not-loaded") {
    return <Nothing kind="not-loaded" placement="block" title="Loading dispatched sidekicks…" />;
  }
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title="Couldn't load dispatched sidekicks"
        action={<TryAgainButton onPress={readAgain} />}
        attempt={state.refusal}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Nothing kind="empty" placement="block" title="No sidekicks dispatched from this session." />
    );
  }
  return (
    <ul className="meridian-child-runs">
      {rows.map((row) => (
        <ChildRunRow
          key={row.key}
          link={row.link}
          depth={row.depth}
          agentName={
            row.link.kind === "run"
              ? agentNameOf(props.agentListState, row.link.agentId)
              : undefined
          }
        />
      ))}
    </ul>
  );
}

/**
 * Hold a lease on the session's child-run links read while mounted, started from the effect so a
 * discarded render opens nothing, and given back on unmount.
 */
function useChildRunLinksLease(models: AgentsPaneModels): ChildRunLinksRead | undefined {
  const [read, setRead] = useState<ChildRunLinksRead | undefined>(undefined);
  useEffect(() => {
    const lease = models.acquireChildRunLinks();
    lease.read.start();
    setRead(lease.read);
    return () => {
      lease.release();
      setRead(undefined);
    };
  }, [models]);
  return read;
}

/** One child: its name line, a failed child's mark, and its figures. */
function ChildRunRow(props: {
  readonly link: ChildRunLink;
  readonly depth: number;
  /** The child's agent's name; absent for a provider's helper or before the agent list serves. */
  readonly agentName: string | undefined;
}): React.JSX.Element {
  const clockLocale = useClockLocale();
  const { head, state } = props.link;
  const className = [
    "meridian-child-runs__row",
    props.depth > 0 ? "meridian-child-runs__row--nested" : undefined,
    isChildRunSettled(state) ? "meridian-child-runs__row--settled" : undefined,
  ]
    .filter((name) => name !== undefined)
    .join(" ");
  const named = [props.agentName, head.modelId, head.effort].filter(
    (part): part is string => part !== undefined,
  );
  return (
    <li
      className={className}
      style={{ "--meridian-child-run-depth": props.depth } as React.CSSProperties}
      data-state={state}
      data-depth={props.depth}
    >
      <p className="meridian-child-runs__line">
        {named.join(" · ")}
        {head.viaAgentName === undefined ? null : (
          <span className="meridian-child-runs__via"> via {head.viaAgentName}</span>
        )}
      </p>
      {state === "failed" ? <p className="meridian-child-runs__failed">✗ failed</p> : null}
      <p className="meridian-child-runs__foot">
        {`${formatCompactCount(head.tokens, clockLocale)} tokens · ${formatUsdMicros(head.spendUsdMicros)}`}
      </p>
    </li>
  );
}
