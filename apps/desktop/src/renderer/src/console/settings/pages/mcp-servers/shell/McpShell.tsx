// The fixture shell that stands in for the MCP governance body.
//
// WHAT A SHELL IS HERE, AND WHAT IT IS NOT. The seat next door declares who owns this
// body, what the mount owes it, and where the shell dies. This module is the third of
// those: a `define`-gated stand-in that reads the registered wire the owning body will
// read, renders every state that wire can answer with, and is deleted whole in the PR
// that fills the slot.
//
// AND IT AUTHORS NONE OF THE THINGS THE SEAT SAYS A BODY HERE MUST NOT AUTHOR. It
// composes no aggregate status — the daemon's arrives on the row and is rendered. It
// derives no eligibility — every control is offered and a refusal renders where it was
// raised. It renders no configuration value, environment-variable value, header value,
// token, or authorization URL — the wire carries names in place of all of them, so
// there is nothing here to withhold. What it adds is that the states those rules
// describe were reachable from nowhere at all while this slot rendered its reservation.
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
// same binding and reported that the new transport had applied or refused a mutation
// it had never been asked to perform. The map therefore rides the console's one
// subject-scoped holder with the bridge as its subject: it re-seeds DURING the render
// that first sees a new bridge, so no committed frame carries the previous one's
// outcomes, and a publisher captured under the retired bridge writes nothing rather
// than overwriting what the replacement said. The refresh beside the settlement needs
// no second guard — a superseded read has already been disposed, and a disposed read
// refreshes nothing.

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { mcpBindingKeyOf, useConsoleClock, type ConsoleBridge } from "../../../../bridge/index.js";
import type { GrowthMcpBindingRef } from "../../../../bridge/index.js";
import { Nothing } from "../../../../primitives/index.js";
import { usePushDrivenRead } from "../../../../seats/index.js";
import { useSubjectScopedState } from "../../../../store/index.js";
import { createMcpInventoryRead } from "./mcp-inventory-reading.js";
import {
  IDLE_MCP_MUTATION,
  mintIdempotencyKey,
  setBindingEnabled,
  setBindingTrust,
  type IdempotencyKeyMinter,
  type McpMutationOutcome,
} from "./mcp-mutation.js";
import { ServerRow } from "./ServerRow.js";

export function McpShell(props: {
  readonly bridge: ConsoleBridge;
  /** Injected so a suite can assert that one press reused one key. */
  readonly mintKey?: IdempotencyKeyMinter;
}): ReactNode {
  const { bridge } = props;
  const mintKey = props.mintKey ?? mintIdempotencyKey;
  // The scenario's frozen clock under the fixture, the real one otherwise, so a story
  // advances this read's coalescing window exactly when it advances everything else's.
  const clock = useConsoleClock();
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  // No key within the bridge: the ledger is about the whole node's inventory, and the
  // binding is the key INSIDE the map rather than the subject the map is held under.
  const { value: outcomes, publish: publishOutcomes } = useSubjectScopedState<
    ReadonlyMap<string, McpMutationOutcome>
  >(bridge, undefined, () => new Map());
  const inventoryRead = useMemo(
    () => createMcpInventoryRead({ bridge, clock }),
    [bridge, clock, openingOrdinal],
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
  // A settled mutation answers with the row as it now stands, and this shell asks the
  // daemon again rather than splicing that row into the list it is holding. The reply
  // is authoritative about the binding it names and says nothing about the others,
  // and a page that patched one row would be maintaining a second copy of an inventory
  // whose fold it does not own.
  const dispatch = (
    binding: GrowthMcpBindingRef,
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
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading the servers this node governs."
      />
    );
  }
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="surface"
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
        placement="surface"
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
                setBindingEnabled({ bridge, binding, enabled, idempotencyKey }),
              );
            }}
            onSetTrust={(binding, trusted) => {
              dispatch(binding, (idempotencyKey) =>
                setBindingTrust({ bridge, binding, trusted, idempotencyKey }),
              );
            }}
          />
        );
      })}
    </ul>
  );
}
