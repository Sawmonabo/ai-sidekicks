// Whether an enclosing vitest budget actually contains the phases it encloses.
//
// Every spawner in this package derives its per-test budget from named phase
// ceilings rather than writing a figure down, because a spawner's own deadline
// has to fire BEFORE vitest's: a worker killed at the generic timeout is torn
// down with every pending timer in it, and the Electron a timer was going to
// kill is reparented to init. The derivation is what makes that relation hold
// when a phase ceiling moves — and it holds only over the phases it NAMES.
//
// THE PHASES THAT WERE MISSING WERE NOT THE HARNESS'S OWN CODE. A managed child
// takes host queries that sit inside NOBODY's deadline: the root's start stamp,
// which `spawnManagedElectronChild` reads after the spawn and BEFORE either probe
// harness arms the timer bounding it, and — where a tree kill consumes a captured
// member set — the owner's live descendant capture and the intersection the
// root's `exit` runs. Each is a blocking `ps` or PowerShell read bounded at
// `HOST_QUERY_TIMEOUT_MS` and each blocks the thread vitest's own timeout runs
// on. On the GC probe's own figures the stamp read alone made the worst legal run
// about forty seconds against a thirty-five second enclosure: vitest wins, and
// the diagnostic path the harness exists to reach is replaced by "test timed out".
//
// So the check is arithmetic and it is asked of the CONSTANTS rather than of a
// run: sum the ceilings each budget must contain, and assert the budget covers
// the sum. A ceiling raised later fails here, on a laptop, in milliseconds —
// rather than on a loaded runner as a flake nobody can reproduce.
//
// AND THE RESERVATION IS ASKED OF BOTH PLATFORMS FROM WHICHEVER ONE IS RUNNING.
// Only the arm that addresses a captured member set takes the two descendant
// listings, so the reserve is platform-conditional — and this suite runs where
// they are never taken, which would leave the arithmetic that matters on Windows
// unasserted anywhere. `spawnedTreeHostQueryCeilingMs` is therefore a function of
// that predicate, and both arms are driven here as arithmetic, which is the one
// kind of claim a test can make about the other platform without being on it.

import { describe, expect, it } from "vitest";

import { TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import {
  BOOT_TEST_TIMEOUT_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  DISPLAY_READY_TIMEOUT_MS,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  FORCED_STALL_TEST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS as BOOT_SPAWN_TIMEOUT_MS,
} from "./electron-probe.js";
import { GC_TEST_TIMEOUT_MS, SPAWN_TIMEOUT_MS as GC_SPAWN_TIMEOUT_MS } from "./gc-probe.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";
import {
  DESCENDANT_LISTINGS_PER_CHILD,
  SPAWNED_TREE_HOST_QUERY_CEILING_MS,
  spawnedTreeHostQueryCeilingMs,
  TERMINATION_CONSUMES_CAPTURED_DESCENDANTS,
} from "./process-tree/budget.js";
import { PROCESS_TREE_TERMINATION_MODE } from "./process-tree/dispatch.js";
import { HOST_QUERY_TIMEOUT_MS } from "./process-tree/readers.js";

/** The phases the GC probe's enclosure must contain, worst case, in order. */
const GC_PHASE_CEILINGS: readonly number[] = [
  SPAWNED_TREE_HOST_QUERY_CEILING_MS,
  GC_SPAWN_TIMEOUT_MS,
  TERMINATION_GRACE_MS,
  TEST_TIMEOUT_SLACK_MS,
];

/** The phases the smoke probe's boot enclosure must contain, worst case, in order. */
const BOOT_PHASE_CEILINGS: readonly number[] = [
  DISPLAY_READY_TIMEOUT_MS,
  SPAWNED_TREE_HOST_QUERY_CEILING_MS,
  BOOT_SPAWN_TIMEOUT_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  TERMINATION_GRACE_MS,
  TEST_TIMEOUT_SLACK_MS,
];

/** The same sequence under the forced-stall override, which shortens only the spawn. */
const FORCED_STALL_PHASE_CEILINGS: readonly number[] = [
  DISPLAY_READY_TIMEOUT_MS,
  SPAWNED_TREE_HOST_QUERY_CEILING_MS,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  TERMINATION_GRACE_MS,
  TEST_TIMEOUT_SLACK_MS,
];

function sumOf(ceilings: readonly number[]): number {
  return ceilings.reduce((total, ceiling) => total + ceiling, 0);
}

describe("probe budgets contain every phase they enclose", () => {
  it("covers the GC probe's phases, every unbudgeted host query included", () => {
    expect(
      GC_TEST_TIMEOUT_MS,
      "the GC enclosure is smaller than the phases it contains — vitest's generic timeout wins before the harness's own deadline fires",
    ).toBeGreaterThanOrEqual(sumOf(GC_PHASE_CEILINGS));
  });

  it("covers the smoke probe's boot and forced-stall phases, host queries included", () => {
    expect(
      BOOT_TEST_TIMEOUT_MS,
      "the boot enclosure is smaller than the phases it contains — the stalled-boot diagnostic is killed before it renders",
    ).toBeGreaterThanOrEqual(sumOf(BOOT_PHASE_CEILINGS));
    expect(
      FORCED_STALL_TEST_TIMEOUT_MS,
      "the forced-stall enclosure is smaller than the phases it contains",
    ).toBeGreaterThanOrEqual(sumOf(FORCED_STALL_PHASE_CEILINGS));
  });

  it("reserves one query per platform reading, and no query for a reading never taken", () => {
    // THE ARITHMETIC, DRIVEN ON BOTH ARMS FROM WHICHEVER ONE IS RUNNING. The
    // root's stamp is read on every platform, so it is charged on every
    // platform; the two descendant listings are charged only where a kill
    // consumes them. A reservation for a reading that cannot happen would
    // inflate every enclosure on this platform, and a missing one would leave
    // the other platform's worst legal run outside its budget.
    expect(spawnedTreeHostQueryCeilingMs(false)).toBe(HOST_QUERY_TIMEOUT_MS);
    expect(spawnedTreeHostQueryCeilingMs(true)).toBe(
      HOST_QUERY_TIMEOUT_MS * (1 + DESCENDANT_LISTINGS_PER_CHILD),
    );
    expect(SPAWNED_TREE_HOST_QUERY_CEILING_MS).toBe(
      spawnedTreeHostQueryCeilingMs(TERMINATION_CONSUMES_CAPTURED_DESCENDANTS),
    );
    // TWO, and they are named rather than counted: the owner's live capture and
    // the intersection the root's `exit` runs. A third reading added without
    // moving this figure is a reading no enclosure has room for.
    expect(DESCENDANT_LISTINGS_PER_CHILD).toBe(2);
  });

  it("charges the descendant listings on exactly the platforms whose arm reads them", () => {
    // ONE PREDICATE, THREE CONSUMERS. Which arm the dispatch takes, whether the
    // identity reads a listing at all, and how much of an enclosure is reserved
    // for those readings all have to agree — and they agree because they are the
    // same constant rather than three sentences that happen to match today.
    expect(TERMINATION_CONSUMES_CAPTURED_DESCENDANTS).toBe(
      PROCESS_TREE_TERMINATION_MODE === "external",
    );
    expect(
      SPAWNED_TREE_HOST_QUERY_CEILING_MS > HOST_QUERY_TIMEOUT_MS,
      "the reserve charges for descendant listings on a platform whose kill never reads one, or omits them on one that does",
    ).toBe(TERMINATION_CONSUMES_CAPTURED_DESCENDANTS);
  });

  it("negative control: dropping the capture term leaves each enclosure short", () => {
    // Without this the three assertions above pass over any budget generous
    // enough by accident, and the term this file exists for could be deleted
    // with every check still green. The superseded derivation is written out and
    // shown to be strictly smaller than the sum it was supposed to cover — which
    // is the arithmetic hole, stated as a number rather than as a worry.
    expect(SPAWNED_TREE_HOST_QUERY_CEILING_MS).toBeGreaterThanOrEqual(HOST_QUERY_TIMEOUT_MS);
    expect(SPAWNED_TREE_HOST_QUERY_CEILING_MS).toBeGreaterThan(0);
    expect(
      GC_TEST_TIMEOUT_MS - SPAWNED_TREE_HOST_QUERY_CEILING_MS,
      "the GC enclosure still covers its phases without the capture term — the term is decoration and the control proves nothing",
    ).toBeLessThan(sumOf(GC_PHASE_CEILINGS));
    expect(BOOT_TEST_TIMEOUT_MS - SPAWNED_TREE_HOST_QUERY_CEILING_MS).toBeLessThan(
      sumOf(BOOT_PHASE_CEILINGS),
    );
    expect(FORCED_STALL_TEST_TIMEOUT_MS - SPAWNED_TREE_HOST_QUERY_CEILING_MS).toBeLessThan(
      sumOf(FORCED_STALL_PHASE_CEILINGS),
    );
  });
});
