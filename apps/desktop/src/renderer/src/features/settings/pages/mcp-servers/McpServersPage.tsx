// The MCP servers page: the server list beside the selected server's readings, per-tool
// settings and the outcome of each change, drawn from the reading and the calls it is handed, and
// under them `Add a server` and `Browse servers`.
//
// It authors none of what the MCP page must not: no aggregate status (the daemon's arrives on
// the entry), no derived eligibility (every control is offered), and it draws no configuration,
// environment, header, token or authorization-URL value (the wire carries names in their place;
// what the add form's person typed leaves with its send and is held nowhere after it).
//
// The outcome ledger is one entry per control: a binding's own switch keyed by its scope-qualified
// identity, its switch in one project by that identity and the project's root and distribution,
// its sign-in, reconnect and removal by that identity and the act's word, each tool's facet by that
// identity, the tool's name and the facet, and each opening of the add form's send by a key no
// binding's can be. The page numbers each opening and never hands out a number twice, so an answer
// settles only the form that sent it; the form drops an opening's entry once it has settled and a
// later opening starts. `Add a server` is drawn at one place in the tree whatever the list holds,
// so a list that fills, empties or fails to read never mounts the section again. A removal's
// entry outlives its row, so the pane the removed server stood in still says how the removal
// settled. The map belongs to the bridge it was produced through: the provider replaces the
// bridge under a live mount in place, so the map rides the subject-scoped holder with the bridge
// as subject. It re-seeds during the render that first sees a new bridge, and a publisher
// captured under the retired bridge writes nothing.

import "./McpServersPage.css";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  McpProviderReadFailure,
  McpServerBindingRef,
  McpServerConfigInput,
  McpServerInventoryEntry,
  McpServerLegStatus,
  McpToolOverrideFacet,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/server";
import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";
import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";
import { structuralKey } from "#renderer/lib/structural-key.js";
import { useRelativeTimesNow } from "#renderer/hooks/useRelativeTimesNow.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { useProviderSections } from "#renderer/store/providers/hooks/useProviderSections.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { refuse, RefusalError } from "#renderer/lib/refusal/contract.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  createMcpInventoryRead,
  type ListMcpInventory,
  type SubscribeMcpInventoryChanges,
} from "./inventory-reading.js";
import { mcpBindingKeyOf } from "./binding-key.js";
import {
  IDLE_MCP_MUTATION,
  isReconnectUnchanged,
  mintIdempotencyKey,
  type IdempotencyKeyMinter,
  SIGN_IN_PAGE_UNOPENED_CODE,
  SIGN_IN_UNFINISHED_WORDS,
  settlementOfMutation,
  settlementOfToolOverride,
  type McpMutationOutcome,
  type McpProjectScopedBindingRef,
  type McpSwitchableBindingRef,
  type McpToolFacetChange,
  type SearchMcpRegistry,
  type SendMcpClearToolOverride,
  type SendMcpDelete,
  type SendMcpEnabled,
  type SendMcpReconnect,
  type SendMcpSignIn,
  type SendMcpToolOverride,
  type SendMcpUpsert,
} from "./mutation.js";
import type { ProjectListReading } from "./components/ProjectListStatus.js";
import { ServerAdding } from "./components/ServerAdding.js";
import { ServerDetail } from "./components/ServerDetail.js";
import { FailedProviderRow } from "./components/FailedProviderRow.js";
import { ServerListEntry } from "./components/ServerListEntry.js";
import { MutationOutcomeLine } from "./components/MutationOutcomeLine.js";

/** The subsystem a refused change names as its author. */
const MCP_MUTATION_ORIGIN = "mcp-mutation";

/** The code a rejected change that carried none of its own is reported under. */
const MCP_MUTATION_FAILED = "mcp-mutation-failed";

/** The daemon verbs the page drives. */
export interface McpServerOperations {
  readonly listInventory: ListMcpInventory;
  readonly subscribeInventoryChanges: SubscribeMcpInventoryChanges;
  readonly sendEnabled: SendMcpEnabled;
  readonly sendToolOverride: SendMcpToolOverride;
  readonly sendClearToolOverride: SendMcpClearToolOverride;
  readonly sendSignIn: SendMcpSignIn;
  readonly sendUpsert: SendMcpUpsert;
  readonly sendDelete: SendMcpDelete;
  readonly sendReconnect: SendMcpReconnect;
  readonly searchRegistry: SearchMcpRegistry;
}

