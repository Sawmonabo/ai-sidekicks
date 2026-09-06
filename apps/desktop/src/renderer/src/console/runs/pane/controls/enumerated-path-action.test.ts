// What the host said when it refused the clipboard, and what reaches the screen.
//
// `Spec-023 §Console Design (Meridian)` rule 9 puts the other side's code and its
// sentence on screen unparaphrased and leaves the console the `action` slot alone.
// This action used to `catch` with no parameter — the rejection was discarded and
// replaced by console prose — so a host that answered `session.not_found`, a
// permission denial, or any other registered code reached a person as one invented
// `native.copy_refused`, and the next move it implied was the same for all of them.

import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useEnumeratedPathAction } from "./enumerated-path-action.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import type { ConsoleBridge } from "../../../bridge/index.js";

const A_PATH = "/Users/dev/code/one/.env.local";

/** A bridge whose only reachable member is the clipboard call this action makes. */
function bridgeRejectingWith(rejection: unknown): ConsoleBridge {
  return {
    sidekicks: { native: { copyToClipboard: vi.fn().mockRejectedValue(rejection) } },
  } as unknown as ConsoleBridge;
}

/** Press the action once and let its rejection settle. */
async function copyThrough(
  bridge: ConsoleBridge,
): Promise<{ code: string | undefined; detail: string | undefined }> {
  const mounted = renderHook(() => useEnumeratedPathAction(bridge));
  await act(async () => {
    mounted.result.current.copyPath(A_PATH);
    // A boundary and not a counted microtask: the rejection travels through the
    // normalizer and a `setRefusal`, and a chain one link deeper would leave this
    // reading the state from before the answer landed — silently, since every case
    // below would then be asserting about an absent refusal.
    await crossMacrotaskBoundary();
  });
  const refusal = mounted.result.current.refusal;
  return { code: refusal?.code, detail: refusal?.detail };
}

describe("a host refusal reaches the surface as the host's own words", () => {
  it("keeps the code and the sentence a wire envelope carried", async () => {
    const carried = await copyThrough(
      bridgeRejectingWith({ code: "session.not_found", message: "This session is gone." }),
    );

    expect(carried.code).toBe("session.not_found");
    expect(carried.detail).toBe("This session is gone.");
  });

  it("keeps the dotted code a JSON-RPC envelope carries at `data.type`", async () => {
    const carried = await copyThrough(
      bridgeRejectingWith({
        code: -32603,
        message: "The clipboard is unavailable.",
        data: { type: "runtimenode.permission_denied" },
      }),
    );

    expect(carried.code).toBe("runtimenode.permission_denied");
    expect(carried.detail).toBe("The clipboard is unavailable.");
  });

  it("falls back to this seam's own sentence only where the rejection said nothing", async () => {
    // The negative control for the two above: a fallback that fires here would mean
    // the typed arms never ran, and every host code would render as this one.
    const carried = await copyThrough(bridgeRejectingWith(new Error("boom")));

    expect(carried.code).toBe("call-rejected");
    expect(carried.detail).toContain("native.copyToClipboard was rejected");
    // And the `Error`'s own message is DROPPED rather than rendered beside it, which
    // is the fallback contract `core/wire-rejection.ts` states — the supplied pair
    // replaces the synthesized one whole. Asserted rather than left implied, so the
    // day someone widens that arm to append a thrown message this reads as the
    // deliberate choice it is instead of an oversight.
    expect(carried.detail ?? "").not.toContain("boom");
  });

  it("never quotes the path into the sentence, whichever arm answered", async () => {
    const carried = await copyThrough(bridgeRejectingWith(undefined));

    expect(carried.detail ?? "").not.toContain(A_PATH);
  });
});
