// The one enumeration this composer holds, and the two zones that read it.
//
// `Spec-023 §Signature Feature Composition Sketches` §The Session Composer states the
// enumeration's lifetime as a rule: "not persisted, not cached across sessions, and
// re-read rather than patched". That is what this holder is — one live reading, keyed
// on the addressed agent, discarded when the key changes and when the surface that
// opened it closes. It is not a registry and nothing here survives a re-address.
//
// WHY IT IS A HOLDER AND NOT A HOOK IN EACH ZONE. Two zones need the same reading and
// they need it for different reasons: the popover LISTS what the bound provider
// publishes, and the send router has to know whether a typed `/name` is one of those
// entries — because a real provider command typed into the line was reaching a
// refusal that told the person to remove the slash or address the channel, advice
// that runs nothing and is wrong about what they typed. A second hook in the send bar
// would be a second read of one wire and a second answer to one question; a copy
// cached in the router would be the stored list the lifetime rule forbids. So the
// host builds one holder and hands it to both zones, exactly as it hands the popover
// the region whose line it observes.
//
// THE POPOVER IS THE ONLY WRITER. It owns the open state — the leading slash in the
// line is what opens the surface — and the router only ever reads the snapshot. One
// writer is what keeps "when is this read live" a question with one answer.
//
// THE KEY INCLUDES THE BRIDGE, BECAUSE THE BRIDGE IS PART OF WHICH BINDING THIS IS.
// `SidekicksBridgeProvider` can replace its bridge under a composer that stays
// addressed to the same session and agent, and a key of session and agent alone reads
// that as "nothing moved" — so the surface was served the OLD bridge's catalog, which
// is the routing invariant this holder exists to keep. The key is therefore compared
// by bridge identity as well, and an outstanding read is guarded by a GENERATION
// rather than by the key: a key can be re-entered after a close, and a reply from the
// previous occupancy would pass an identity guard that only compares values.
//
// LAZY, STILL. The read runs when the discovery surface opens, not when the composer
// mounts: a person who never types a slash never spends a provider round trip.

import { useEffect, useSyncExternalStore } from "react";

import { settleEnumeration, type ProviderCommandReadState } from "./provider-command-read.js";
import {
  composeCatalog,
  selectAddressedBindingGroup,
  type AddressedProviderBinding,
  type ProviderCatalogEntry,
} from "./provider-command-catalog.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";

/** Which binding an enumeration was read under. A change discards before it re-reads. */
export interface ProviderCommandReadKey {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly agentId: string;
}

/**
 * Whether two keys name one binding.
 *
 * The bridge is compared by IDENTITY and the other two by value, which is what each
 * one is: a bridge is the live object a call travels over, and two bridges holding the
 * same session are two different wires with two different catalogs behind them.
 */
function isSameReadKey(held: ProviderCommandReadKey, candidate: ProviderCommandReadKey): boolean {
  return (
    held.bridge === candidate.bridge &&
    held.sessionId === candidate.sessionId &&
    held.agentId === candidate.agentId
  );
}

/** Nobody has been asked: the composer addresses no agent, or the surface is closed. */
const NOT_CHECKED: ProviderCommandReadState = { phase: "not-checked" };

/**
 * One composer's live enumeration.
 *
 * A class with private fields rather than a hook's state, because two components read
 * it and only one of them may drive it. The subscription is the plain
 * `useSyncExternalStore` shape: the snapshot is the stored state object, so an
 * observer re-renders when the reading changes and never on a poll.
 */
export class ProviderCommandEnumeration {
  #state: ProviderCommandReadState = NOT_CHECKED;
  #openKey: ProviderCommandReadKey | undefined = undefined;
  // Advanced by every open at a new key and by every close, so an outstanding read
  // knows whether the occupancy it was issued under is still the one on screen.
  #readGeneration = 0;
  readonly #listeners = new Set<() => void>();

  /** The reading as it stands. Stable between changes. */
  public snapshot = (): ProviderCommandReadState => this.#state;

