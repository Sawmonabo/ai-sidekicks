// The long tables a feed draws, each under the key its spacer rows carry, so a copy reads a table's
// undrawn rows from the parse the screen drew it from rather than waiting for them to draw. A copy
// that outlives the frame it was asked in takes the tables its rows name when it is asked, since a
// table that scrolls away lets its hold go.

import type { Table } from "mdast";
import { createContext, type Context } from "react";

/** The long tables one feed draws, by the key their spacer rows carry. */
export class DrawnLongTables {
  readonly #tables = new Map<string, Table>();

  /** Holds `table` under `key`, in place of what the key held, until the key is let go. */
  public hold(key: string, table: Table): void {
    this.#tables.set(key, table);
  }

  /** Lets the table under `key` go. */
  public release(key: string): void {
    this.#tables.delete(key);
  }

  /** The table under `key`, or `undefined` once it is let go. */
  public tableOf(key: string): Table | undefined {
    return this.#tables.get(key);
  }
}

/** The feed's drawn long tables, provided around its viewport; `undefined` outside one. */
export const DrawnLongTablesContext: Context<DrawnLongTables | undefined> = createContext<
  DrawnLongTables | undefined
>(undefined);
