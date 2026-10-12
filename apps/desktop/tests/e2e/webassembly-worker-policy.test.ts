// The workers that run WebAssembly work in the built app under the policy the app's scheme serves
// them. The diagram worker compiles merman's WebAssembly and the markdown worker Sätteri's, which
// only their own scripts' responses admit, so a policy that stops reaching either leaves every
// diagram undrawn or every reply unformatted. The browser tier serves no policy, so only a
// launched app can catch it. Each worker is started in the console document, as the app starts
// it: the diagram worker is asked for one drawing, shown as an image the way a diagram block shows
// it, and the markdown worker compiles the parser, which the page hands a second worker to parse
// with, as the app hands it to every worker after the first. The page itself never compiles, but
// it runs the modules the markdown worker compiled: the app hands the parser to the page's parser,
// which must instantiate it and parse with nothing refused, and the text-compression module to the
// page's text codec, which must instantiate it and pack and unpack a chunk with nothing refused.

import { readdirSync, readFileSync } from "node:fs";
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

/** What the page's own parser made of a reply, and what the page's policy refused meanwhile. */
interface PageParseResult {
  /** The type of the reply's first node, or why the page could not parse it. */
  readonly parsed: string;
  readonly refusals: readonly string[];
}

/** What the page's own run of the worker's text-compression module made of a chunk. */
interface PageCodecResult {
  /** The chunk's packed size and the text it unpacked to, or why the page could not run it. */
  readonly roundTrip: { readonly packedLength: number; readonly unpacked: string } | string;
  readonly refusals: readonly string[];
}

/** Text that packs: one line many times over, multibyte characters among it. */
const PACKED_TEXT = "Café — 漢字 🙂 a line that repeats\n".repeat(200);

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

/**
 * The served path of the parse module the page's parser loads: the one script the page's own
 * chunks import it as, which the markdown worker's bundle does not.
 */
function pageParserScriptPath(): string {
  const assets = join(PACKAGE_ROOT, "out", "renderer", "assets");
  const imported = readdirSync(assets)
    .filter((fileName) => fileName.endsWith(".js") && !isWebAssemblyWorkerScript(fileName))
    .flatMap((fileName) =>
      Array.from(
        readFileSync(join(assets, fileName), "utf8").matchAll(PARSE_MODULE_IMPORT),
        (match) => match[1],
      ),
    );
  expect(new Set(imported).size).toBe(1);
  return `/assets/${imported[0] ?? ""}`;
}

/** A built chunk's dynamic import of the parse module, by its hashed file name. */
const PARSE_MODULE_IMPORT = /import\(`\.\/(serialized-tree-[\w-]+\.js)`\)/gu;

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

    it("instantiates the markdown worker's parser and text codec on the page, nothing refused", async () => {
      const loaderPath = pageParserScriptPath();
      const workerScriptPath = workerScriptPathOf(MARKDOWN_WORKER_BUNDLE_NAME);
      await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
        const page = appUnderTest.consolePage;
        // What the page's policy refuses from here on, kept in the page while the app runs.
        const refusals = await page.evaluateHandle(() => {
          const noted: string[] = [];
          document.addEventListener("securitypolicyviolation", (event) => {
            noted.push(`${event.effectiveDirective} ${event.blockedURI}`);
          });
          return noted;
        });
        // The app starts its page parser once the worker it wakes at start sends back the module
        // it compiled, setting the module where the parse module's loader reads it.
        const isHanded = await page.evaluate(async (waitMs) => {
          const scope = globalThis as { satteriWasmModule?: WebAssembly.Module };
          const deadline = performance.now() + waitMs;
          while (scope.satteriWasmModule === undefined && performance.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, 50);
            });
          }
          return scope.satteriWasmModule !== undefined;
        }, appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS));
        expect(isHanded).toBe(true);
        // The page's own parse module, the instance its parser loaded. Written as a string: the
        // test runner rewrites a dynamic import inside a function it hands the page.
        const loader = await page.evaluateHandle(`import(${JSON.stringify(loaderPath)})`);
        const result = await page.evaluate(
          ([parseModule, noted, source]): PageParseResult => {
            const parse = parseModule as {
              readonly parseMarkdownTree: (text: string) => {
                readonly children: readonly { readonly type: string }[];
              };
            };
            return {
              parsed: parse.parseMarkdownTree(source).children[0]?.type ?? "no node",
              refusals: [...noted],
            };
          },
          [loader, refusals, PARSED_REPLY] as const,
        );

        expect(result).toStrictEqual({ parsed: "paragraph", refusals: [] });

        // The codec the worker compiles beside the parser, run on the page as the app's text codec
        // runs it: instantiated with nothing imported, a chunk packed and unpacked in its memory.
        const codec = await page.evaluate(
          async ([scriptPath, noted, text, waitMs]): Promise<PageCodecResult> => {
            const worker = new Worker(scriptPath, { type: "module", name: "markdown" });
            try {
              const compiled = await new Promise<MarkdownWorkerReply>((resolve, reject) => {
                const wait = setTimeout(() => {
                  reject(new Error("the worker never answered"));
                }, waitMs);
                worker.addEventListener("message", (event: MessageEvent<MarkdownWorkerReply>) => {
                  if (event.data.status === "compiled" || event.data.status === "load-failed") {
                    clearTimeout(wait);
                    resolve(event.data);
                  }
                });
                const load: MarkdownWorkerMessage = { kind: "load", parser: undefined };
                worker.postMessage(load);
              });
              if (compiled.status !== "compiled") {
                return { roundTrip: JSON.stringify(compiled), refusals: [...noted] };
              }
              if (compiled.textCompression.status !== "compiled") {
                return { roundTrip: compiled.textCompression.reason, refusals: [...noted] };
              }
              const instance = new WebAssembly.Instance(compiled.textCompression.module, {});
              const codec = instance.exports as {
                readonly memory: WebAssembly.Memory;
                readonly plain_ptr: () => number;
                readonly packed_ptr: () => number;
                readonly compress: (length: number) => number;
                readonly decompress: (length: number) => number;
              };
              const bytes = new TextEncoder().encode(text);
              new Uint8Array(codec.memory.buffer, codec.plain_ptr(), bytes.length).set(bytes);
              const packedLength = codec.compress(bytes.length);
              new Uint8Array(codec.memory.buffer, codec.plain_ptr(), bytes.length).fill(0);
              const unpackedLength = codec.decompress(packedLength);
              const unpacked = new TextDecoder().decode(
                new Uint8Array(codec.memory.buffer, codec.plain_ptr(), unpackedLength),
              );
              return { roundTrip: { packedLength, unpacked }, refusals: [...noted] };
            } finally {
              worker.terminate();
            }
          },
          [
            workerScriptPath,
            refusals,
            PACKED_TEXT,
            appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          ] as const,
        );

        expect(codec.refusals).toStrictEqual([]);
        const roundTrip =
          typeof codec.roundTrip === "string" ? expect.fail(codec.roundTrip) : codec.roundTrip;
        expect(roundTrip.unpacked).toBe(PACKED_TEXT);
        expect(roundTrip.packedLength).toBeGreaterThan(0);
        expect(roundTrip.packedLength).toBeLessThan(new TextEncoder().encode(PACKED_TEXT).length);
      });
    });
  },
);
