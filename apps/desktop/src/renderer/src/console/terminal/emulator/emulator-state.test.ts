// A fetch that refused has to reach the screen, and the value it refused with is
// not a string.
//
// The arm this file exists for is the one the mount point cannot drive: `XtermHost`
// resolves the page's own loader, so a REFUSING fetch is only reachable where the
// loader is a parameter. Every case below hands the real hook a real loader whose
// `load()` refuses, and asserts what a person would be shown.
//
// The values are the ones `import()` actually rejects with. A bundler's own error
// carries the sentence naming which fetch died; a wire envelope crossing the preload
// boundary carries a code; a null-prototype object carries neither and throws inside
// `String()`, which is how the pre-fix arm left a pane on its loading skeleton with
// no refusal anywhere for the life of the mount.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TerminalEmulatorLoader, type TerminalEmulatorModule } from "./emulator-loader.js";
import { useTerminalEmulator } from "./emulator-state.js";

/**
 * How many fetches one case asked for, counted across every loader it built.
 *
 * The tally is what makes the re-fetch defect observable: a per-loader counter reads
 * one on both shapes, because a loader minted afresh on every render is asked once
 * each. Only a count that OUTLIVES the loaders can separate "one fetch, settled"
 * from "a fetch per render, forever", so this object is the case's and the loaders
 * report into it.
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

/**
 * A loader whose fetch refuses with exactly what a case hands it.
 *
 * A subclass rather than an object literal, because the hook takes the loader the
 * page uses and a stand-in that merely looked like one would let this file assert
 * against a shape the component never receives. Only `load` is replaced; the memo
 * the base class holds is untouched and unreached.
 */
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
 * The refusal a settled hook holds, from one loader that outlives every render.
 *
 * THE LOADER IS BUILT OUTSIDE THE RENDER CALLBACK, and that is the whole shape of
 * this helper rather than a style preference. `renderHook` re-invokes its callback
 * on every render of the test component, and the hook's effect lists the loader as
 * its only dependency — so a loader minted inside the callback gives every render a
 * new identity, re-runs the effect, re-rejects, and calls `setEmulator` with a
 * freshly built object React can never bail out of. That is a render → effect →
 * rejection → state → render cycle with no terminator, and React's nested-update
 * guard does not stop it because the update is raised from a promise callback rather
 * than during commit. One loader per case is what makes the settlement settle, and
 * the negative control below is what fails if this ever moves back inside.
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
    // `String(Object.create(null))` throws, and it used to throw INSIDE the
    // rejection handler — so nothing was recorded, the pane stayed on "Loading the
    // terminal emulator", and the one failure a person could act on was the one
    // failure nothing reported.
    const refusal = await refusalFor(Object.create(null));
    expect(refusal.code).toBe("terminal-emulator-call-failed");
    expect(refusal.detail.length).toBeGreaterThan(0);
  });

  it("renders no serialization of a rejection that wrote no sentence", async () => {
    // The other half of the same rule: an ordinary object came out as
    // `[object Object]`, which is the exact string `core/wire-rejection.ts` names as
    // the reason the console has a total stringifier at all.
    const refusal = await refusalFor({ reason: "the chunk did not arrive" });
    expect(refusal.detail).not.toContain("[object Object]");
    expect(refusal.detail).not.toContain("the chunk did not arrive");
  });

  it("keeps a loader's own message, which is the sentence naming which fetch died", async () => {
    const refusal = await refusalFor(new Error("Failed to fetch dynamically imported module"));
    expect(refusal.detail).toBe("Failed to fetch dynamically imported module");
  });

  it("keeps a code the rejection carried, rather than replacing it with this seam's", async () => {
    // A refusal that crossed the preload boundary as a plain envelope. Rule 9: the
    // console renders the producer's code, because a code is the half a person acts
    // on and a synthesized one names only where it was caught.
    const refusal = await refusalFor({ code: "renderer.chunk_denied", message: "Blocked." });
    expect(refusal.code).toBe("renderer.chunk_denied");
    expect(refusal.detail).toBe("Blocked.");
  });

  it("asks the chunk for once, rather than a fetch per render for the life of the case", async () => {
    // The negative control for `refusalFor`'s own shape, driven THROUGH the helper
    // rather than beside it — a case that rebuilt the render call here would pass
    // whatever the helper did.
    //
    // The count is the assertion because it is the property that separates the two
    // shapes. A loader minted inside the render callback is a new dependency on
    // every render, so the effect re-runs, refuses again, writes a fresh state
    // object, and renders again; the reading a case reads is `failed` on both
    // shapes and carries the same code and the same sentence on both, so nothing
    // about the value discriminates. What differs is how many times the fetch was
    // asked for on the way there.
    const refusal = await refusalFor(new Error("Failed to fetch dynamically imported module"));
    expect(refusal.code).toBe("terminal-emulator-call-failed");
    expect(refusal.fetchCount).toBe(1);
  });

  it("negative control: a fetch that resolves reports the module and refuses nothing", async () => {
    // Without it every case above would pass against a hook that answered `failed`
    // unconditionally, which is a pane that never shows a terminal.
    //
    // The real loader, and the chunk is fetched BEFORE the assertion window rather
    // than inside it. `load()` memoises, so the hook's own call gets the settled
    // promise and the wait below is a microtask and a commit — where waiting on the
    // fetch itself let a loaded machine decide the verdict, which is a control that
    // reports the runner's contention as a defect in the hook.
    const loader = new TerminalEmulatorLoader();
    await loader.load();
    const { result } = renderHook(() => useTerminalEmulator(loader));
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
  });
});
