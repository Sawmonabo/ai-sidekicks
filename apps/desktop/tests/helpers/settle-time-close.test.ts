// The registration that can refuse after a real Electron is already up.
//
// `withLaunchedApp` binds its close to the end of the test, which covers a vitest timeout (that
// never runs the body's settlement). `onTestFinished` throws outside a running test, as in a
// launch from `beforeAll`, and it throws after Electron has spawned. The refusal alone would
// leave a browser and a private profile directory behind, so the launch is closed as well; this
// is the judgment `spawnManagedElectronChild` makes one layer down.
//
// The registered close's own failure also matters. `disposeWhenTestFinishes` swallows a disposal
// failure by default so the test's outcome stays the one that explains the run, and this is the
// one caller that asks it not to. On a timeout nothing else closes the launch, the close is
// idempotent, and its bounded retries are spent, so an `unterminable` verdict means a browser
// nothing could kill is still running, which a green tier must not report over.
//
// No Electron is launched: `registerSettleTimeClose` takes the close alone, since a failing close
// is one object literal and the refusal is a registrar this suite injects.

import { describe, expect, it } from "vitest";

import { type CleanupOutcome } from "./cleanup-contract.js";
import { CleanupFailedError } from "./cleanup-disposition.js";
import { registerSettleTimeClose } from "./electron-harness.js";
import {
  RecordingSettleRegistrar,
  RefusingSettleRegistrar,
  REGISTRAR_REFUSAL_MESSAGE,
} from "./electron-child-doubles.test-support.js";

/**
 * The verdict a close that may have left something running rejects with.
 *
 * `unterminable` because it is the settlement a later launch can feel, so losing it to the
 * refusal would lose the actionable half of the run.
 */
const UNTERMINABLE_OUTCOME: CleanupOutcome = {
  settlement: "unterminable",
  waitedMs: 10_000,
  budgetMs: 10_000,
  processId: 4242,
};

/**
 * A launched console that counts its closes and can fail the first one.
 *
 * Counting matters because "closed" and "closed exactly once" differ, and only the second shows
 * the recovery did not run beside a registration that had already taken. The failure is one-shot
 * like the real close: `withLaunchedApp`'s `close` sets its `closed` guard before cleanup and
 * returns on it afterwards, so a stand-in that threw every time would model a handle this package
 * does not have.
 */
class RecordingLaunch {
  #closeCount = 0;
  readonly #firstCloseFailure: unknown;

  constructor(firstCloseFailure?: unknown) {
    this.#firstCloseFailure = firstCloseFailure;
  }

  get closeCount(): number {
    return this.#closeCount;
  }

  readonly close = async (): Promise<void> => {
    this.#closeCount += 1;
    if (this.#closeCount === 1 && this.#firstCloseFailure !== undefined) {
      throw this.#firstCloseFailure;
    }
    await Promise.resolve();
  };
}

describe("a launch binds its close to the end of the test, or closes now", () => {
  it("registers the close and runs it only once the test settles", async () => {
    const registrar = new RecordingSettleRegistrar();
    const launch = new RecordingLaunch();

    await registerSettleTimeClose(launch, registrar.register);

    expect(registrar.registeredCount).toBe(1);
    expect(
      launch.closeCount,
      "the launch was closed while the test that asked for it was still running",
    ).toBe(0);
    await registrar.settle();
    expect(launch.closeCount).toBe(1);
  });

  it("closes the launch exactly once when the registration refuses", async () => {
    // A launch from `beforeAll`: the registrar throws with the process already running, and
    // without the recovery the browser and its profile have no close path.
    const refusing = new RefusingSettleRegistrar();
    const launch = new RecordingLaunch();

    await expect(registerSettleTimeClose(launch, refusing.register)).rejects.toThrow(
      REGISTRAR_REFUSAL_MESSAGE,
    );

    expect(refusing.registrationAttempts).toBe(1);
    expect(
      launch.closeCount,
      "the refusal was rethrown without closing — a real Electron and its private profile " +
        "directory are still on the machine and no handle can reach either",
    ).toBe(1);
  });

  it("fails the test when the settled close could not terminate the tree", async () => {
    // On a vitest timeout this registration is the only close, and `BoundedCleanup` has spent its
    // retries by the time it raises, so the verdict means a browser is still running and must not
    // be swallowed.
    const registrar = new RecordingSettleRegistrar();
    const launch = new RecordingLaunch(new CleanupFailedError(UNTERMINABLE_OUTCOME));

    await registerSettleTimeClose(launch, registrar.register);

    await expect(
      registrar.settle(),
      "the settle-time close swallowed its verdict — a run that leaked a browser reports clean",
    ).rejects.toThrow(`unterminable for pid ${String(UNTERMINABLE_OUTCOME.processId)}`);
    expect(launch.closeCount).toBe(1);
  });

  it("negative control: a close that settles cleanly fails nothing", async () => {
    // Without this the case above cannot tell "the disposition surfaces a failure" from "the
    // registration rejects whatever happens", which would turn every passing tier red at teardown.
    const registrar = new RecordingSettleRegistrar();
    const launch = new RecordingLaunch();

    await registerSettleTimeClose(launch, registrar.register);

    await expect(registrar.settle()).resolves.toBeUndefined();
    expect(launch.closeCount).toBe(1);
  });

  it("keeps the refusal as the failure that explains the run when the close fails too", async () => {
    // `closeAfterBody`'s disposition: cleanup adds what a reader could not otherwise know and never
    // replaces the failure they came for.
    const refusing = new RefusingSettleRegistrar();
    const launch = new RecordingLaunch(new CleanupFailedError(UNTERMINABLE_OUTCOME));

    const raised: unknown = await registerSettleTimeClose(launch, refusing.register).catch(
      (error: unknown) => error,
    );

    expect(launch.closeCount).toBe(1);
    expect(raised).toBeInstanceOf(Error);
    const folded = raised as Error;
    expect(
      folded.message,
      "the cleanup verdict was dropped, so nothing says a process may still be running",
    ).toContain("could not be terminated either");
    expect(folded.cause).toBeInstanceOf(Error);
    expect(
      (folded.cause as Error).message,
      "the cleanup failure replaced the refusal that caused it",
    ).toBe(REGISTRAR_REFUSAL_MESSAGE);
  });
});
