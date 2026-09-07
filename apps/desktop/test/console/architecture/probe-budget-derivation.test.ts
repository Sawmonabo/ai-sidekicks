// Whether an enclosing vitest budget actually contains the phases it encloses.
//
// Every spawner in this package derives its per-test budget from named phase
// ceilings rather than writing a figure down, because a spawner's own deadline
// has to fire BEFORE vitest's: a worker killed at the generic timeout is torn
// down with every pending timer in it, and the Electron a timer was going to
// kill is reparented to init. The derivation is what makes that relation hold
// when a phase ceiling moves — and it holds only over the phases it NAMES.
//
// THE PHASE THAT WAS MISSING WAS NOT THE HARNESS'S OWN CODE. `captureTreeIdentity`
// is a blocking `ps` or PowerShell read that `spawnManagedElectronChild` performs
// after the spawn and BEFORE either probe harness arms the timer bounding its
// spawn, so on a degraded host it spends `HOST_QUERY_TIMEOUT_MS` that neither the
// spawn budget nor the display gate contains. On the GC probe's own figures that
// made the worst legal run about forty seconds against a thirty-five second
// enclosure: vitest wins, and the diagnostic path the harness exists to reach is
// replaced by "test timed out".
//
// So the check is arithmetic and it is asked of the CONSTANTS rather than of a
// run: sum the ceilings each budget must contain, and assert the budget covers
// the sum. A ceiling raised later fails here, on a laptop, in milliseconds —
// rather than on a loaded runner as a flake nobody can reproduce.

import { describe, expect, it } from "vitest";

import {
  IDENTITY_CAPTURE_CEILING_MS,
  TEST_TIMEOUT_SLACK_MS,
} from "../../helpers/electron-child.js";
import {
  BOOT_TEST_TIMEOUT_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  DISPLAY_READY_TIMEOUT_MS,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  FORCED_STALL_TEST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS as BOOT_SPAWN_TIMEOUT_MS,
} from "../../helpers/electron-probe.js";
import {
  GC_TEST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS as GC_SPAWN_TIMEOUT_MS,
} from "../../helpers/gc-probe.js";
import { TERMINATION_GRACE_MS } from "../../helpers/managed-electron-child.js";
import { HOST_QUERY_TIMEOUT_MS } from "../../helpers/process-tree/readers.js";

/** The phases the GC probe's enclosure must contain, worst case, in order. */
const GC_PHASE_CEILINGS: readonly number[] = [
  IDENTITY_CAPTURE_CEILING_MS,
  GC_SPAWN_TIMEOUT_MS,
  TERMINATION_GRACE_MS,
  TEST_TIMEOUT_SLACK_MS,
];

/** The phases the smoke probe's boot enclosure must contain, worst case, in order. */
const BOOT_PHASE_CEILINGS: readonly number[] = [
  DISPLAY_READY_TIMEOUT_MS,
  IDENTITY_CAPTURE_CEILING_MS,
  BOOT_SPAWN_TIMEOUT_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  TERMINATION_GRACE_MS,
  TEST_TIMEOUT_SLACK_MS,
];

/** The same sequence under the forced-stall override, which shortens only the spawn. */
const FORCED_STALL_PHASE_CEILINGS: readonly number[] = [
  DISPLAY_READY_TIMEOUT_MS,
  IDENTITY_CAPTURE_CEILING_MS,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  TERMINATION_GRACE_MS,
  TEST_TIMEOUT_SLACK_MS,
];

function sumOf(ceilings: readonly number[]): number {
  return ceilings.reduce((total, ceiling) => total + ceiling, 0);
}

describe("probe budgets contain every phase they enclose", () => {
  it("covers the GC probe's phases, identity capture included", () => {
    expect(
      GC_TEST_TIMEOUT_MS,
      "the GC enclosure is smaller than the phases it contains — vitest's generic timeout wins before the harness's own deadline fires",
    ).toBeGreaterThanOrEqual(sumOf(GC_PHASE_CEILINGS));
  });

  it("covers the smoke probe's boot and forced-stall phases, identity capture included", () => {
    expect(
      BOOT_TEST_TIMEOUT_MS,
      "the boot enclosure is smaller than the phases it contains — the stalled-boot diagnostic is killed before it renders",
    ).toBeGreaterThanOrEqual(sumOf(BOOT_PHASE_CEILINGS));
    expect(
      FORCED_STALL_TEST_TIMEOUT_MS,
      "the forced-stall enclosure is smaller than the phases it contains",
    ).toBeGreaterThanOrEqual(sumOf(FORCED_STALL_PHASE_CEILINGS));
  });

  it("negative control: dropping the capture term leaves each enclosure short", () => {
    // Without this the three assertions above pass over any budget generous
    // enough by accident, and the term this file exists for could be deleted
    // with every check still green. The superseded derivation is written out and
    // shown to be strictly smaller than the sum it was supposed to cover — which
    // is the arithmetic hole, stated as a number rather than as a worry.
    expect(IDENTITY_CAPTURE_CEILING_MS).toBe(HOST_QUERY_TIMEOUT_MS);
    expect(IDENTITY_CAPTURE_CEILING_MS).toBeGreaterThan(0);
    expect(
      GC_TEST_TIMEOUT_MS - IDENTITY_CAPTURE_CEILING_MS,
      "the GC enclosure still covers its phases without the capture term — the term is decoration and the control proves nothing",
    ).toBeLessThan(sumOf(GC_PHASE_CEILINGS));
    expect(BOOT_TEST_TIMEOUT_MS - IDENTITY_CAPTURE_CEILING_MS).toBeLessThan(
      sumOf(BOOT_PHASE_CEILINGS),
    );
    expect(FORCED_STALL_TEST_TIMEOUT_MS - IDENTITY_CAPTURE_CEILING_MS).toBeLessThan(
      sumOf(FORCED_STALL_PHASE_CEILINGS),
    );
  });
});
