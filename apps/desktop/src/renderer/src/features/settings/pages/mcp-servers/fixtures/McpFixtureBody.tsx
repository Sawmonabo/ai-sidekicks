// The MCP servers fixture body: the server list, the per-leg disclosure, the tool overrides and
// the mutation outcomes, drawn from the reading and the calls it is handed.
//
// IT AUTHORS NONE OF THE THINGS THE MCP PAGE MUST NOT AUTHOR. It composes no aggregate
// status — the daemon's arrives on the row and is rendered. It derives no eligibility —
// every control is offered. It renders no configuration value, environment-variable
// value, header value, token, or authorization URL — the wire carries names in place of
// all of them, so there is nothing here to withhold.
//
// THE OUTCOME LEDGER IS PER BINDING AND BOUNDED BY THE INVENTORY. One entry per row,
// keyed by the row's own scope-qualified identity and replaced in place, so a page
// left open through many presses holds one outcome per binding rather than a growing
// list of them.
//
// AND IT BELONGS TO THE BRIDGE IT WAS PRODUCED THROUGH. The provider replaces the
// bridge under a live mount — a reconnect, a second window's own instance, the
// fixture's scenario switch — and it does so IN PLACE, with no remount. A ledger held
// in ordinary component state survived that, so a settled outcome, or a call still out
// through the retired transport, rendered beside the replacement's inventory for the
// same binding and reported that the new transport had applied a mutation
// it had never been asked to perform. The map therefore rides the console's one
// subject-scoped holder with the bridge as its subject: it re-seeds DURING the render
// that first sees a new bridge, so no committed frame carries the previous one's
// outcomes, and a publisher captured under the retired bridge writes nothing rather
// than overwriting what the replacement said. The refresh beside the settlement needs
// no second guard — a superseded read has already been disposed, and a disposed read
// refreshes nothing.

import "./mcp-fixture-body.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { McpServerBindingRef } from "@ai-sidekicks/contracts";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { usePushDrivenRead } from "@renderer/store/reads/hooks/usePushDrivenRead.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  createMcpInventoryRead,
  type ListMcpInventory,
  type SubscribeMcpInventoryChanges,
} from "./mcp-inventory-reading.js";
import {
  IDLE_MCP_MUTATION,
  mcpBindingKeyOf,
  mintIdempotencyKey,
  setBindingEnabled,
  setBindingTrust,
  type IdempotencyKeyMinter,
  type McpMutationOutcome,
  type SendMcpEnabled,
  type SendMcpTrust,
} from "./mcp-mutation.js";
import { ServerRow } from "./components/ServerRow.js";

/** The daemon verbs the fixture body drives. */
export interface McpServerOperations {
  readonly listInventory: ListMcpInventory;
  readonly subscribeInventoryChanges: SubscribeMcpInventoryChanges;
  readonly sendEnabled: SendMcpEnabled;
  readonly sendTrust: SendMcpTrust;
}

/** The MCP servers list with its per-row controls, driven by the calls in `operations`. */
export function McpFixtureBody(props: {
  readonly bridge: PlatformBridge;
  /** Held stable by the caller: a new object restarts the inventory read. */
  readonly operations: McpServerOperations;
  /** Injected so a suite can assert that one press reused one key. */
  readonly mintKey?: IdempotencyKeyMinter;
}): ReactNode {
  const { bridge, operations } = props;
  const mintKey = props.mintKey ?? mintIdempotencyKey;
  // The scenario's frozen clock under the fixture, the real one otherwise, so a story
  // advances this read's coalescing window exactly when it advances everything else's.
  const clock = useClock();
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  // No key within the bridge: the ledger is about the whole node's inventory, and the
  // binding is the key INSIDE the map rather than the subject the map is held under.
  const { value: outcomes, publish: publishOutcomes } = useSubjectScopedState<
    ReadonlyMap<string, McpMutationOutcome>
  >(bridge, undefined, () => new Map());
  // The bridge is a dependency although the read takes none: the clock forwards to
  // whichever bridge is current, so a read armed under a retired bridge would wait on a
  // clock nothing advances.
  const inventoryRead = useMemo(
    () =>
      createMcpInventoryRead({
        listInventory: operations.listInventory,
        subscribeInventoryChanges: operations.subscribeInventoryChanges,
        clock,
      }),
    [bridge, operations, clock, openingOrdinal],
  );
  useEffect(() => {
    inventoryRead.start();
    return () => {
      inventoryRead.dispose();
    };
  }, [inventoryRead]);
  useEffect(() => {
    const onWindowFocus = (): void => {
      inventoryRead.refresh("window-focus");
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [inventoryRead]);
  // A SEPARATE EFFECT rather than a second listener inside the one above, because the
  // two release differently: the focus listener is the window's and the reconnect
  // subscription is the transport's, and one cleanup releasing both would be a single
  // identity for two lifetimes.
  useEffect(
    () =>
      bridge.transportReconnect.subscribe(() => {
        inventoryRead.refresh("reconnect");
      }),
    [bridge, inventoryRead],
  );

  // The update FORM rather than a value composed here, for the two reasons the holder
  // states: two presses settling in one tick would each write the map they read at
  // render and the second would erase the first, and an update refused because the
  // bridge has moved is never run at all.
  const recordOutcome = (key: string, outcome: McpMutationOutcome): void => {
    publishOutcomes((held) => new Map(held).set(key, outcome));
  };
  // A settled mutation answers with the row as it now stands, and this fixture body asks the
  // daemon again rather than splicing that row into the list it is holding. The reply
  // is authoritative about the binding it names and says nothing about the others,
  // and a page that patched one row would be maintaining a second copy of an inventory
  // whose fold it does not own.
  const dispatch = (
    binding: McpServerBindingRef,
    send: (idempotencyKey: string) => Promise<McpMutationOutcome>,
  ): void => {
    const key = mcpBindingKeyOf(binding);
    recordOutcome(key, { kind: "sending", binding });
    void send(mintKey()).then((settled) => {
      recordOutcome(key, settled);
      inventoryRead.refresh("terminal-event");
    });
  };

  const state = usePushDrivenRead(inventoryRead);
  if (state.kind === "not-loaded") {
    return (
      <Nothing kind="not-loaded" placement="block" title="Reading the servers this node governs." />
    );
  }
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title={state.refusal.code}
        detail={state.refusal.detail}
        action={
          <button
            type="button"
            className="meridian-settings-page__action"
            onClick={() => {
              setOpeningOrdinal((held) => held + 1);
            }}
          >
            Try again
          </button>
        }
      />
    );
  }
  const { servers } = state.value;
  if (servers.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="This node governs no MCP servers."
        detail="That is an ordinary state, not a failure: nothing has been registered for either provider, and an agent here reaches no MCP tool."
      />
    );
  }
  return (
    <ul className="meridian-mcp__rows">
      {servers.map((entry) => {
        const key = mcpBindingKeyOf(entry);
        const outcome = outcomes.get(key) ?? IDLE_MCP_MUTATION;
        return (
          <ServerRow
            key={key}
            entry={entry}
            outcome={outcome}
            pending={outcome.kind === "sending"}
            onSetEnabled={(binding, enabled) => {
              dispatch(binding, (idempotencyKey) =>
                setBindingEnabled({
                  send: operations.sendEnabled,
                  binding,
                  enabled,
                  idempotencyKey,
                }),
              );
            }}
            onSetTrust={(binding, trusted) => {
              dispatch(binding, (idempotencyKey) =>
                setBindingTrust({ send: operations.sendTrust, binding, trusted, idempotencyKey }),
              );
            }}
          />
        );
      })}
    </ul>
  );
}
