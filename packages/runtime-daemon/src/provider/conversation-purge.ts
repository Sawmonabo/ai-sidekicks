// Deleting each provider's own copy of the conversations a session ran on, for the whole-session
// purge: the conversation each of its bindings names and each one it left, handed to the driver
// that ran it, newest first, so a fork goes before the conversation it was forked from.

import type { Database, Statement } from "better-sqlite3";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { describeRejection } from "../rejection.js";
import { SESSION_RUN_IDS_SQL } from "../session/run/ids.js";
import type { ProviderDriver } from "./driver/contract.js";
import { DriverUnavailableError, type ProviderRegistry } from "./driver/registry.js";
import type { PurgeSessionParams } from "./driver/session-control.js";
import { readLeftConversations } from "./left-conversations.js";
import type { RuntimeBinding, RuntimeBindingStore } from "./runtime-binding-store.js";

/** What the conversation purge reads and deletes through. */
interface ProviderConversationPurgeDeps {
  readonly reader: Database;
  readonly runtimeBindings: Pick<RuntimeBindingStore, "findByRuns">;
  readonly providers: Pick<ProviderRegistry, "lookup">;
}

/** Deletes the provider's own copy of every conversation a session ran on. */
export class ProviderConversationPurge {
  readonly #reader: Database;
  readonly #runtimeBindings: Pick<RuntimeBindingStore, "findByRuns">;
  readonly #providers: Pick<ProviderRegistry, "lookup">;
  readonly #selectRunIds: Statement<{ sessionId: string }, { runId: string }>;

  constructor(deps: ProviderConversationPurgeDeps) {
    this.#reader = deps.reader;
    this.#runtimeBindings = deps.runtimeBindings;
    this.#providers = deps.providers;
    this.#selectRunIds = deps.reader.prepare(SESSION_RUN_IDS_SQL);
  }

  /**
   * Deletes every conversation the session ran on from the account home it ran in. Every driver is
   * looked up first, so one this daemon has not registered refuses with `driver.unavailable` and
   * nothing deleted; every driver is then tried, and the failures throw together as one
   * `AggregateError`.
   */
  async deleteConversations(sessionId: SessionId): Promise<void> {
    const conversationsByDriver = this.#readConversations(sessionId);
    const purges: { driver: ProviderDriver; params: PurgeSessionParams }[] = [];
    for (const [driverName, conversations] of conversationsByDriver) {
      const driver = this.#providers.lookup(driverName);
      if (driver === undefined) {
        throw new DriverUnavailableError(driverName);
      }
      purges.push({ driver, params: { sessionId, conversations } });
    }
    const failures: unknown[] = [];
    for (const { driver, params } of purges) {
      try {
        await driver.purgeSession(params);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        failures.map((failure) => describeRejection(failure)).join("; "),
      );
    }
  }

  // Each driver's conversations, newest first: the ones the bindings name, latest write first,
  // then the ones the session left, latest left first. A conversation is listed once.
  #readConversations(
    sessionId: SessionId,
  ): Map<ProviderName, PurgeSessionParams["conversations"][number][]> {
    const runIds = this.#selectRunIds.all({ sessionId }).map((row) => row.runId);
    const bound = this.#runtimeBindings
      .findByRuns(runIds)
      .filter((binding): binding is RuntimeBinding & { resumeHandle: string } =>
        Boolean(binding.resumeHandle),
      )
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    const left = readLeftConversations(this.#reader, sessionId).reverse();
    const conversationsByDriver = new Map<
      ProviderName,
      PurgeSessionParams["conversations"][number][]
    >();
    const listed = new Set<string>();
    const list = (
      driverName: ProviderName,
      resumeHandle: string,
      providerAccountId: string | undefined,
    ): void => {
      const key = `${driverName}\u0000${resumeHandle}`;
      if (listed.has(key)) {
        return;
      }
      listed.add(key);
      const conversations = conversationsByDriver.get(driverName) ?? [];
      conversations.push({ resumeHandle, providerAccountId });
      conversationsByDriver.set(driverName, conversations);
    };
    for (const binding of bound) {
      list(binding.driverName, binding.resumeHandle, binding.spawnConfig.providerAccountId);
    }
    for (const conversation of left) {
      list(conversation.driverName, conversation.conversationId, conversation.providerAccountId);
    }
    return conversationsByDriver;
  }
}
