// The workers that run WebAssembly work in the built app under the policy the app's scheme serves
// them. The diagram worker compiles merman's WebAssembly and the markdown worker Sätteri's, which
// only their own scripts' responses admit, so a policy that stops reaching either leaves every
// diagram undrawn or every reply unformatted. The browser tier serves no policy, so only a
// launched app can catch it. Each worker is started in the console document, as the app starts
// it: the diagram worker is asked for one drawing, shown as an image the way a diagram block shows
// it, and the markdown worker compiles the parser, which the page hands a second worker to parse
// with, as the app hands it to every worker after the first.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import {
  DIAGRAM_WORKER_BUNDLE_NAME,
  isWebAssemblyWorkerScript,
  MARKDOWN_WORKER_BUNDLE_NAME,
} from "#main/services/renderer/scheme.js";
import type {
  DiagramDrawRequest,
  DiagramWorkerReply,
} from "#renderer/components/Markdown/diagram/worker/messages.js";
import type {
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
} from "#renderer/components/Markdown/worker/messages.js";
import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists, PACKAGE_ROOT } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

/** One small diagram, drawn on a plain palette, which is all the policy check needs. */
const DRAW_REQUEST: DiagramDrawRequest = {
  kind: "draw",
  requestId: 1,
  source: "flowchart LR\n  write --> route\n",
  palette: {
    identity: "e2e",
    isDark: true,
    groundColor: "#101010",
    fontFamily: "sans-serif",
    fontSizePx: 16,
    colors: {},
  },
  pictureKind: "shown",
};

/** What the drawing came to in the console document, and what its policy refused meanwhile. */
interface DrawingResult {
  readonly drawing:
    | { readonly status: "shown"; readonly width: number }
    | { readonly status: "not-shown"; readonly reason: string };
  readonly refusals: readonly string[];
}

/** What the markdown workers' parses came to in the console document, and what was refused. */
interface ParsingResult {
  /** Each worker's tree's size in bytes, or why it gave none. */
  readonly parses: readonly (number | string)[];
  readonly refusals: readonly string[];
}

/** A short reply holding a formula, which the markdown worker parses. */
const PARSED_REPLY = "A **bold** word and $x^2$, which costs $5.";

/** The served path of the one built script of the worker named `bundleName`. */
function workerScriptPathOf(bundleName: string): string {
  const workerScripts = readdirSync(join(PACKAGE_ROOT, "out", "renderer", "assets")).filter(
    (fileName) => isWebAssemblyWorkerScript(fileName) && fileName.startsWith(`${bundleName}-`),
  );
  expect(workerScripts).toHaveLength(1);
  return `/assets/${workerScripts[0] ?? ""}`;
}

