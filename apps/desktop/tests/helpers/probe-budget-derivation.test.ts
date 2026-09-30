// Whether an enclosing vitest budget contains the phases it encloses.
//
// Every spawner here derives its per-test budget from named phase ceilings, because a spawner's
// own deadline must fire before vitest's: a worker killed at the generic timeout is torn down
// with its pending timers, and the Electron a timer was going to kill is reparented to init. The
// derivation holds only over the phases it names.
//
// Some phases sit inside nobody's deadline. A managed child takes host queries: the root's start
// stamp, read after the spawn and before either probe harness arms its timer, and, where a tree
// kill consumes a captured member set, the owner's live descendant capture and the intersection
// the root's `exit` runs. Each is a blocking `ps` or PowerShell read bounded at
// `HOST_QUERY_TIMEOUT_MS` that blocks the thread vitest's timeout runs on. On the GC probe's
// figures the stamp read alone made the worst legal run about forty seconds against a
// thirty-five second enclosure, so vitest won and "test timed out" replaced the diagnostic.
//
// The check is arithmetic on the constants, not a run: sum the ceilings each budget must contain
// and assert the budget covers the sum, so a raised ceiling fails here in milliseconds. Only the
// arm that addresses a captured member set takes the two descendant listings, so the reserve is
// platform-conditional and `spawnedTreeHostQueryCeilingMs` is a function of that predicate. Both
// arms are driven here as arithmetic, the one kind of claim a test can make about the other
// platform.

import { describe, expect, it } from "vitest";

import { TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import {
  BOOT_TEST_TIMEOUT_MS,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  FORCED_STALL_TEST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS as BOOT_SPAWN_TIMEOUT_MS,
} from "./smoke-probe-harness.js";
import { DIAGNOSTIC_COLLECTION_CEILING_MS } from "./smoke-probe-diagnosis.js";
import { DISPLAY_READY_TIMEOUT_MS } from "./display-readiness.js";
import { GC_TEST_TIMEOUT_MS, SPAWN_TIMEOUT_MS as GC_SPAWN_TIMEOUT_MS } from "./gc-probe-harness.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";
import {
  DESCENDANT_LISTINGS_PER_CHILD,
  SPAWNED_TREE_HOST_QUERY_CEILING_MS,
  spawnedTreeHostQueryCeilingMs,
  TERMINATION_CONSUMES_CAPTURED_DESCENDANTS,
} from "./process-tree/budget.js";
import { PROCESS_TREE_TERMINATION_MODE } from "./process-tree/termination.js";
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
    // The root's stamp is read and charged on every platform; the two descendant listings are
    // charged only where a kill consumes them. A reservation for a reading that cannot happen
    // inflates every enclosure, and a missing one leaves the other platform's worst run outside
    // its budget.
    expect(spawnedTreeHostQueryCeilingMs(false)).toBe(HOST_QUERY_TIMEOUT_MS);
    expect(spawnedTreeHostQueryCeilingMs(true)).toBe(
      HOST_QUERY_TIMEOUT_MS * (1 + DESCENDANT_LISTINGS_PER_CHILD),
    );
    expect(SPAWNED_TREE_HOST_QUERY_CEILING_MS).toBe(
      spawnedTreeHostQueryCeilingMs(TERMINATION_CONSUMES_CAPTURED_DESCENDANTS),
    );
    // Two, named: the owner's live capture and the intersection the root's `exit` runs. A third
    // reading added without moving this figure has no room in any enclosure.
    expect(DESCENDANT_LISTINGS_PER_CHILD).toBe(2);
  });

  it("charges the descendant listings on exactly the platforms whose arm reads them", () => {
    // One predicate, three consumers: which arm the dispatch takes, whether the identity reads a
    // listing, and how much of an enclosure is reserved must agree, and they do because they are
    // the same constant.
    expect(TERMINATION_CONSUMES_CAPTURED_DESCENDANTS).toBe(
      PROCESS_TREE_TERMINATION_MODE === "external",
    );
    expect(
      SPAWNED_TREE_HOST_QUERY_CEILING_MS > HOST_QUERY_TIMEOUT_MS,
      "the reserve charges for descendant listings on a platform whose kill never reads one, or omits them on one that does",
    ).toBe(TERMINATION_CONSUMES_CAPTURED_DESCENDANTS);
  });

  it("negative control: dropping the capture term leaves each enclosure short", () => {
    // Guards the assertions above from passing over any budget generous by accident: the
    // derivation without the capture term is shown strictly smaller than the sum it had to cover.
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
