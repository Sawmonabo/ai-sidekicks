/**
 * Each driver's built-in tools, keyed by registry name: the one table
 * `driver.listCapabilities` reads them from.
 *
 * The list is a constant of the driver, not a fact about a reading, so the capability cache
 * composes it on every read and nothing stores it. Total over `FlooredDriverName` by type
 * annotation: a floored driver without a tool list is a compile error here.
 */

import type { FlooredDriverName } from "./capability-refresh.js";
import { CLAUDE_BUILT_IN_TOOLS } from "./drivers/claude/tools.js";
import { CODEX_BUILT_IN_TOOLS } from "./drivers/codex/tools.js";

const DRIVER_BUILT_IN_TOOLS: Readonly<Record<FlooredDriverName, readonly string[]>> = Object.freeze(
  {
    claude: CLAUDE_BUILT_IN_TOOLS,
    codex: CODEX_BUILT_IN_TOOLS,
  },
);

/**
 * Resolve a driver's built-in tools by registry name.
 *
 * Throws for a name this table does not carry: a driver with a cached capability set and no
 * tool list is a wiring fault, and a report missing the list would still look well-formed.
 * `Object.hasOwn` also refuses an inherited key such as `constructor`.
 */
export function builtInToolsFor(driverName: string): readonly string[] {
  if (!Object.hasOwn(DRIVER_BUILT_IN_TOOLS, driverName)) {
    throw new Error(`builtInToolsFor: no built-in tools are declared for driver '${driverName}'`);
  }
  return DRIVER_BUILT_IN_TOOLS[driverName as FlooredDriverName];
}
