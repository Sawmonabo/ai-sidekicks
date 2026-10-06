// The MCP servers fixture body: the server list beside the selected server's readings, per-tool
// settings and the outcome of each change, drawn from the reading and the calls it is handed.
//
// It authors none of what the MCP page must not: no aggregate status (the daemon's arrives on
// the entry), no derived eligibility (every control is offered), and no configuration,
// environment, header, token or authorization-URL value (the wire carries names in their place).
//
// The outcome ledger is one entry per control: a binding's own switch keyed by its scope-qualified
// identity, and each tool's facet by that identity, the tool's name and the facet. It belongs
// to the bridge it was produced through: the provider replaces the bridge under a live mount in
// place, so the map rides the subject-scoped holder with the bridge as subject. It re-seeds
// during the render that first sees a new bridge, and a publisher captured under the retired
// bridge writes nothing.

import "./McpFixtureBody.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  McpServerBindingRef,
  McpServerInventoryEntry,
  McpToolOverrideFacet,
} from "@ai-sidekicks/contracts/mcp/server";
import {
  PROVIDER_LABELS,
  PROVIDER_NAMES,
  type ProviderName,
} from "@ai-sidekicks/contracts/provider/name";
import { structuralKey } from "#renderer/lib/structural-key.js";
import { relativeTimeChangesAt } from "#renderer/lib/wire/figures.js";
import { useDrawnInstant } from "#renderer/hooks/useDrawnInstant.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  createMcpInventoryRead,
  type ListMcpInventory,
  type SubscribeMcpInventoryChanges,
} from "./inventory-reading.js";
import { mcpBindingKeyOf } from "../binding-key.js";
import {
  IDLE_MCP_MUTATION,
  mintIdempotencyKey,
  type IdempotencyKeyMinter,
  settlementOfMutation,
  settlementOfToolOverride,
  type McpChangeSettlement,
  type McpMutationOutcome,
  type McpToolFacetChange,
  type SendMcpClearToolOverride,
  type SendMcpEnabled,
  type SendMcpToolOverride,
} from "./mutation.js";
import { ServerDetail } from "./components/ServerDetail.js";
import { ServerListEntry } from "./components/ServerListEntry.js";

/** The subsystem a refused change names as its author. */
const MCP_MUTATION_ORIGIN = "mcp-mutation";

/** The code a rejected change that carried none of its own is reported under. */
const MCP_MUTATION_FAILED = "mcp-mutation-failed";

/** The daemon verbs the fixture body drives. */
export interface McpServerOperations {
  readonly listInventory: ListMcpInventory;
  readonly subscribeInventoryChanges: SubscribeMcpInventoryChanges;
  readonly sendEnabled: SendMcpEnabled;
  readonly sendToolOverride: SendMcpToolOverride;
  readonly sendClearToolOverride: SendMcpClearToolOverride;
}

/**
 * The MCP servers list and the selected server's controls, driven by the calls in `operations`.
 * The first server is selected when the list is first served; nothing is, once the selected one
 * leaves the list.
 */
