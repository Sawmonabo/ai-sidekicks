// Each Codex model's context windows, read from the raw catalog `codex debug models` prints:
// `model/list` carries no window, while each catalog row carries the model's default window and
// the largest one it can be set to.

import { z } from "zod";

import type { ProviderModel } from "@ai-sidekicks/contracts/provider/driver/capabilities";

import { describeRejection } from "../../../rejection.js";
import { isPlainObject, readNonEmptyString } from "../../record-readers.js";
import { ModelCatalogUnreadableError } from "../contract.js";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import type { CodexService } from "./service/supervisor.js";
import { normalizeProviderFailureDetail } from "./session/errors.js";

const CODEX_CATALOG_DUMP_NAME = "Codex debug models";

/** The windows Codex's catalog gives one model, in tokens; either may be absent. */
export interface CodexModelWindow {
  readonly contextWindow: number | undefined;
  readonly maxContextWindow: number | undefined;
}

/** A catalog row left out of the windows, named by its slug when one could be read. */
interface CodexRejectedModelRow {
  readonly slug: string | null;
  readonly detail: string;
}

/** One catalog dump read: each model's windows by slug, and the rows that could not be read. */
interface CodexModelWindowReading {
  readonly windows: ReadonlyMap<string, CodexModelWindow>;
  readonly rejectedRows: readonly CodexRejectedModelRow[];
}

const CodexCatalogDumpSchema = z.object({ models: z.array(z.unknown()) });

// A row's other keys (its instructions, tiers and effort levels) are not read here.
const CodexCatalogRowSchema = z.object({
  slug: z.string().min(1),
  context_window: z.number().int().positive().optional(),
  max_context_window: z.number().int().positive().optional(),
});

/**
 * Reads the windows from a `codex debug models` dump, row by row: a row that fails its schema is
 * left out and returned among the rejected rows, and a row with neither window is left out.
 * Throws {@link ModelCatalogUnreadableError} when the dump is not JSON or has no `models` array.
 */
function readCodexModelWindows(dump: string): CodexModelWindowReading {
  let parsedDump: unknown;
  try {
    parsedDump = JSON.parse(dump);
  } catch (cause) {
    throw new ModelCatalogUnreadableError(
      CODEX_CATALOG_DUMP_NAME,
      `the output is not JSON (${describeRejection(cause)})`,
    );
  }
  const catalog = CodexCatalogDumpSchema.safeParse(parsedDump);
  if (!catalog.success) {
    throw new ModelCatalogUnreadableError(
      CODEX_CATALOG_DUMP_NAME,
      "the output has no `models` array",
    );
  }
  const windows = new Map<string, CodexModelWindow>();
  const rejectedRows: CodexRejectedModelRow[] = [];
  for (const rawRow of catalog.data.models) {
    const row = CodexCatalogRowSchema.safeParse(rawRow);
    if (!row.success) {
      rejectedRows.push({
        slug: isPlainObject(rawRow) ? (readNonEmptyString(rawRow, "slug") ?? null) : null,
        detail: z.prettifyError(row.error),
      });
      continue;
    }
    const { slug, context_window: contextWindow, max_context_window: maxContextWindow } = row.data;
    if (contextWindow !== undefined || maxContextWindow !== undefined) {
      windows.set(slug, { contextWindow, maxContextWindow });
    }
  }
  return { windows, rejectedRows };
}

/**
 * Each model's windows from the service's own catalog dump. Never throws: a failed read, or a row
 * that could not be read, records `model_window_read_failed` and leaves those models without one.
 */
export async function readCodexServiceModelWindows(
  service: CodexService,
  diagnostics: DriverDiagnosticsEmitter,
): Promise<ReadonlyMap<string, CodexModelWindow>> {
  const reportFailure = (
    detail: string,
    rowDetails: Readonly<Record<string, string | null>>,
  ): void => {
    diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      providerAccountId: service.home.providerAccountId,
      kind: "model_window_read_failed",
      rawWireType: null,
      dispositionReason: detail,
      details: { codexHome: service.home.codexHome, ...rowDetails },
    });
  };
  let reading: CodexModelWindowReading;
  try {
    reading = readCodexModelWindows(await service.readModelCatalogDump());
  } catch (cause) {
    reportFailure(normalizeProviderFailureDetail(cause), {});
    return new Map<string, CodexModelWindow>();
  }
  for (const rejected of reading.rejectedRows) {
    reportFailure(normalizeProviderFailureDetail(rejected.detail), { slug: rejected.slug });
  }
  return reading.windows;
}

/**
 * The `model/list` rows with `contextWindow` set where the catalog gives the row's id a window:
 * the default window, else the largest, as Codex resolves it. A model whose largest window
 * exceeds its default gets a second row right after it, with the same id, `largerWindow` set and
 * the largest window. Other rows are returned unchanged.
 */
export function joinCodexModelWindows(
  models: readonly ProviderModel[],
  windows: ReadonlyMap<string, CodexModelWindow>,
): ProviderModel[] {
  return models.flatMap((model) => {
    const window = windows.get(model.id);
    const contextWindow = window?.contextWindow ?? window?.maxContextWindow;
    if (contextWindow === undefined) {
      return [model];
    }
    const largerWindow = findCodexLargerWindow(windows, model.id);
    const defaultRow: ProviderModel = { ...model, contextWindow };
    return largerWindow === undefined
      ? [defaultRow]
      : [defaultRow, { ...defaultRow, contextWindow: largerWindow, largerWindow: true }];
  });
}

/**
 * The larger window, in tokens, a `codex debug models` dump offers `modelId`, as its picker row
 * shows it; `undefined` for a model with one window or none listed. Throws
 * {@link ModelCatalogUnreadableError} when the dump, or the model's own row, cannot be read.
 */
export function readCodexLargerWindow(dump: string, modelId: string): number | undefined {
  const { windows, rejectedRows } = readCodexModelWindows(dump);
  const rejectedRow = rejectedRows.find((rejected) => rejected.slug === modelId);
  if (rejectedRow !== undefined) {
    throw new ModelCatalogUnreadableError(
      CODEX_CATALOG_DUMP_NAME,
      `the row of model '${modelId}' is unreadable (${rejectedRow.detail})`,
    );
  }
  return findCodexLargerWindow(windows, modelId);
}

// A model's largest window, only where it exceeds the default.
function findCodexLargerWindow(
  windows: ReadonlyMap<string, CodexModelWindow>,
  modelId: string,
): number | undefined {
  const window = windows.get(modelId);
  if (window?.contextWindow === undefined || window.maxContextWindow === undefined) {
    return undefined;
  }
  return window.maxContextWindow > window.contextWindow ? window.maxContextWindow : undefined;
}
