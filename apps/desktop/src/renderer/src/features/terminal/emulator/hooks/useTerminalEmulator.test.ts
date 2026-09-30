// A fetch that refused has to reach the screen, and the value it refused with is not a string.
// `XtermMountPoint` resolves the page's own loader, so a refusing fetch is only reachable here,
// where every case hands the real hook a real loader whose `load()` refuses. The values are what
// `import()` rejects with: a bundler error naming the fetch, a wire envelope carrying a code, and
// a null-prototype object that throws inside `String()`.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TerminalEmulatorLoader, type TerminalEmulatorModule } from "../emulator-loader.js";
import { useTerminalEmulator } from "./useTerminalEmulator.js";

const REAL_CHUNK_IMPORT_TIMEOUT_MS = 30_000;

/**
 * Counts fetches across every loader a case built. A per-loader counter reads one on both
 * shapes, so only a count that outlives the loaders separates one settled fetch from a fetch
 * per render.
 */
class EmulatorFetchTally {
  #fetchCount = 0;

  public recordFetch(): void {
    this.#fetchCount += 1;
  }

  public get fetchCount(): number {
    return this.#fetchCount;
  }
}

/** A loader whose fetch refuses with exactly what a case hands it; a subclass of the real one. */
class RefusingEmulatorLoader extends TerminalEmulatorLoader {
  readonly #rejection: unknown;
  readonly #fetchTally: EmulatorFetchTally;

  public constructor(rejection: unknown, fetchTally: EmulatorFetchTally) {
    super();
    this.#rejection = rejection;
    this.#fetchTally = fetchTally;
  }

  public override load(): Promise<TerminalEmulatorModule> {
    this.#fetchTally.recordFetch();
    return Promise.reject(this.#rejection);
  }
}

/**
 * The refusal a settled hook holds, from one loader that outlives every render. A loader minted
 * inside the render callback gets a new identity per render, which re-runs the effect and
 * re-rejects into a state update React cannot bail out of: a loop with no terminator. The
 * negative control below fails if this moves back inside.
 */
async function refusalFor(
  rejection: unknown,
): Promise<{ code: string; detail: string; fetchCount: number }> {
  const fetchTally = new EmulatorFetchTally();
  const loader = new RefusingEmulatorLoader(rejection, fetchTally);
  const { result } = renderHook(() => useTerminalEmulator(loader));
  await waitFor(() => {
    expect(result.current.status).toBe("failed");
  });
  const emulator = result.current;
  if (emulator.status !== "failed") {
    throw new Error("the emulator reading never reached its refused arm");
  }
  return {
    code: emulator.refusal.code,
    detail: emulator.refusal.detail,
    fetchCount: fetchTally.fetchCount,
  };
}

describe("the emulator reading, when the chunk refuses", () => {
  it("answers a refusal for a value that throws on the way to a string", async () => {
    // `String(Object.create(null))` throws; it must not throw inside the rejection handler, or
    // the pane stays on its loading skeleton with no refusal.
    const refusal = await refusalFor(Object.create(null));
    expect(refusal.code).toBe("terminal-emulator-call-failed");
    expect(refusal.detail.length).toBeGreaterThan(0);
  });

  it("renders no serialization of a rejection that wrote no sentence", async () => {
    // The other half of the rule: an ordinary object must not render as `[object Object]`.
    const refusal = await refusalFor({ reason: "the chunk did not arrive" });
    expect(refusal.detail).not.toContain("[object Object]");
    expect(refusal.detail).not.toContain("the chunk did not arrive");
  });

  it("keeps a loader's own message, which is the sentence naming which fetch died", async () => {
    const refusal = await refusalFor(new Error("Failed to fetch dynamically imported module"));
    expect(refusal.detail).toBe("Failed to fetch dynamically imported module");
  });

  it("keeps a code the rejection carried, rather than replacing it with this seam's", async () => {
    // A refusal that crossed the preload boundary as a plain envelope: the console renders the
    // producer's code, the half a person acts on.
    const refusal = await refusalFor({ code: "renderer.chunk_denied", message: "Blocked." });
    expect(refusal.code).toBe("renderer.chunk_denied");
    expect(refusal.detail).toBe("Blocked.");
  });

  it("asks the chunk for once, rather than a fetch per render for the life of the case", async () => {
    // The negative control for `refusalFor`'s shape, driven through the helper. The count is the
    // assertion: a loader minted inside the render callback reaches the same `failed` reading,
    // so only the number of fetches differs.
    const refusal = await refusalFor(new Error("Failed to fetch dynamically imported module"));
    expect(refusal.code).toBe("terminal-emulator-call-failed");
    expect(refusal.fetchCount).toBe(1);
  });

  // The real chunk import runs inside this case's budget, and with every package's
  // suite running at once it has taken longer than the default five seconds.
  it(
    "negative control: a fetch that resolves reports the module and refuses nothing",
    {
      timeout: REAL_CHUNK_IMPORT_TIMEOUT_MS,
    },
    async () => {
      // Without it every case above would pass against a hook that answered `failed`
      // unconditionally. The chunk is fetched before the assertion window, so a loaded machine
      // cannot decide the verdict: `load()` memoizes and the wait is a microtask and a commit.
      const loader = new TerminalEmulatorLoader();
      await loader.load();
      const { result } = renderHook(() => useTerminalEmulator(loader));
      await waitFor(() => {
        expect(result.current.status).toBe("loaded");
      });
    },
  );
});
