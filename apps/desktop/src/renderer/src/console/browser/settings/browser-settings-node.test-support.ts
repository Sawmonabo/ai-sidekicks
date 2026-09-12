// The node these two suites drive the browser settings carrier against.
//
// HOISTED ON THE SECOND USE, which is the package rule. Two suites drive this carrier —
// the ORDER two answers install in, and what an act that answered nothing does next —
// and both need the same held reads, the same call counts, and the same two acts with
// their disposition chosen per case. A second stub would be a second idea of what the
// node does, and a case reading a default it did not write is the hardest kind of test
// to correct.

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../../bridge/index.js";
import { settle } from "../../core/settle.test-support.js";
import { BrowserSettingsView, type BrowserSettingsSnapshot } from "./browser-settings-source.js";

export type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];
export type PolicyOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserPolicyRead"]>>;
export type ListOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSiteDataList"]>>;
export type WriteOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserPolicyWrite"]>>;
export type ClearOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSiteDataClear"]>>;

export const EMPTY_SCENARIO: FixtureScenario = {
  id: "browser-settings-ordering",
  label: "Browser settings, with nothing scripted",
  purpose: "Drives the browser settings carrier against a node whose replies a case supplies.",
  sessionId: "session-browser-settings",
  userIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

export const OPEN_PARTITION = {
  sessionId: "session-open",
  sessionTitle: "Still open",
  storedByteLength: 4096,
  hasOpenPane: false,
};

export const CLEARED_PARTITION = {
  sessionId: "session-cleared",
  sessionTitle: "About to go",
  storedByteLength: 8192,
  hasOpenPane: false,
};

export function servedPolicy(values: Readonly<Record<string, boolean>>): PolicyOutcome {
  return { status: "served", value: values };
}

export function servedList(
  partitions: Extract<ListOutcome, { status: "served" }>["value"],
): ListOutcome {
  return { status: "served", value: partitions };
}

export const SERVED_WRITE: WriteOutcome = { status: "served", value: undefined };
export const SERVED_CLEAR: ClearOutcome = { status: "served", value: undefined };

/** What a case wants an ACT to do: answer, answer a refusal, or reject. */
export type ActDisposition = "served" | "refused" | "rejects";

/** The rejection the transport arms raise — a value carrying no daemon code at all. */
export const TRANSPORT_REJECTION: Error = new Error("the call into the node never answered");

export interface CarrierUnderTest {
  readonly view: BrowserSettingsView;
  readonly bridge: ConsoleBridge;
  readonly node: SettingsNodeStub;
}

/**
 * A node that answers both reads, counts them, and can hold them open.
 *
 * The replies are consumed in order and the last one repeats, so a case says what the
 * node looked like BEFORE an act and what it looks like after without scripting an
 * engine. The counts are what let a re-read be asserted at all: "the row is gone" is
 * also true of a carrier that removed it locally.
 */
export class SettingsNodeStub {
  readonly #policies: readonly PolicyOutcome[];
  readonly #lists: readonly ListOutcome[];
  readonly #holdsReads: boolean;
  readonly #writeDisposition: ActDisposition;
  readonly #clearDisposition: ActDisposition;
  #policyCallCount = 0;
  #listCallCount = 0;
  #writes: { readonly switchId: string; readonly enabled: boolean }[] = [];
  #clearedSessionIds: string[] = [];
  #heldReads: (() => void)[] = [];

  public constructor(options: {
    readonly policies: readonly PolicyOutcome[];
    readonly lists: readonly ListOutcome[];
    /**
     * Hold every read open until {@link releaseReads} is called.
     *
     * BOTH reads, not one: the carrier awaits them as a pair and installs the pair, so
     * holding only one would still let the round settle whenever the other answered.
     */
    readonly holdsReads?: boolean;
    /**
     * How the two acts answer.
     *
     * `refused` is the node ANSWERING no and `rejects` is the call never answering,
     * which is the whole distinction the reconciliation arm turns on — so a case says
     * which one it is staging rather than reaching for one stub that does both.
     */
    readonly writeDisposition?: ActDisposition;
    readonly clearDisposition?: ActDisposition;
  }) {
    this.#policies = options.policies;
    this.#lists = options.lists;
    this.#holdsReads = options.holdsReads ?? false;
    this.#writeDisposition = options.writeDisposition ?? "served";
    this.#clearDisposition = options.clearDisposition ?? "served";
  }

  public get policyCallCount(): number {
    return this.#policyCallCount;
  }

  public get listCallCount(): number {
    return this.#listCallCount;
  }

  public get writes(): readonly { readonly switchId: string; readonly enabled: boolean }[] {
    return this.#writes;
  }

  public get clearedSessionIds(): readonly string[] {
    return this.#clearedSessionIds;
  }

  /** Let every held read answer, then let its chain settle. Safe with none held. */
  public async releaseReads(): Promise<void> {
    const held = this.#heldReads;
    this.#heldReads = [];
    for (const release of held) {
      release();
    }
    await settle();
  }

  public bridge(): ConsoleBridge {
    const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    return {
      ...fixture,
      growth: {
        ...fixture.growth,
        browserPolicyRead: async () => {
          const reply = this.#policies[
            Math.min(this.#policyCallCount, this.#policies.length - 1)
          ] as PolicyOutcome;
          this.#policyCallCount += 1;
          return await this.#answer(reply);
        },
        browserSiteDataList: async () => {
          const reply = this.#lists[
            Math.min(this.#listCallCount, this.#lists.length - 1)
          ] as ListOutcome;
          this.#listCallCount += 1;
          return await this.#answer(reply);
        },
        browserPolicyWrite: async (request: {
          readonly switchId: string;
          readonly enabled: boolean;
        }) => {
          this.#writes = [...this.#writes, request];
          if (this.#writeDisposition === "rejects") {
            throw TRANSPORT_REJECTION;
          }
          return await Promise.resolve(
            this.#writeDisposition === "refused"
              ? growthUnavailable("browserPolicyWrite")
              : SERVED_WRITE,
          );
        },
        browserSiteDataClear: async (request: { readonly sessionId: string }) => {
          this.#clearedSessionIds = [...this.#clearedSessionIds, request.sessionId];
          if (this.#clearDisposition === "rejects") {
            throw TRANSPORT_REJECTION;
          }
          return await Promise.resolve(
            this.#clearDisposition === "refused"
              ? growthUnavailable("browserSiteDataClear")
              : SERVED_CLEAR,
          );
        },
      },
    };
  }

  async #answer<TOutcome>(outcome: TOutcome): Promise<TOutcome> {
    if (!this.#holdsReads) {
      return await Promise.resolve(outcome);
    }
    return await new Promise<TOutcome>((resolve) => {
      this.#heldReads = [
        ...this.#heldReads,
        () => {
          resolve(outcome);
        },
      ];
    });
  }
}

export function carrierOver(node: SettingsNodeStub): CarrierUnderTest {
  const bridge = node.bridge();
  return { view: new BrowserSettingsView(bridge), bridge, node };
}

/** The session ids the carrier is currently reporting, or `undefined` while reading. */
export function partitionIdsOf(snapshot: BrowserSettingsSnapshot): readonly string[] | undefined {
  return snapshot.partitions.kind === "served"
    ? snapshot.partitions.partitions.map((partition) => partition.sessionId)
    : undefined;
}