  /** Watch the reading. */
  public subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Read the addressed agent's commands and skills, or keep the reading already in
   * hand when the key has not moved.
   *
   * A key change DISCARDS before it re-reads, and the intermediate state is
   * `not-loaded` rather than the previous agent's list: a list that survived a
   * re-address for one frame would be one frame in which the surface offered the
   * wrong binding's commands, which is the routing invariant
   * `Spec-005 §The provider command and skill surface` exists to forbid.
   */
  public open(key: ProviderCommandReadKey): void {
    if (this.#openKey !== undefined && isSameReadKey(this.#openKey, key)) {
      return;
    }
    this.#openKey = key;
    this.#readGeneration += 1;
    const readGeneration = this.#readGeneration;
    this.#publish({ phase: "not-loaded" });
    void settleEnumeration(key.bridge, key.sessionId, key.agentId).then((settled) => {
      if (this.#readGeneration === readGeneration) {
        this.#publish(settled);
      }
      // A reply from a superseded occupancy has nowhere to go: writing it would put
      // one binding's commands under another binding's address.
    });
  }

  /** End the reading's lifetime. The surface closed, or no agent is addressed. */
  public close(): void {
    if (this.#openKey === undefined) {
      return;
    }
    this.#openKey = undefined;
    // Closing supersedes an outstanding read too. Without this a reply issued before
    // the close could land after the surface re-opened at the same key and present a
    // reading nobody asked for as the current one.
    this.#readGeneration += 1;
    this.#publish(NOT_CHECKED);
  }

  /**
   * The entry the ADDRESSED BINDING published under this exact name, if it published
   * one.
   *
   * Served readings only, and an exact match: the name is what the popover listed and
   * what a person copied out of it, and a loose match here would have the send path
   * naming an entry the list never showed them. A reading that has not landed answers
   * `undefined`, which leaves the send path saying what it said before this holder
   * existed rather than guessing.
   *
   * The binding is an ARGUMENT rather than part of this reading's key. Which of an
   * agent's runs the composer addresses moves as the daemon settles turns, and folding
   * that into the key would re-read the enumeration once per turn; what it must move
   * is which group is READ OUT, which is exactly what selecting here does. Both readers
   * of this enumeration take the same selection, so the list a person saw and the
   * name the send path recognises name one binding.
   */
  public publishedEntryNamed(
    commandName: string,
    addressed: AddressedProviderBinding,
  ): ProviderCatalogEntry | undefined {
    if (this.#state.phase !== "served") {
      return undefined;
    }
    const group = selectAddressedBindingGroup(this.#state.groups, addressed);
    if (group === undefined) {
      return undefined;
    }
    const published = composeCatalog({ offeredCommands: [], providerGroups: [group] });
    return published.find(
      (entry): entry is ProviderCatalogEntry =>
        entry.source === "provider" && entry.name === commandName,
    );
  }

  #publish(state: ProviderCommandReadState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** The agent this composer would enumerate, or `undefined` when it addresses none. */
function addressedAgentId(target: ComposerTarget): string | undefined {
  return target.path === "provider-bound" ? target.agentId : undefined;
}

/**
 * Drive one composer's enumeration from the surface that opens it, and read it back.
 *
 * The DISCOVERY SURFACE calls this: opening is its decision, because the leading
 * slash in the line is what makes the reading live. Every other reader observes the
 * same holder without opening anything, so the composer never asks twice and never
 * asks because somebody wanted to look at the answer.
 */
export function useProviderCommandEnumeration(options: {
  readonly enumeration: ProviderCommandEnumeration;
  readonly bridge: ConsoleBridge;
  readonly target: ComposerTarget;
  readonly isOpen: boolean;
}): ProviderCommandReadState {
  const { enumeration, bridge, target, isOpen } = options;
  const sessionId = target.sessionId;
  const agentId = addressedAgentId(target);

  useEffect(() => {
    if (!isOpen || agentId === undefined) {
      enumeration.close();
      return;
    }
    enumeration.open({ bridge, sessionId, agentId });
  }, [enumeration, bridge, sessionId, agentId, isOpen]);

  return useSyncExternalStore(enumeration.subscribe, enumeration.snapshot, enumeration.snapshot);
}
