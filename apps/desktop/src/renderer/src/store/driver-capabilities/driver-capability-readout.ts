// What the capability read answers: each bound driver's declared flags, retained by driver.
//
// RETAINED BY DRIVER, NEVER FOLDED. A session may hold runs on more than one driver, and an
// intersection across the reports answers a question nobody asks ("do ALL drivers here declare
// this?") whose `false` hides a capable driver's control because some other driver in the
// session lacks the flag.
//
// FAIL-CLOSED, AND ABSENT IS NOT `false`. No declaration for a driver leaves every control this
// readout gates off screen, a different fact from a driver having declared the flag absent.

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { Refusal } from "@renderer/lib/refusal.js";

/** One driver's declared flags, exactly as its own report carried them. */
export type DeclaredDriverFlags = Readonly<Record<DriverCapabilityFlag, boolean>>;

/** What the capability read answered. Absent until the read answers. */
export interface DriverCapabilityReadout {
  /**
   * One entry per reported driver, keyed by the reply's own `driverName`.
   *
   * Retained, never folded: the reports are separate declarations by separate
   * drivers, and any collapse of them is an answer to a question the surface does
   * not ask.
   */
  readonly flagsByDriverName: ReadonlyMap<string, DeclaredDriverFlags>;
  /**
   * Which driver each run is bound to, for every run whose binding is nameable.
   *
   * NOT what `driver.listCapabilities` answers, and it never could be: that read is
   * addressed at the NODE and names no run. This member is joined on by the consumer
   * through `withRunDriverBindings`, from the session's own projection; the composer's
   * run-driver bindings own the join and say where each half comes from. It is
   * empty on the readout the read settles, which is the honest reading of a
   * node-scoped answer: that read named no run because it names none.
   */
  readonly driverNameByRunId: ReadonlyMap<string, string>;
  /**
   * Why the declarations could not be read, where they could not be.
   *
   * Present exactly on the two failing terminals — the daemon rejected the read, or
   * answered something the registered schema will not accept. A surface whose
   * controls this readout gates renders it, so a control that is missing because
   * nobody could ask says so rather than looking like a control nothing declares.
   */
  readonly readRefusal: Refusal | undefined;
}
