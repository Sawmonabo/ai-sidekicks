// The states an import call reaches, and the one press that is answered rather than sent.
//
// Each case fails without the class: a boolean renders unattempted and settled alike, and a
// control with no single-flight rule sends a second call while the first is out.

import { describe, expect, it } from "vitest";

import type {
  ProviderImportId,
  ProviderImportProviderRequest,
  ProviderImportStartResponse,
} from "@ai-sidekicks/contracts/provider/import";
import { ProviderImportCall } from "./useProviderImportCall.js";

const REQUEST: ProviderImportProviderRequest = { provider: "claude" };

/** The code a rejected start with none of its own is reported under. */
const FAILED_CODE = "import-start-failed";

/** The answer a start settles with. */
function startedFor(importId: string): ProviderImportStartResponse {
  return { importId: importId as ProviderImportId };
}

/** A start call over `attempt`. */
function startCallOver(
  attempt: (request: ProviderImportProviderRequest) => Promise<ProviderImportStartResponse>,
): ProviderImportCall<ProviderImportProviderRequest, ProviderImportStartResponse> {
  return new ProviderImportCall(attempt, FAILED_CODE);
}

/** An attempt whose settlement the case releases when it chooses. */
function heldAttempt(): {
  readonly attempt: (
    request: ProviderImportProviderRequest,
  ) => Promise<ProviderImportStartResponse>;
  readonly release: (value: ProviderImportStartResponse) => void;
} {
  let release: ((value: ProviderImportStartResponse) => void) | undefined;
  return {
    attempt: async () =>
      await new Promise<ProviderImportStartResponse>((resolve) => {
        release = resolve;
      }),
    release: (value) => {
      release?.(value);
    },
  };
}

describe("one import call's settlement", () => {
  it("starts unattempted, runs between the press and the settlement, then settles", async () => {
    const held = heldAttempt();
    const start = startCallOver(held.attempt);
    // Unattempted is not the same as settled with nothing.
    expect(start.settlement()).toStrictEqual({ status: "unattempted" });

    const running = start.run(REQUEST);
    expect(start.settlement()).toStrictEqual({ status: "running", pressOrdinal: 1 });

    held.release(startedFor("provider-import-1"));
    await running;
    expect(start.settlement()).toStrictEqual({
      status: "settled",
      answer: startedFor("provider-import-1"),
      pressOrdinal: 1,
    });
  });

  it("answers a second press instead of sending it", async () => {
    const held = heldAttempt();
    let attemptCount = 0;
    const start = startCallOver(async (request) => {
      attemptCount += 1;
      return await held.attempt(request);
    });

    const running = start.run(REQUEST);
    const refusal = await start.run(REQUEST);

    expect(attemptCount).toBe(1);
    expect(refusal?.code).toBe("import-call-in-flight");
    // The app's own rule, so the app's own subsystem; a daemon namespace would blame a wire
    // nothing was sent on.
    expect(refusal?.origin).toBe("provider-import");

    held.release(startedFor("provider-import-1"));
    await running;
  });

  it("leaves the first request in flight while it refuses the second", async () => {
    // Guards publishing the duplicate refusal as the settlement: that replaced `running`
    // while the first call was out, so forms re-enabled their control and admitted a press
    // racing the first.
    const held = heldAttempt();
    const start = startCallOver(held.attempt);
    let notifications = 0;
    start.subscribe(() => {
      notifications += 1;
    });

    const running = start.run(REQUEST);
    expect(start.settlement()).toStrictEqual({ status: "running", pressOrdinal: 1 });
    await start.run(REQUEST);

    // Not merely unmoved by value: the refusal published nothing, so no subscriber was woken.
    expect(start.settlement()).toStrictEqual({ status: "running", pressOrdinal: 1 });
    expect(notifications).toBe(1);

    // The first request still settles normally.
    held.release(startedFor("provider-import-1"));
    await running;
    expect(start.settlement()).toStrictEqual({
      status: "settled",
      answer: startedFor("provider-import-1"),
      pressOrdinal: 1,
    });
  });

  it("would notice a duplicate press that was let through — the control", async () => {
    // Control: with nothing in flight the second press is put and answers no refusal, so the
    // reading above is single-flight and not a class refusing every second call.
    let importCount = 0;
    const start = startCallOver(async () => {
      importCount += 1;
      return await Promise.resolve(startedFor(`provider-import-${importCount}`));
    });

    await start.run(REQUEST);
    const refusal = await start.run(REQUEST);

    expect(refusal).toBeUndefined();
    expect(start.settlement()).toStrictEqual({
      status: "settled",
      answer: startedFor("provider-import-2"),
      pressOrdinal: 2,
    });
  });
});
