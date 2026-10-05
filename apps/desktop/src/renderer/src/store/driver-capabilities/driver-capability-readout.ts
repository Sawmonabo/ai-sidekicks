// What the capability read answers: each bound driver's declared flags, retained by driver.
//
// Retained by driver, never folded. A session may hold runs on more than one driver, and an
// intersection across the reports answers a question nobody asks ("do all drivers here declare
// this?") whose `false` hides a capable driver's control because another driver lacks the flag.
//
// Fail-closed, and absent is not `false`. No declaration for a driver leaves every control this
// readout gates off screen, a different fact from a driver having declared the flag absent.

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import type { Refusal } from "@renderer/lib/refusal.js";

/** One driver's declared flags, exactly as its own report carried them. */
export type DeclaredDriverFlags = Readonly<Record<DriverCapabilityFlag, boolean>>;

/** What the capability read answered. Absent until the read answers. */
export interface DriverCapabilityReadout {
  /**
   * One entry per reported driver, keyed by the reply's own `driverName`. Retained, never
   * folded: any collapse of separate declarations answers a question no reader asks.
   */
  readonly flagsByDriverName: ReadonlyMap<ProviderName, DeclaredDriverFlags>;
  /**
   * Which driver each run is bound to, for every run whose binding is nameable.
   *
   * Not what `driver.listCapabilities` answers, since that read names no run. The consumer
   * joins it on through `withRunDriverBindings` from the session's own projection, so it is
   * empty on the readout the read settles.
   */
  readonly driverNameByRunId: ReadonlyMap<string, ProviderName>;
  /**
   * Why the declarations could not be read, where they could not be: the daemon rejected the
   * read, or answered something the registered schema will not accept. A view whose controls
   * this readout gates renders it, so a missing control says why.
   */
  readonly readRefusal: Refusal | undefined;
}