describe.skipIf(!bundleIsBuilt)(
  "end-to-end — the WebAssembly workers under the app's policy",
  () => {
    it("draws and shows a picture with nothing refused, and the page compiles no WebAssembly", async () => {
      const workerScriptPath = workerScriptPathOf(DIAGRAM_WORKER_BUNDLE_NAME);

      // A scenario, so the launch needs no background service of its own.
      await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
        const result = await appUnderTest.consolePage.evaluate(
          async ([scriptPath, request, waitMs]): Promise<DrawingResult> => {
            const refusals: string[] = [];
            const noteRefusal = (event: SecurityPolicyViolationEvent): void => {
              refusals.push(`${event.effectiveDirective} ${event.blockedURI}`);
            };
            document.addEventListener("securitypolicyviolation", noteRefusal);
            const worker = new Worker(scriptPath, { type: "module" });
            try {
              const drawing = await new Promise<DrawingResult["drawing"]>((resolve) => {
                const wait = setTimeout(() => {
                  resolve({ status: "not-shown", reason: "the worker never answered" });
                }, waitMs);
                const settle = (outcome: DrawingResult["drawing"]): void => {
                  clearTimeout(wait);
                  resolve(outcome);
                };
                worker.addEventListener("error", (event) => {
                  settle({ status: "not-shown", reason: event.message });
                });
                // Label asks go unanswered, so the worker draws with merman's own widths.
                worker.addEventListener("message", (event: MessageEvent<DiagramWorkerReply>) => {
                  const reply = event.data;
                  if (reply.status === "loaded") {
                    worker.postMessage(request);
                  } else if (reply.status === "load-failed" || reply.status === "library-failed") {
                    settle({ status: "not-shown", reason: reply.reason });
                  } else if (reply.status === "timed-out") {
                    settle({ status: "not-shown", reason: reply.status });
                  } else if (reply.status !== "measure-labels") {
                    if (reply.outcome.kind !== "drawn") {
                      settle({ status: "not-shown", reason: reply.outcome.reason });
                      return;
                    }
                    const picture = new Image();
                    picture.src = URL.createObjectURL(
                      new Blob([reply.outcome.markup], { type: "image/svg+xml" }),
                    );
                    void picture.decode().then(
                      () => {
                        settle({ status: "shown", width: picture.naturalWidth });
                      },
                      () => {
                        settle({ status: "not-shown", reason: "the picture did not decode" });
                      },
                    );
                  }
                });
              });
              return { drawing, refusals };
            } finally {
              worker.terminate();
              document.removeEventListener("securitypolicyviolation", noteRefusal);
            }
          },
          [
            workerScriptPath,
            DRAW_REQUEST,
            appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          ] as const,
        );

        expect(result.drawing).toMatchObject({ status: "shown" });
        expect(result.drawing.status === "shown" && result.drawing.width > 0).toBe(true);
        expect(result.refusals).toStrictEqual([]);

        // The page's own policy leaves the keyword out, so the console document cannot compile.
        const pageCompile = await appUnderTest.consolePage.evaluate(async () => {
          const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
          return await WebAssembly.compile(emptyModule).then(
            () => "compiled",
            (error: unknown) => (error instanceof Error ? error.name : String(error)),
          );
        });
        expect(pageCompile).toBe("CompileError");
      });
    });

    it("compiles the parser in the markdown worker and parses with it there and in a second worker", async () => {
      const workerScriptPath = workerScriptPathOf(MARKDOWN_WORKER_BUNDLE_NAME);

      await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
        const result = await appUnderTest.consolePage.evaluate(
          async ([scriptPath, source, waitMs]): Promise<ParsingResult> => {
            const refusals: string[] = [];
            const noteRefusal = (event: SecurityPolicyViolationEvent): void => {
              refusals.push(`${event.effectiveDirective} ${event.blockedURI}`);
            };
            document.addEventListener("securitypolicyviolation", noteRefusal);
            const workers: Worker[] = [];
            // Loads one worker with `parser`, or has it compile one, and parses the reply there.
            const parseIn = (
              parser: WebAssembly.Module | undefined,
            ): Promise<{
              readonly compiled?: WebAssembly.Module;
              readonly parse: number | string;
            }> =>
              new Promise((resolve) => {
                const worker = new Worker(scriptPath, { type: "module", name: "markdown" });
                workers.push(worker);
                let compiled: WebAssembly.Module | undefined;
                const wait = setTimeout(() => {
                  resolve({ parse: "the worker never answered" });
                }, waitMs);
                const settle = (parse: number | string): void => {
                  clearTimeout(wait);
                  resolve(compiled === undefined ? { parse } : { compiled, parse });
                };
                worker.addEventListener("error", (event) => {
                  settle(event.message);
                });
                worker.addEventListener("message", (event: MessageEvent<MarkdownWorkerReply>) => {
                  const reply = event.data;
                  if (reply.status === "compiled") {
                    compiled = reply.parser;
                  } else if (reply.status === "parsed") {
                    settle(reply.trees[0]?.buffer.byteLength ?? "no tree");
                  } else if (reply.status === "load-failed" || reply.status === "parser-failed") {
                    settle(reply.reason);
                  }
                });
                const messages: MarkdownWorkerMessage[] = [
                  { kind: "load", parser },
                  { kind: "parse", requestId: 1, source },
                ];
                for (const message of messages) {
                  worker.postMessage(message);
                }
              });
            try {
              const first = await parseIn(undefined);
              const second =
                first.compiled === undefined
                  ? { parse: "the first worker sent no parser" }
                  : await parseIn(first.compiled);
              return { parses: [first.parse, second.parse], refusals };
            } finally {
              for (const worker of workers) {
                worker.terminate();
              }
              document.removeEventListener("securitypolicyviolation", noteRefusal);
            }
          },
          [
            workerScriptPath,
            PARSED_REPLY,
            appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          ] as const,
        );

        expect(result.parses.map((parse) => typeof parse)).toStrictEqual(["number", "number"]);
        expect(result.parses.every((parse) => typeof parse === "number" && parse > 0)).toBe(true);
        expect(result.refusals).toStrictEqual([]);
      });
    });
  },
);
