// The one registration that can refuse AFTER a real Electron is already up.
//
// `withLaunchedConsole` binds its close to the end of the current test, and that
// binding is what covers the outcome nothing else does: vitest's own per-test
// timeout never runs the body's settlement, so without it a tier that overran its
// budget left a browser and a private profile directory behind. The registration
// is therefore not optional — and it is also not total. `onTestFinished` throws
// outside a running test, which is exactly what a launch from a `beforeAll`
// reaches, and it throws AFTER the launch has spawned Electron.
//
// The shape that leak wore: the refusal propagated out of the launcher, the
// caller never received the handle, and the close that would have taken the
// process and its directory off the machine was reached from nowhere. The
// misuse is the right failure and it is not the whole response, which is the same
// judgment `spawnManagedElectronChild` already makes one layer down — so these
// cases are that judgment applied to the launched console.
//
// AND WHAT THAT REGISTERED CLOSE'S OWN FAILURE DOES TO THE RUN is the second
// subject here, because it is the same registration. The shared settle-time door
// swallows a disposal failure by default — the test has already settled and its
// outcome is what explains the run — and this is the one caller that asks it not
// to. On a vitest timeout nothing else closes the launch, the close is idempotent
// so nobody can ask again, and its bounded retries against the tree are already
// spent: a verdict of `unterminable` reaching here means a browser nothing could
// kill is still running, which a green tier must not report over.
//
// NO ELECTRON IS LAUNCHED HERE. `registerSettleTimeClose` takes the close alone,
// for `cleanup-disposition.ts`'s reason: a close that itself fails is one object
// literal and is unproducible with a real browser, and the refusal is a registrar
// this suite injects rather than a hook it can provoke from inside a test.

import { describe, expect, it } from "vitest";

import { type CleanupOutcome } from "../bounded-cleanup.js";
import { CleanupFailedError } from "../cleanup-disposition.js";
import { registerSettleTimeClose } from "../electron-harness.js";
import {
  RecordingSettleRegistrar,
  REGISTRAR_REFUSAL_MESSAGE,
  RefusingSettleRegistrar,
} from "./electron-child-lifetime.test-support.js";

/**
 * The verdict a close that may have left something running rejects with.
 *
 * `unterminable` rather than any other settlement because it is the one a later
 * launch can feel, so a reader losing it to the refusal above would lose the
 * actionable half of the run.
 */
const UNTERMINABLE_OUTCOME: CleanupOutcome = {
  settlement: "unterminable",
  waitedMs: 10_000,
  budgetMs: 10_000,
  processId: 4242,
};

/**
 * A launched console that counts its closes and can fail the FIRST one.
 *
 * Counting is the claim, not a convenience: "the handle was closed" and "the
 * handle was closed exactly once" are different properties, and only the second
 * one says the recovery did not run beside a registration that had already taken.
 *
 * The failure is one-shot because the real close is: `withLaunchedConsole`'s
 * `close` sets its `closed` guard BEFORE the cleanup runs and returns on it
 * afterwards, so a second call resolves without repeating the verdict — which is
 * exactly why the retry against a tree that refused the kill had to move inside
 * `BoundedCleanup` rather than be asked of a later close. A stand-in that threw
 * every time would model a handle this package does not have.
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
    // THE MISUSE WITH AN ELECTRON IN IT: a launch from `beforeAll`, where the
    // registrar throws and the process is already running. Without the recovery
    // the refusal reaches the caller alone and the browser and its profile are
    // left with no close path anywhere.
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
    // THE FINDING. This registration is the ONLY close on a vitest timeout — the
    // body's settlement never runs — and its rejection used to be swallowed by
    // the shared settle-time door, whose default is to keep the test's own
    // outcome the one a reader sees. Here there is no other outcome to protect:
    // `BoundedCleanup` has already spent its bounded retries by the time it
    // raises, so the verdict means an Electron nothing could kill is still
    // running and every launch after it inherits the machine it is holding.
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
    // Without this the case above is ambiguous between "the disposition surfaces
    // a failure" and "the registration now rejects whatever happens", and the
    // second would turn every passing launching tier red at teardown.
    const registrar = new RecordingSettleRegistrar();
    const launch = new RecordingLaunch();

    await registerSettleTimeClose(launch, registrar.register);

    await expect(registrar.settle()).resolves.toBeUndefined();
    expect(launch.closeCount).toBe(1);
  });

  it("keeps the refusal as the failure that explains the run when the close fails too", async () => {
    // The disposition is `closeAfterBody`'s and is applied rather than restated:
    // cleanup adds what a reader could not otherwise know and never replaces the
    // failure they came for. Both co-occur by construction here — a misuse that
    // leaves a browser running is exactly the state a close then loses.
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
