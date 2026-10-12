// The tokenizing thread gives its memory back: it ends once it has sat idle, and the next read
// starts a fresh one. A line it cannot finish holds only the thread: the daemon goes on answering,
// and at the time limit that line is left plain while the rest of the file is colored.

import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { STUCK_LINE_HOOK_URL, STUCK_LINE_MARKER } from "../__fixtures__/stuck-line-hook.js";
import { TokenizerThread } from "../thread.js";
import { decodeSpans } from "./spans.test-support.js";

// Every worker thread this file starts, so a test can watch the tokenizing thread start and end.
const startedWorkers = vi.hoisted((): import("node:worker_threads").Worker[] => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      startedWorkers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

let tokenizer: TokenizerThread | undefined;

afterEach(async () => {
  await tokenizer?.stop();
  tokenizer = undefined;
});

describe("a tokenizing thread with nothing asked", () => {
  it("ends after the idle time, and the next read starts a fresh one", async () => {
    tokenizer = new TokenizerThread({ idleEndMs: 200 });
    const source = "const answer = 42;\n";
    const first = await tokenizer.tokenize(source, "typescript");
    const firstWorker = startedWorkers.at(-1);
    expect(firstWorker).toBeDefined();
    const startedBefore = startedWorkers.length;

    await new Promise<void>((resolve) => {
      firstWorker?.once("exit", () => {
        resolve();
      });
    });

    expect(await tokenizer.tokenize(source, "typescript")).toStrictEqual(first);
    expect(startedWorkers.length).toBe(startedBefore + 1);
  }, 20_000);
});

describe("a line the tokenizer cannot finish", () => {
  it("stays plain while the rest is colored and the daemon goes on answering", async () => {
    tokenizer = new TokenizerThread({ lineHookModuleUrl: STUCK_LINE_HOOK_URL });
    const source = `const before = 1;\nconst ${STUCK_LINE_MARKER} = "x";\nconst after = 3;\n`;

    let isSettled = false;
    const tokenizing = tokenizer.tokenize(source, "typescript").finally(() => {
      isSettled = true;
    });
    // A timer fires while the line holds the thread, which a line on the daemon's own thread would
    // block.
    await delay(500);
    expect(isSettled).toBe(false);

    expect(decodeSpans(source, await tokenizing)).toStrictEqual([
      ["const", "keyword"],
      ["1", "number"],
      ["const", "keyword"],
      ["3", "number"],
    ]);
  }, 20_000);
});
