// The MCP servers fixture body: the server list, per-leg disclosure, tool overrides and mutation
// outcomes, drawn from the reading and the calls it is handed.
//
// It authors none of what the MCP page must not: no aggregate status (the daemon's arrives on
// the row), no derived eligibility (every control is offered), and no configuration, environment,
// header, token or authorization-URL value (the wire carries names in their place).
//
// The outcome ledger is one entry per binding, keyed by its scope-qualified identity. It belongs
// to the bridge it was produced through: the provider replaces the bridge under a live mount in
// place, so the map rides the subject-scoped holder with the bridge as subject. It re-seeds
// during the render that first sees a new bridge, and a publisher captured under the retired
// bridge writes nothing.

import "./mcp-fixture-body.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { McpServerBindingRef } from "@ai-sidekicks/contracts/mcp/mcp";
import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  createMcpInventoryRead,
  type ListMcpInventory,
  type SubscribeMcpInventoryChanges,
} from "./mcp-inventory-reading.js";
import { mcpBindingKeyOf } from "../mcp-binding-key.js";
import {
  IDLE_MCP_MUTATION,
  mintIdempotencyKey,
  type IdempotencyKeyMinter,
  type McpMutationOutcome,
  type SendMcpEnabled,
} from "./mcp-mutation.js";
import { ServerRow } from "./components/ServerRow.js";

/** The subsystem a refused enablement change names as its author. */
const MCP_MUTATION_ORIGIN = "mcp-mutation";

/** The code a rejected enablement change that carried none of its own is reported under. */
const MCP_MUTATION_FAILED = "mcp-mutation-failed";

/** The daemon verbs the fixture body drives. */
export interface McpServerOperations {
  readonly listInventory: ListMcpInventory;
  readonly subscribeInventoryChanges: SubscribeMcpInventoryChanges;
  readonly sendEnabled: SendMcpEnabled;
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
  // The scenario's frozen clock under the fixture, the real one otherwise.
  const clock = useClock();
  const ownerWindow = useOwnerWindow();
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  // No key within the bridge: the binding is the key inside the map.
  const { value: outcomes, publish: publishOutcomes } = useSubjectScopedState<
    ReadonlyMap<string, McpMutationOutcome>
  >(bridge, undefined, () => new Map());
  // The bridge is a dependency although the read takes none: the clock forwards to the current
  // bridge, so a read armed under a retired bridge would wait on a clock nothing advances.
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
    ownerWindow.addEventListener("focus", onWindowFocus);
    return () => {
      ownerWindow.removeEventListener("focus", onWindowFocus);
    };
  }, [inventoryRead, ownerWindow]);
  // Its own effect: the focus listener is the window's and the reconnect subscription is the
  // transport's, and they release separately.
  useEffect(
    () =>
      bridge.transportReconnect.subscribe(() => {
        inventoryRead.refresh("reconnect");
      }),
    [bridge, inventoryRead],
  );

  // The update form: two presses settling in one tick would each write the map they read at
  // render and the second would erase the first, and an update refused because the bridge has
  // moved is never run.
  const recordOutcome = (key: string, outcome: McpMutationOutcome): void => {
    publishOutcomes((held) => new Map(held).set(key, outcome));
  };
  // A settled mutation answers with the row as it now stands; this asks the daemon again rather
  // than patching one row into a list whose fold this page does not own. The binding travels on
  // the outcome so each row renders its own; a refused send settles the row with the service's
  // words, so its control comes back.
  const setEnabled = (binding: McpServerBindingRef, enabled: boolean): void => {
    const key = mcpBindingKeyOf(binding);
    recordOutcome(key, { kind: "sending", binding });
    operations.sendEnabled({ ...binding, enabled, clientIdempotencyKey: mintKey() }).then(
      (result) => {
        recordOutcome(key, { kind: "settled", binding, result });
        // No guard needed: a superseded read is already disposed, and a disposed read
        // refreshes nothing.
        inventoryRead.refresh("terminal-event");
      },
      (error: unknown) => {
        recordOutcome(key, {
          kind: "refused",
          binding,
          refusal: coerceToRefusal(error, MCP_MUTATION_ORIGIN, MCP_MUTATION_FAILED),
        });
      },
    );
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
            className="meridian-settings-page__action meridian-action-button"
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
        detail={
          "That is an ordinary state, not a failure: nothing has been " +
          "registered for either provider, and an agent here reaches no " +
          "MCP tool."
        }
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
            onSetEnabled={setEnabled}
          />
        );
      })}
    </ul>
  );
}