/**
 * The MCP servers list and the selected server's controls, driven by the calls in `operations`.
 * The first server is selected when the list is first served; nothing is, once the selected one
 * leaves the list.
 */
export function McpServersPage(props: {
  readonly bridge: PlatformBridge;
  /** Held stable by the caller: a new object restarts the inventory read. */
  readonly operations: McpServerOperations;
  /** Injected so a suite can assert that one press reused one key. */
  readonly mintKey?: IdempotencyKeyMinter;
  /** The service's sessions, which name each running session on the page. */
  readonly sessionDirectory: SessionDirectoryState;
  /** The service's projects, each a switch on a connector's or an organization's server. */
  readonly projects: ProjectListReading;
}): ReactNode {
  const { bridge, operations, sessionDirectory, projects } = props;
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
  // The last number handed to an opening of the add form, kept for the page's whole life; a ref,
  // since handing out a number draws nothing.
  const lastOpening = useRef(0);
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
  const dropOutcome = (key: string): void => {
    publishOutcomes((held) => {
      if (!held.has(key)) {
        return held;
      }
      const kept = new Map(held);
      kept.delete(key);
      return kept;
    });
  };
  // A settled mutation answers with the row as it now stands; this asks the daemon again rather
  // than patching one row into a list whose fold this page does not own. The binding travels on
  // the outcome so each control renders its own; a refused send settles the control with the
  // service's words, so it comes back.
  const sendChange = (
    key: string,
    binding: McpServerBindingRef,
    send: () => Promise<SettledMcpMutationOutcome>,
  ): void => {
    recordOutcome(key, { kind: "sending", binding });
    send().then(
      (settled) => {
        recordOutcome(key, settled);
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
  const setEnabled = (binding: McpSwitchableBindingRef, enabled: boolean): void => {
    sendChange(mcpBindingKeyOf(binding), binding, async () => ({
      kind: "settled",
      binding,
      settlement: settlementOfMutation(
        await operations.sendEnabled({ ...binding, enabled, clientIdempotencyKey: mintKey() }),
      ),
    }));
  };
  const setEnabledIn = (
    binding: McpProjectScopedBindingRef,
    project: ProjectListEntry,
    enabled: boolean,
  ): void => {
    sendChange(projectSwitchOutcomeKeyOf(binding, project), binding, async () => ({
      kind: "settled",
      binding,
      settlement: settlementOfMutation(
        await operations.sendEnabled({
          ...binding,
          enabled,
          projectRoot: project.folderPath,
          ...(typeof project.place === "object" ? { place: project.place } : {}),
          clientIdempotencyKey: mintKey(),
        }),
      ),
    }));
  };
  // The service answers the sign-in page's address and the system browser is handed it; the
  // sign-in itself then finishes in the browser, outside this press.
  const signIn = (binding: McpServerBindingRef): void => {
    sendChange(signInOutcomeKeyOf(binding), binding, async () => {
      const { authorizationUrl } = await operations.sendSignIn({
        ...binding,
        clientIdempotencyKey: mintKey(),
      });
      if (authorizationUrl === undefined) {
        // A reused key's saved answer carries no address; each press mints its own, so the
        // service started nothing new for this one.
        return { kind: "settled", binding, settlement: { grades: [], liveResults: undefined } };
      }
      // The rejection's own message crosses IPC with the channel's name in it, so it is not shown.
      await bridge.native.openExternal(authorizationUrl).catch((error: unknown) => {
        throw new RefusalError(SIGN_IN_PAGE_UNOPENED, { cause: error });
      });
      return { kind: "signInPageOpened", binding };
    });
  };
  // The declaration travels only inside this send: the outcome keeps the binding alone.
  const addServer = (
    opening: number,
    binding: McpWritableBindingRef,
    config: McpServerConfigInput,
  ): void => {
    sendChange(addServerOutcomeKeyOf(opening), binding, async () => ({
      kind: "serverSent",
      binding,
      settlement: settlementOfMutation(
        await operations.sendUpsert({ ...binding, clientIdempotencyKey: mintKey(), config }),
      ),
    }));
  };
  const removeServer = (binding: McpWritableBindingRef): void => {
    sendChange(removalOutcomeKeyOf(mcpBindingKeyOf(binding)), binding, async () => ({
      kind: "settled",
      binding,
      settlement: settlementOfMutation(
        await operations.sendDelete({ ...binding, clientIdempotencyKey: mintKey() }),
      ),
    }));
  };
  // A reconnect writes nothing, so it carries no key; whether it moved any session's reading is
  // read from the readings the service answered against those the press saw.
  const reconnect = (
    binding: McpServerBindingRef,
    legsBefore: readonly McpServerLegStatus[],
  ): void => {
    sendChange(reconnectOutcomeKeyOf(binding), binding, async () => {
      const { legs } = await operations.sendReconnect(binding);
      return { kind: "reconnected", binding, isUnchanged: isReconnectUnchanged(legsBefore, legs) };
    });
  };
  // Only the facet pressed is sent: a set names that facet alone and a clear clears it alone, so
  // the tool's other facets are left as they stand.
  const changeTool = (
    binding: McpServerBindingRef,
    toolName: string,
    facet: McpToolOverrideFacet,
    change: McpToolFacetChange,
  ): void => {
    sendChange(toolOutcomeKeyOf(binding, toolName, facet), binding, async () => ({
      kind: "settled",
      binding,
      settlement: settlementOfToolOverride(
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
    }));
  };

  const state = usePushDrivenRead(inventoryRead);
  const providerSections = useProviderSections();
  const servers = state.kind === "loaded" ? state.value.servers : NO_SERVERS;
  const failedProviders = state.kind === "loaded" ? state.value.failedProviders : NO_FAILURES;
  const observedStamps = observedStampsOf(servers);
  const nowMilliseconds = useRelativeTimesNow(clock, observedStamps);
  // How the removal of the server last selected settled, which stands where that server stood.
  const removalOutcome =
    selectedKey === undefined
      ? IDLE_MCP_MUTATION
      : (outcomes.get(removalOutcomeKeyOf(selectedKey)) ?? IDLE_MCP_MUTATION);
  // A provider whose list the service could not read is a row of the list, and its `Try again` asks
  // for the whole list again. A provider with no tool servers set up says so in words, never as an
  // empty list, in place of the list when no server was read and at its foot otherwise.
  const failedRows = failedProviders.map((failure) => (
    <FailedProviderRow
      key={failure.provider}
      provider={failure.provider}
      onTryAgain={() => {
        inventoryRead.refresh("user-request");
      }}
    />
  ));
  const providersWithNone = providerSections.filter(
    (section) =>
      !servers.some((entry) => entry.provider === section.provider) &&
      !failedProviders.some((failure) => failure.provider === section.provider),
  );
  const firstServer = servers[0];
  if (selectedKey === undefined && firstServer !== undefined) {
    // Set during render, so the first draw already shows the first server's pane.
    setSelectedKey(mcpBindingKeyOf(firstServer));
  }
  const selected = servers.find((entry) => mcpBindingKeyOf(entry) === selectedKey);
  // The list's place, then `Add a server` as the second child in every state of the read.
  return (
    <>
      {state.kind === "not-loaded" ? (
        <LoadingNotice clock={clock} placement="block" title="Loading…" />
      ) : state.kind === "failed" ? (
        <InlineRefusal
          code={state.refusal.code}
          detail="Couldn't load MCP servers"
          onTryAgain={() => {
            setOpeningOrdinal((held) => held + 1);
          }}
        />
      ) : servers.length === 0 ? (
        <>
          <MutationOutcomeLine
            outcome={removalOutcome}
            sessionDirectory={sessionDirectory}
            clock={clock}
          />
          {failedRows.length === 0 ? null : (
            <ul className="meridian-mcp__entries" aria-label="Tool servers">
              {failedRows}
            </ul>
          )}
          {providersWithNone.map((section) => (
            <Nothing
              key={section.provider}
              kind="empty"
              placement="block"
              title={noServersLineFor(section)}
            />
          ))}
        </>
      ) : (
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
              {failedRows}
            </ul>
            {providersWithNone.map((section) => (
              <p key={section.provider} className="meridian-settings-page__aside">
                {noServersLineFor(section)}
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
            projects={projects}
            projectSwitchOutcomeFor={(project) =>
              selected === undefined
                ? IDLE_MCP_MUTATION
                : (outcomes.get(projectSwitchOutcomeKeyOf(selected, project)) ?? IDLE_MCP_MUTATION)
            }
            onSetEnabledIn={setEnabledIn}
            signInOutcome={
              selected === undefined
                ? IDLE_MCP_MUTATION
                : (outcomes.get(signInOutcomeKeyOf(selected)) ?? IDLE_MCP_MUTATION)
            }
            onSignIn={signIn}
            reconnectOutcome={
              selected === undefined
                ? IDLE_MCP_MUTATION
                : (outcomes.get(reconnectOutcomeKeyOf(selected)) ?? IDLE_MCP_MUTATION)
            }
            onReconnect={reconnect}
            removalOutcome={removalOutcome}
            onRemove={removeServer}
            onChangeTool={changeTool}
            sessionDirectory={sessionDirectory}
            clock={clock}
            nowMilliseconds={nowMilliseconds}
          />
        </div>
      )}
      <ServerAdding
        mintOpening={() => {
          lastOpening.current += 1;
          return lastOpening.current;
        }}
        outcomeFor={(opening) => outcomes.get(addServerOutcomeKeyOf(opening)) ?? IDLE_MCP_MUTATION}
        onAdd={addServer}
        onDropOutcome={(opening) => {
          dropOutcome(addServerOutcomeKeyOf(opening));
        }}
        searchRegistry={operations.searchRegistry}
        projects={projects}
        sessionDirectory={sessionDirectory}
        clock={clock}
      />
    </>
  );
}

/** How a change this body sent settled, once its send answered. */
type SettledMcpMutationOutcome = Exclude<
  McpMutationOutcome,
  { readonly kind: "idle" | "sending" | "refused" }
>;

/** The ledger key of the send of one opening of the add form, which no binding's key can equal. */
function addServerOutcomeKeyOf(opening: number): string {
  return structuralKey(["addServer", String(opening)]);
}

/** What a sign-in whose page the system browser would not open settles with. */
const SIGN_IN_PAGE_UNOPENED = refuse(
  MCP_MUTATION_ORIGIN,
  SIGN_IN_PAGE_UNOPENED_CODE,
  SIGN_IN_UNFINISHED_WORDS,
);

/** What the list holds before the inventory is served. */
const NO_SERVERS: readonly McpServerInventoryEntry[] = [];

/** The providers whose list failed, before the inventory is served. */
const NO_FAILURES: readonly McpProviderReadFailure[] = [];

/** Every reading time the page draws an age for: each server's own and each of its sessions'. */
function observedStampsOf(servers: readonly McpServerInventoryEntry[]): readonly string[] {
  return servers.flatMap((entry) => [
    ...(entry.observedAt === undefined ? [] : [entry.observedAt]),
    ...(entry.legs ?? []).flatMap((leg) => (leg.observedAt === undefined ? [] : [leg.observedAt])),
  ]);
}

/**
 * The ledger key of one binding's switch in one project: the project's root and distribution
 * nested as one member, so it can never read as a tool's name and facet.
 */
function projectSwitchOutcomeKeyOf(
  binding: McpServerBindingRef,
  project: ProjectListEntry,
): string {
  const distro = typeof project.place === "object" ? [project.place.distro] : [];
  return structuralKey([mcpBindingKeyOf(binding), structuralKey([project.folderPath, ...distro])]);
}

/** The ledger key of the removal of the binding keyed `bindingKey`. */
function removalOutcomeKeyOf(bindingKey: string): string {
  return structuralKey([bindingKey, "remove"]);
}

/** The ledger key of one binding's reconnect. */
function reconnectOutcomeKeyOf(binding: McpServerBindingRef): string {
  return structuralKey([mcpBindingKeyOf(binding), "reconnect"]);
}

/** The ledger key of one binding's sign-in. */
function signInOutcomeKeyOf(binding: McpServerBindingRef): string {
  return structuralKey([mcpBindingKeyOf(binding), "signIn"]);
}

/** The ledger key of one facet of one tool on one binding. */
function toolOutcomeKeyOf(
  binding: McpServerBindingRef,
  toolName: string,
  facet: McpToolOverrideFacet,
): string {
  return structuralKey([mcpBindingKeyOf(binding), toolName, facet]);
}

function noServersLineFor(section: ProviderSection): string {
  return `No tool servers are set up for ${section.name}.`;
}
