// The diagram worker draws in the built app under the policy the app's scheme serves it. It
// compiles merman's WebAssembly, which only its own script's response admits, so a policy that
// stops reaching the worker leaves every diagram undrawn. The browser tier serves no policy, so
// only a launched app can catch it. The worker is started in the console document, as the app
// starts it, and asked for one drawing, which is shown as an image the way a diagram block shows
// it.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { isDiagramWorkerScript } from "#main/services/renderer/scheme.js";
import type {
  DiagramDrawRequest,
  DiagramWorkerReply,
} from "#renderer/components/Markdown/diagram/worker/messages.js";
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

describe.skipIf(!bundleIsBuilt)("end-to-end — a diagram under the app's policy", () => {
  it("draws and shows a picture with nothing refused, and the page compiles no WebAssembly", async () => {
    const workerScripts = readdirSync(join(PACKAGE_ROOT, "out", "renderer", "assets")).filter(
      isDiagramWorkerScript,
    );
    expect(workerScripts).toHaveLength(1);
    const workerScriptPath = `/assets/${workerScripts[0] ?? ""}`;

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
});
