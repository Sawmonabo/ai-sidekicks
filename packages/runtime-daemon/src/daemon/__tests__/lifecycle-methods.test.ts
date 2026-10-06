// The flush waits for the writes under way when it arrives: a mutating call taken before it holds
// its answer until it finishes, answered or failed, while a read and a call taken after it never
// do, and a flush never waits for itself.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { InFlightMutations } from "../../ipc/in-flight-mutations.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { registerLifecycleMethods } from "../lifecycle-methods.js";

const NO_PARAMS = z.object({}).strict();

// A registry with the lifecycle verbs and two held methods, a write and a read, each answering
// only when the test releases that call.
function buildRegistry(): {
  registry: MethodRegistry;
  release: (method: "session.create" | "session.read", outcome: "answer" | "fail") => void;
} {
  const inFlight = new InFlightMutations();
  const registry = inFlight.wrap(new MethodRegistryImpl());
  registerLifecycleMethods(registry, {
    flush: () => inFlight.waitForPending(),
    acceptStop: () => Promise.resolve(),
  });
  const held = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
  for (const [method, mutating] of [
    ["session.create", true],
    ["session.read", false],
  ] as const) {
    held.set(method, []);
    registry.register(
      method,
      NO_PARAMS,
      NO_PARAMS,
      () =>
        new Promise((resolve, reject) => {
          held.get(method)!.push({ resolve: () => resolve({}), reject });
        }),
      { mutating },
    );
  }
  return {
    registry,
    release: (method, outcome) => {
      const call = held.get(method)!.shift()!;
      if (outcome === "answer") {
        call.resolve();
      } else {
        call.reject(new Error("the write failed"));
      }
    },
  };
}

// Dispatches without a transport, and records when the call settles.
function dispatch(registry: MethodRegistry, method: string): { isSettled: () => boolean } {
  let isSettled = false;
  const settle = (): void => {
    isSettled = true;
  };
  registry.dispatch(method, {}, {}).then(settle, settle);
  return { isSettled: () => isSettled };
}

// Lets every promise and immediate already queued run.
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("the flush", () => {
  it("answers once the writes taken before it finish, held by no read and no later write", async () => {
    const { registry, release } = buildRegistry();
    const earlierWrite = dispatch(registry, "session.create");
    const read = dispatch(registry, "session.read");
    const flush = dispatch(registry, "daemon.flush");
    const secondFlush = dispatch(registry, "daemon.flush");
    const laterWrite = dispatch(registry, "session.create");
    await drain();
    expect(flush.isSettled()).toBe(false);

    release("session.create", "answer");
    await drain();

    expect(earlierWrite.isSettled()).toBe(true);
    expect(flush.isSettled()).toBe(true);
    expect(secondFlush.isSettled()).toBe(true);
    expect(read.isSettled()).toBe(false);
    expect(laterWrite.isSettled()).toBe(false);
  });

  it("answers flushed when a write it waited for failed", async () => {
    const { registry, release } = buildRegistry();
    dispatch(registry, "session.create");
    const flush = registry.dispatch("daemon.flush", {}, {});

    release("session.create", "fail");

    await expect(flush).resolves.toStrictEqual({ flushed: true });
  });
});
