// The states an import start reaches, and the one press that is answered rather than sent.
//
// Each case fails without the class: a boolean renders unattempted and settled alike, and a
// form with no single-flight rule sends a second call while the first is out.

import { describe, expect, it } from "vitest";

import type {
  ProviderImportId,
  ProviderImportProviderRequest,
} from "@ai-sidekicks/contracts/provider-import";
import { ProviderImportStart, type StartedImport } from "./useProviderImportStart.js";

const REQUEST: ProviderImportProviderRequest = { provider: "claude" };

/** The answer a start for `request` settles with. */
function startedFor(request: ProviderImportProviderRequest, importId: string): StartedImport {
  return { ...request, importId: importId as ProviderImportId };
}

/** An attempt whose settlement the case releases when it chooses. */
function heldAttempt(): {
  readonly attempt: (request: ProviderImportProviderRequest) => Promise<StartedImport>;
  readonly release: (value: StartedImport) => void;
} {
  let release: ((value: StartedImport) => void) | undefined;
  return {
    attempt: async () =>
      await new Promise<StartedImport>((resolve) => {
        release = resolve;
      }),
    release: (value) => {
      release?.(value);
    },
  };
}

describe("one import start's settlement", () => {
  it("starts unattempted, runs between the press and the settlement, then settles", async () => {
    const held = heldAttempt();
    const start = new ProviderImportStart(held.attempt);
    // Unattempted is not the same as settled with nothing.
    expect(start.settlement()).toStrictEqual({ status: "unattempted" });

    const running = start.run(REQUEST);
    expect(start.settlement()).toStrictEqual({ status: "running" });

    held.release(startedFor(REQUEST, "provider-import-1"));
    await running;
    expect(start.settlement()).toStrictEqual({
      status: "settled",
      answer: startedFor(REQUEST, "provider-import-1"),
    });
  });

  it("answers a second press instead of sending it", async () => {
    const held = heldAttempt();
    let attemptCount = 0;
    const start = new ProviderImportStart(async (request) => {
      attemptCount += 1;
      return await held.attempt(request);
    });

    const running = start.run(REQUEST);
    const refusal = await start.run(REQUEST);

    expect(attemptCount).toBe(1);
    expect(refusal?.code).toBe("import-start-in-flight");
    // The app's own rule, so the app's own subsystem; a daemon namespace would blame a wire
    // nothing was sent on.
    expect(refusal?.origin).toBe("provider-import");

    held.release(startedFor(REQUEST, "provider-import-1"));
    await running;
  });

  it("leaves the first request in flight while it refuses the second", async () => {
    // Guards publishing the duplicate refusal as the settlement: that replaced `running`
    // while the first call was out, so forms re-enabled their control and admitted a press
    // racing the first.
    const held = heldAttempt();
    const start = new ProviderImportStart(held.attempt);
    let notifications = 0;
    start.subscribe(() => {
      notifications += 1;
    });

    const running = start.run(REQUEST);
    expect(start.settlement()).toStrictEqual({ status: "running" });
    await start.run(REQUEST);

    // Not merely unmoved by value: the refusal published nothing, so no subscriber was woken.
    expect(start.settlement()).toStrictEqual({ status: "running" });
    expect(notifications).toBe(1);

    // The first request still settles normally.
    held.release(startedFor(REQUEST, "provider-import-1"));
    await running;
    expect(start.settlement()).toStrictEqual({
      status: "settled",
      answer: startedFor(REQUEST, "provider-import-1"),
    });
  });

  it("would notice a duplicate press that was let through — the control", async () => {
    // Control: with nothing in flight the second press is put and answers no refusal, so the
    // reading above is single-flight and not a class refusing every second call.
    let importCount = 0;
    const start = new ProviderImportStart(async (request) => {
      importCount += 1;
      return await Promise.resolve(startedFor(request, `provider-import-${importCount}`));
    });

    await start.run(REQUEST);
    const refusal = await start.run(REQUEST);

    expect(refusal).toBeUndefined();
    expect(start.settlement()).toStrictEqual({
      status: "settled",
      answer: startedFor(REQUEST, "provider-import-2"),
    });
  });
});
