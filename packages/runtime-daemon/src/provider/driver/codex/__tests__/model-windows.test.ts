// The Codex model picker's windows: each `model/list` row takes its window from Codex's own catalog
// dump, joined by id, a model with a larger window gets a second row for it, and a dump or a row
// that cannot be read leaves rows without a window while the catalog still answers. A session on
// the larger window sends it as the conversation's `model_context_window`: checked against the
// catalog on create and sent as recorded on resume.

import { describe, expect, it } from "vitest";

import { LARGER_WINDOW_UNAVAILABLE_CODE, ModelCatalogUnreadableError } from "../../contract.js";
import {
  createHarness,
  DEFAULT_CODEX_HOME,
  EXECUTABLE_PATH,
  type Harness,
  sentContextWindow,
  TEST_MODEL,
} from "../__fixtures__/app-server-doubles.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "./lifecycle.test-support.js";

const DEFAULT_WINDOW = 272_000;
const LARGER_WINDOW = 872_000;

function catalogHarness(modelIds: readonly string[], catalogRows: readonly unknown[]): Harness {
  const harness = createHarness();
  harness.server.on("model/list", () => ({
    result: {
      data: modelIds.map((id) => ({ id, displayName: id.toUpperCase() })),
      nextCursor: null,
    },
  }));
  harness.server.catalogDump = JSON.stringify({ models: catalogRows });
  return harness;
}

function windowFailures(harness: Harness): unknown[] {
  return harness.driverDiagnosticRecords.filter(
    (record) => record.kind === "model_window_read_failed",
  );
}

describe("Codex model windows", () => {
  it("joins each row to its catalog entry by id, a larger window as a second row", async () => {
    const harness = catalogHarness(
      ["model-a", "model-b", "model-c", "model-e"],
      [
        { slug: "model-a", context_window: DEFAULT_WINDOW, max_context_window: LARGER_WINDOW },
        { slug: "model-b", max_context_window: 400_000 },
        { slug: "model-d", context_window: 128_000 },
        { slug: "model-e", context_window: 128_000, max_context_window: 128_000 },
      ],
    );

    const models = await harness.driver.listModels();

    // The default row first, then the larger one under the same id; equal figures are one row.
    expect(
      models.map((model) => [model.id, model.contextWindow, model.largerWindow]),
    ).toStrictEqual([
      ["model-a", DEFAULT_WINDOW, false],
      ["model-a", LARGER_WINDOW, true],
      ["model-b", 400_000, false],
      ["model-c", undefined, false],
      ["model-e", 128_000, false],
    ]);
    expect(models[3]).not.toHaveProperty("contextWindow");
    expect(harness.server.commandRuns).toEqual([
      expect.objectContaining({
        command: EXECUTABLE_PATH,
        args: ["debug", "models"],
        workingDirectory: DEFAULT_CODEX_HOME,
      }),
    ]);
    expect(windowFailures(harness)).toEqual([]);
  });

  it.each([
    ["is not JSON", "not json"],
    ["has no models array", JSON.stringify({ data: [] })],
  ])("answers with no window on any row when the dump %s, and records it", async (_label, dump) => {
    const harness = catalogHarness(["model-a"], []);
    harness.server.catalogDump = dump;

    const models = await harness.driver.listModels();

    expect(models.map((model) => model.id)).toEqual(["model-a"]);
    expect(models[0]).not.toHaveProperty("contextWindow");
    expect(windowFailures(harness)).toHaveLength(1);
  });

  it("leaves out only a row that fails its schema, recording it by slug", async () => {
    const harness = catalogHarness(
      ["model-a", "model-b", "model-c"],
      [
        { slug: "model-a", context_window: 272_000 },
        { slug: "model-b", context_window: "big" },
        { slug: "model-c", max_context_window: 400_000 },
      ],
    );

    const models = await harness.driver.listModels();

    expect(models[0]?.contextWindow).toBe(272_000);
    expect(models[1]).not.toHaveProperty("contextWindow");
    expect(models[2]?.contextWindow).toBe(400_000);
    expect(windowFailures(harness)).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ slug: "model-b", codexHome: DEFAULT_CODEX_HOME }),
      }),
    ]);
  });
});

describe("a Codex session on its model's larger window", () => {
  function windowsHarness(catalogRow: Record<string, unknown>): Harness {
    const harness = createHarness();
    harness.server.catalogDump = JSON.stringify({ models: [{ slug: TEST_MODEL, ...catalogRow }] });
    return harness;
  }

  it("starts the conversation on the larger window, and on the default without it", async () => {
    const larger = windowsHarness({
      context_window: DEFAULT_WINDOW,
      max_context_window: LARGER_WINDOW,
    });
    await larger.driver.createSession({ ...CREATE_PARAMS, largerWindow: LARGER_WINDOW });
    expect(sentContextWindow(larger, "thread/start")).toBe(LARGER_WINDOW);

    const plain = windowsHarness({
      context_window: DEFAULT_WINDOW,
      max_context_window: LARGER_WINDOW,
    });
    await plain.driver.createSession(CREATE_PARAMS);
    expect(sentContextWindow(plain, "thread/start")).toBe("omitted");
    expect(plain.server.commandRuns).toEqual([]);
  });

  it.each([
    ["no larger window", { context_window: DEFAULT_WINDOW, max_context_window: DEFAULT_WINDOW }],
    [
      "a different larger window",
      { context_window: DEFAULT_WINDOW, max_context_window: 1_000_000 },
    ],
  ])("refuses a create the catalog now offers %s for, starting nothing", async (_label, row) => {
    const harness = windowsHarness(row);

    await expect(
      harness.driver.createSession({ ...CREATE_PARAMS, largerWindow: LARGER_WINDOW }),
    ).rejects.toMatchObject({ code: LARGER_WINDOW_UNAVAILABLE_CODE });
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
  });

  it("refuses a create whose model's own catalog row is unreadable", async () => {
    const harness = windowsHarness({ context_window: "big", max_context_window: LARGER_WINDOW });

    await expect(
      harness.driver.createSession({ ...CREATE_PARAMS, largerWindow: LARGER_WINDOW }),
    ).rejects.toBeInstanceOf(ModelCatalogUnreadableError);
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
  });

  it("reopens on the recorded window whatever the catalog offers now, reading none", async () => {
    // The session keeps the window it chose; a catalog that dropped it changes nothing here.
    const harness = windowsHarness({
      context_window: DEFAULT_WINDOW,
      max_context_window: DEFAULT_WINDOW,
    });

    const result = await harness.driver.resumeSession({
      ...RESUME_PARAMS,
      largerWindow: LARGER_WINDOW,
    });

    expect(result).toMatchObject({ status: "resumed" });
    expect(sentContextWindow(harness, "thread/fork")).toBe(LARGER_WINDOW);
    expect(harness.server.commandRuns).toEqual([]);
  });
});
