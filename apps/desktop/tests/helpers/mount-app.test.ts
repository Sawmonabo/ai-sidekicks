// What address the shared mount opens a window at — the one thing about it a suite
// never states and every suite depends on.
//
// THE HELPER STATES THE ADDRESS AND THIS FILE HOLDS IT TO BOTH READINGS: the default it
// supplies, and the address a case sets for itself and must keep. A helper that
// overwrote the second would be the second writer `hash-route-binding.ts` exists to keep
// off this value.

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSIONS_HASH, mountConsole } from "./mount-app.js";

/** No address at all — what a window carries before any suite has said otherwise. */
const NO_HASH = "";

/** An address that is not the default, so keeping it is visible. */
const WORKFLOWS_HASH = "#/workflows";

describe("the composed window's opening address", () => {
  beforeEach(() => {
    window.location.hash = NO_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = NO_HASH;
  });

  it("gives a mount that names no address the sessions list", async () => {
    await mountConsole();

    expect(window.location.hash).toBe(SESSIONS_HASH);
  });

  it("leaves an address the case set for itself exactly as the case set it", async () => {
    window.location.hash = WORKFLOWS_HASH;

    await mountConsole();

    expect(window.location.hash).toBe(WORKFLOWS_HASH);
  });
});
