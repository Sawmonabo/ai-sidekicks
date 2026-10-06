// The Codex leg of the output-speed axis: the service tier a thread and each turn carry, resolved
// against the model's catalog row so a level the model does not list runs at standard; the tier
// the thread declares back; and the per-run report of the tier each turn settled at.

import type { RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/transcript";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import {
  readDeclaredOutputSpeed,
  type RunOutputSpeedSettledListener,
} from "../../declared-output-speed.js";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import { isPlainObject } from "../../record-readers.js";
import {
  CODEX_DRIVER_NAME,
  CODEX_STANDARD_OUTPUT_SPEED,
  resolveCodexModelCatalog,
  type CodexModelCatalogExchange,
} from "./capabilities.js";
import {
  CODEX_ITEM_STARTED_METHOD,
  CODEX_THREAD_SETTINGS_UPDATED_METHOD,
  CODEX_TURN_COMPLETED_METHOD,
} from "./event-normalizer.js";
import type { CodexLifecycleOptions, CodexSessionRecord } from "./session/state.js";

/**
 * The `serviceTier` member a thread or turn request carries for `level`: none with no level held,
 * so the provider keeps its own tier; `null` for standard, the wire's way to clear the tier, since
 * an omitted member leaves it unchanged; otherwise the tier id itself.
 */
export function composeCodexServiceTier(level: string | undefined): {
  serviceTier?: string | null;
} {
  if (level === undefined) {
    return {};
  }
  return { serviceTier: level === CODEX_STANDARD_OUTPUT_SPEED ? null : level };
}

/** What the Codex output-speed leg reads through and reports to. */
export type CodexOutputSpeedDependencies = Pick<
  CodexLifecycleOptions,
  "modelCatalogExchange" | "diagnostics" | "onRunOutputSpeedSettled"
>;

/**
 * Resolves the level a carrier sends, reads the tier a thread declares back, and reports the tier
 * each run settled at.
 */
export class CodexOutputSpeed {
  readonly #modelCatalogExchange: CodexModelCatalogExchange;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #onRunOutputSpeedSettled: RunOutputSpeedSettledListener | undefined;

  constructor(dependencies: CodexOutputSpeedDependencies) {
    this.#modelCatalogExchange = dependencies.modelCatalogExchange;
    this.#diagnostics = dependencies.diagnostics;
    this.#onRunOutputSpeedSettled = dependencies.onRunOutputSpeedSettled;
  }

  /** Whether resolving `level` reads the catalog: standard and an absent level run as they are. */
  needsCatalogRead(level: string | undefined): level is string {
    return level !== undefined && level !== CODEX_STANDARD_OUTPUT_SPEED;
  }

  /**
   * The level a carried `level` runs at on `model`: itself where a fresh catalog read lists it for
   * that model, else standard, so no carried level is refused and none the model lacks is sent.
   * Standard and an absent level need no read. A failed catalog read propagates.
   */
  async resolveLevel(model: string, level: string | undefined): Promise<string | undefined> {
    if (!this.needsCatalogRead(level)) {
      return level;
    }
    const catalog = await resolveCodexModelCatalog(this.#modelCatalogExchange);
    const levels = catalog.find((entry) => entry.id === model)?.outputSpeedLevels ?? [];
    return levels.includes(level) ? level : CODEX_STANDARD_OUTPUT_SPEED;
  }

  /**
   * The tier a `thread/start`, `thread/resume` or `thread/fork` reply declares, or `undefined`
   * when the reply carries no `serviceTier` member.
   */
  readDeclaredTier(sessionId: SessionId, reply: unknown): ProviderOutputSpeedState | undefined {
    if (!isPlainObject(reply) || !Object.hasOwn(reply, "serviceTier")) {
      return undefined;
    }
    return this.#readTier(sessionId, reply["serviceTier"]);
  }

  /**
   * Arms an accepted turn's run to report the tier it settles at. A turn whose `sentLevel` changes
   * the declared tier settles on the settings notice that change produces; any other settles on
   * its first item. A turn that already ended settles now, on the tier the thread holds.
   */
  armRunSettlement(
    record: CodexSessionRecord,
    turnId: string,
    runId: RunId,
    sentLevel: string | undefined,
  ): void {
    if (record.settledTurnIds.has(turnId)) {
      this.#reportSettled(record, runId);
      return;
    }
    record.unsettledOutputSpeedRuns.set(turnId, {
      runId,
      awaitsSettingsNotice:
        sentLevel !== undefined && sentLevel !== record.declaredOutputSpeed?.declared,
    });
  }

  /**
   * Reads the record's own thread's tier from `thread/settings/updated` and settles every run
   * armed on the record; settles a turn's run on its first `item/started` unless it awaits that
   * notice; and settles whatever is left on the turn's `turn/completed`. A child thread's frames
   * change nothing.
   */
  observeServerNotification(
    record: CodexSessionRecord | undefined,
    method: string,
    params: unknown,
  ): void {
    if (record === undefined || !isPlainObject(params) || params["threadId"] !== record.threadId) {
      return;
    }
    if (method === CODEX_THREAD_SETTINGS_UPDATED_METHOD) {
      const threadSettings = params["threadSettings"];
      if (!isPlainObject(threadSettings) || !Object.hasOwn(threadSettings, "serviceTier")) {
        return;
      }
      record.declaredOutputSpeed = this.#readTier(record.sessionId, threadSettings["serviceTier"]);
      for (const turnId of [...record.unsettledOutputSpeedRuns.keys()]) {
        this.#settleTurn(record, turnId);
      }
      return;
    }
    if (method === CODEX_ITEM_STARTED_METHOD) {
      const turnId = params["turnId"];
      if (
        typeof turnId === "string" &&
        record.unsettledOutputSpeedRuns.get(turnId)?.awaitsSettingsNotice === false
      ) {
        this.#settleTurn(record, turnId);
      }
      return;
    }
    if (method === CODEX_TURN_COMPLETED_METHOD) {
      const turn = params["turn"];
      const turnId = isPlainObject(turn) ? turn["id"] : undefined;
      if (typeof turnId === "string") {
        this.#settleTurn(record, turnId);
      }
    }
  }

  #settleTurn(record: CodexSessionRecord, turnId: string): void {
    const unsettled = record.unsettledOutputSpeedRuns.get(turnId);
    if (unsettled === undefined) {
      return;
    }
    record.unsettledOutputSpeedRuns.delete(turnId);
    this.#reportSettled(record, unsettled.runId);
  }

  // Nothing is reported for a thread that never declared a tier.
  #reportSettled(record: CodexSessionRecord, runId: RunId): void {
    if (record.declaredOutputSpeed !== undefined) {
      this.#onRunOutputSpeedSettled?.(record.sessionId, runId, record.declaredOutputSpeed);
    }
  }

  // A null tier is a thread on standard speed: a reading, never an absence.
  #readTier(sessionId: SessionId, tier: unknown): ProviderOutputSpeedState | undefined {
    return readDeclaredOutputSpeed(
      {
        provider: CODEX_DRIVER_NAME,
        sessionId,
        declared: tier === null ? CODEX_STANDARD_OUTPUT_SPEED : tier,
        reason: null,
      },
      this.#diagnostics,
    );
  }
}
