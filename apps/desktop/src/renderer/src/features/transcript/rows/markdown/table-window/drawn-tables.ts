// The long tables a feed draws, each under the key its spacer rows carry, so a copy reads a table's
// undrawn rows from the parse the screen drew it from rather than waiting for them to draw. A copy
// that outlives the frame it was asked in takes the tables its rows name when it is asked, since a
// table that scrolls away lets its hold go.

import type { Table } from "mdast";
import { createContext, type Context } from "react";

import { type BlockParseSource } from "#renderer/components/Markdown/parse.js";

/** One long table drawn: the parsed table, and what its block was parsed from. */
export interface DrawnLongTable {
  readonly table: Table;
  /** What the block holding the table was parsed from, read when called, the same each call. */
  readonly readBlockParseSource: () => BlockParseSource;
}

/** The long tables one feed draws, by the key their spacer rows carry. */
export class DrawnLongTables {
  readonly #tables = new Map<string, DrawnLongTable>();

  /** Holds `table` under `key`, in place of what the key held, until the key is let go. */
  public hold(key: string, table: DrawnLongTable): void {
    this.#tables.set(key, table);
  }

  /** Lets the table under `key` go. */
  public release(key: string): void {
    this.#tables.delete(key);
  }

  /** The table under `key`, or `undefined` once it is let go. */
  public tableOf(key: string): DrawnLongTable | undefined {
    return this.#tables.get(key);
  }
}

/** The feed's drawn long tables, provided around its viewport; `undefined` outside one. */
export const DrawnLongTablesContext: Context<DrawnLongTables | undefined> = createContext<
  DrawnLongTables | undefined
>(undefined);
