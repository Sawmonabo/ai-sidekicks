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
 * A loader whose fetch refuses with exactly what a case hands it.
 *
 * A subclass rather than an object literal, because the hook takes the loader the
 * page uses and a stand-in that merely looked like one would let this file assert
 * against a shape the component never receives. Only `load` is replaced; the memo
 * the base class holds is untouched and unreached.
 */
class RefusingEmulatorLoader extends TerminalEmulatorLoader {
  readonly #rejection: unknown;

  public constructor(rejection: unknown) {
    super();
    this.#rejection = rejection;
  }

  public override load(): Promise<TerminalEmulatorModule> {
    return Promise.reject(this.#rejection);
  }
}

async function refusalFor(rejection: unknown): Promise<{ code: string; detail: string }> {
  const { result } = renderHook(() => useTerminalEmulator(new RefusingEmulatorLoader(rejection)));
  await waitFor(() => {
    expect(result.current.status).toBe("failed");
  });
  const emulator = result.current;
  if (emulator.status !== "failed") {
    throw new Error("the emulator reading never reached its refused arm");
  }
  return { code: emulator.refusal.code, detail: emulator.refusal.detail };
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

  it("negative control: a fetch that resolves reports the module and refuses nothing", async () => {
    // Without it every case above would pass against a hook that answered `failed`
    // unconditionally, which is a pane that never shows a terminal.
    const { result } = renderHook(() => useTerminalEmulator(new TerminalEmulatorLoader()));
    await waitFor(() => {
      expect(result.current.status).toBe("loaded");
    });
  });
});