export function McpFixtureBody(props: {
  readonly bridge: PlatformBridge;
  /** Held stable by the caller: a new object restarts the inventory read. */
  readonly operations: McpServerOperations;
  /** Injected so a suite can assert that one press reused one key. */
  readonly mintKey?: IdempotencyKeyMinter;
  /** The service's sessions, which name each running session on the page. */
  readonly sessionDirectory: SessionDirectoryState;
}): ReactNode {
  const { bridge, operations, sessionDirectory } = props;
  const mintKey = props.mintKey ?? mintIdempotencyKey;
  // The scenario's frozen clock under the fixture, the real one otherwise.
  const clock = useClock();
  const ownerWindow = useOwnerWindow();
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  // The selected server's binding key, the first server's until a person picks another; a
  // selection whose server leaves the inventory selects nothing.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
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
  // the outcome so each control renders its own; a refused send settles the control with the
  // service's words, so it comes back.
  const sendChange = (
    key: string,
    binding: McpServerBindingRef,
    send: () => Promise<McpChangeSettlement>,
  ): void => {
    recordOutcome(key, { kind: "sending", binding });
    send().then(
      (settlement) => {
        recordOutcome(key, { kind: "settled", binding, settlement });
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
  const setEnabled = (binding: McpServerBindingRef, enabled: boolean): void => {
    sendChange(mcpBindingKeyOf(binding), binding, async () =>
      settlementOfMutation(
        await operations.sendEnabled({ ...binding, enabled, clientIdempotencyKey: mintKey() }),
      ),
    );
  };
  // Only the facet pressed is sent: a set names that facet alone and a clear clears it alone, so
  // the tool's other facets are left as they stand.
  const changeTool = (
    binding: McpServerBindingRef,
    toolName: string,
    facet: McpToolOverrideFacet,
    change: McpToolFacetChange,
  ): void => {
    sendChange(toolOutcomeKeyOf(binding, toolName, facet), binding, async () =>
      settlementOfToolOverride(
        change.kind === "clear"
          ? await operations.sendClearToolOverride({
              ...binding,
              toolName,
              facet,
              clientIdempotencyKey: mintKey(),
            })
          : await operations.sendToolOverride({
              ...binding,
              override: { toolName, ...change.override },
              clientIdempotencyKey: mintKey(),
            }),
      ),
    );
  };

  const state = usePushDrivenRead(inventoryRead);
  const servers = state.kind === "loaded" ? state.value.servers : NO_SERVERS;
  const observedStamps = observedStampsOf(servers);
  // Woken when a drawn age would next read differently, `2 minutes ago` becoming `3 minutes ago`.
  const nowMilliseconds = useDrawnInstant(clock, observedStamps, (instant) =>
    Math.min(
      Number.POSITIVE_INFINITY,
      ...observedStamps.map((stamp) => relativeTimeChangesAt(stamp, instant)),
    ),
  );
  if (state.kind === "not-loaded") {
    return <Nothing kind="not-loaded" placement="block" title="Reading the server list…" />;
  }
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title="The server list could not be read."
        detail={state.refusal.detail}
        action={
          <TryAgainButton
            onPress={() => {
              setOpeningOrdinal((held) => held + 1);
            }}
          />
        }
      />
    );
  }
  // A provider with no tool servers set up says so in words, never as an empty list: in place of
  // the list when neither has any, and in quiet text at the list's foot otherwise.
  const providersWithNone = PROVIDER_NAMES.filter(
    (provider) => !servers.some((entry) => entry.provider === provider),
  );
  if (servers.length === 0) {
    return providersWithNone.map((provider) => (
      <Nothing key={provider} kind="empty" placement="block" title={noServersLineFor(provider)} />
    ));
  }
  const firstServer = servers[0];
  if (selectedKey === undefined && firstServer !== undefined) {
    // Set during render, so the first draw already shows the first server's pane.
    setSelectedKey(mcpBindingKeyOf(firstServer));
  }
  const selected = servers.find((entry) => mcpBindingKeyOf(entry) === selectedKey);
  return (
    <div className="meridian-mcp">
      <div className="meridian-mcp__list">
        <ul className="meridian-mcp__entries" aria-label="Tool servers">
          {servers.map((entry) => {
            const key = mcpBindingKeyOf(entry);
            return (
              <ServerListEntry
                key={key}
                entry={entry}
                isSelected={entry === selected}
                onSelect={() => {
                  setSelectedKey(key);
                }}
                nowMilliseconds={nowMilliseconds}
              />
            );
          })}
        </ul>
        {providersWithNone.map((provider) => (
          <p key={provider} className="meridian-settings-page__aside">
            {noServersLineFor(provider)}
          </p>
        ))}
      </div>
      {/* Keyed by the server, so nothing one server's pane holds is carried to the next. */}
      <ServerDetail
        key={selected === undefined ? undefined : mcpBindingKeyOf(selected)}
        entry={selected}
        outcome={
          selected === undefined
            ? IDLE_MCP_MUTATION
            : (outcomes.get(mcpBindingKeyOf(selected)) ?? IDLE_MCP_MUTATION)
        }
        toolOutcomeFor={(toolName, facet) =>
          selected === undefined
            ? IDLE_MCP_MUTATION
            : (outcomes.get(toolOutcomeKeyOf(selected, toolName, facet)) ?? IDLE_MCP_MUTATION)
        }
        onSetEnabled={setEnabled}
        onChangeTool={changeTool}
        sessionDirectory={sessionDirectory}
        clock={clock}
        nowMilliseconds={nowMilliseconds}
      />
    </div>
  );
}

/** What the list holds before the inventory is served. */
const NO_SERVERS: readonly McpServerInventoryEntry[] = [];

/** Every reading time the page draws an age for: each server's own and each of its sessions'. */
function observedStampsOf(servers: readonly McpServerInventoryEntry[]): readonly string[] {
  return servers.flatMap((entry) => [
    ...(entry.observedAt === undefined ? [] : [entry.observedAt]),
    ...(entry.legs ?? []).flatMap((leg) => (leg.observedAt === undefined ? [] : [leg.observedAt])),
  ]);
}

/** The ledger key of one facet of one tool on one binding. */
function toolOutcomeKeyOf(
  binding: McpServerBindingRef,
  toolName: string,
  facet: McpToolOverrideFacet,
): string {
  return structuralKey([mcpBindingKeyOf(binding), toolName, facet]);
}

function noServersLineFor(provider: ProviderName): string {
  return `No tool servers are set up for ${PROVIDER_LABELS[provider]}.`;
}
