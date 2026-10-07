// The per-address counter inside workerd, against the Worker's own Durable Object binding. Fake
// time moves `Date.now()` inside the object, which runs in the test's isolate. Each test counts a
// different address, so no test meets another's state.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_ENDPOINT_GROUPS } from "../endpoint-groups.js";
import type { RateLimitIdentityDurableObject } from "../identity-durable-object.js";

const { limit, periodSeconds } = RATE_LIMIT_ENDPOINT_GROUPS["auth.endpoint"];
const windowMilliseconds = periodSeconds * 1000;
const consume = { group: "auth.endpoint", limit, windowSeconds: periodSeconds } as const;

const namespace = env.RATE_LIMIT_IDENTITY;

function counterFor(address: string): DurableObjectStub<RateLimitIdentityDurableObject> {
  return namespace.get(namespace.idFromName(address));
}

function readAlarm(
  stub: DurableObjectStub<RateLimitIdentityDurableObject>,
): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

function isoAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

// A day ahead of the real clock: workerd fires a due alarm on its own, so only
// `runDurableObjectAlarm` may run one here.
let startTime: number;

beforeEach(() => {
  startTime = Date.now() + 86_400_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startTime);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RateLimitIdentityDurableObject", () => {
  it("refuses the request past the limit atomically, whichever stub sent it", async () => {
    const address = "203.0.113.1";
    // Two separately resolved stubs stand for two locations reaching the one object.
    const firstStub = counterFor(address);
    const secondStub = counterFor(address);
    const responses = await Promise.all(
      Array.from({ length: limit + 1 }, (_, index) =>
        (index % 2 === 0 ? firstStub : secondStub).checkAndConsume(consume),
      ),
    );

    const allowed = responses.filter((response) => response.allowed);
    const refused = responses.filter((response) => !response.allowed);
    expect(allowed).toHaveLength(limit);
    // Each allowed request saw a distinct count, so no two read the window at once.
    expect(allowed.map((response) => response.remaining).sort((a, b) => a - b)).toEqual(
      Array.from({ length: limit }, (_, index) => index),
    );
    expect(refused).toEqual([
      { allowed: false, remaining: 0, resetAt: isoAt(startTime + windowMilliseconds), limit },
    ]);

    // A refusal records nothing, so a retry at the reported `resetAt` meets an empty window.
    vi.setSystemTime(startTime + 30_000);
    expect((await firstStub.checkAndConsume(consume)).allowed).toBe(false);
    vi.setSystemTime(startTime + windowMilliseconds);
    expect(await secondStub.checkAndConsume(consume)).toEqual({
      allowed: true,
      remaining: limit - 1,
      resetAt: isoAt(startTime + 2 * windowMilliseconds),
      limit,
    });
  });

  it("keeps the count and the alarm across a restart", async () => {
    const stub = counterFor("203.0.113.2");
    await stub.checkAndConsume(consume);
    await evictDurableObject(stub);
    expect(await readAlarm(stub)).toBe(startTime + windowMilliseconds);

    vi.setSystemTime(startTime + 10_000);
    const second = await stub.checkAndConsume(consume);
    expect(second).toEqual({
      allowed: true,
      remaining: limit - 2,
      resetAt: isoAt(startTime + windowMilliseconds),
      limit,
    });
    // The alarm follows the newest hit, so an idle address costs one wake.
    expect(await readAlarm(stub)).toBe(startTime + 10_000 + windowMilliseconds);
  });

  it("re-arms for the group's expiry when the alarm runs inside a live window", async () => {
    const stub = counterFor("203.0.113.3");
    await stub.checkAndConsume(consume);
    vi.setSystemTime(startTime + 20_000);
    await stub.checkAndConsume(consume);

    vi.setSystemTime(startTime + 30_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await readAlarm(stub)).toBe(startTime + 20_000 + windowMilliseconds);

    const third = await stub.checkAndConsume(consume);
    expect(third).toEqual({
      allowed: true,
      remaining: limit - 3,
      resetAt: isoAt(startTime + windowMilliseconds),
      limit,
    });
  });

  it("deletes all storage and leaves no alarm once every window has passed", async () => {
    const stub = counterFor("203.0.113.4");
    await stub.checkAndConsume(consume);

    // The alarm's own instant: the hit stops counting exactly one window after it.
    vi.setSystemTime(startTime + windowMilliseconds);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const residue = await runInDurableObject(stub, async (_instance, state) => ({
      entries: (await state.storage.list()).size,
      alarm: await state.storage.getAlarm(),
    }));
    expect(residue).toEqual({ entries: 0, alarm: null });
  });

  it("drops unreadable state when the alarm runs, logging the group and why", async () => {
    const stub = counterFor("203.0.113.5");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put("auth.endpoint", { windowMilliseconds, hits: "unreadable" });
      await state.storage.setAlarm(startTime + windowMilliseconds);
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const residue = await runInDurableObject(stub, async (_instance, state) => ({
      entries: (await state.storage.list()).size,
      alarm: await state.storage.getAlarm(),
    }));
    expect(residue).toEqual({ entries: 0, alarm: null });
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(/stored rate-limit window "auth\.endpoint" does not parse:.*hits/s),
    );
  });
});
