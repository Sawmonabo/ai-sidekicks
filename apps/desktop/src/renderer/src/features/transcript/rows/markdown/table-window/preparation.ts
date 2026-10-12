// What a settled block's long tables wait on before their row is listed: each table measured off
// the list and its geometry filed, so the row's table draws its window from its first frame. The
// block's tree comes from the row's preparation, which holds it for the body that draws it next.

import type { Root, Table } from "mdast";

import { settledTableKeyOf } from "./geometry-memory.js";
import { longTablesOf, mayHoldLongTable } from "./long-tables.js";
import { type OffListTables } from "./off-list.js";

/** A settled block's long tables, measured off the list and filed for the body that draws them. */
export interface TableWindowPreparation {
  /** Whether every table measured has been filed, or failed to be. */
  readonly isReady: boolean;
  /** Stops the measuring still running. */
  release(): void;
}

/** A settled block as its body draws it. */
export interface PreparedBlock {
  readonly source: string;
  /** The fingerprint of its text, which its tables' geometry is filed by. */
  readonly fingerprint: string;
  /** The definitions the block is parsed against. */
  readonly definitionPreamble: string;
  /** The block's tree, parsed against `definitionPreamble`. */
  readonly root: Root;
  /** The footnote identifiers the whole body declares. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
}

/**
 * Starts measuring, off the list, each table with more body rows than are drawn whole that `block`
 * holds, and files its geometry where the table window takes it on mount. `onReady` is called once
 * every one is filed or failed. `undefined` when the block holds no long table: a cheap test of
 * its text, with no walk of its tree, answers for most blocks.
 */
export function prepareTableWindows(
  block: PreparedBlock,
  offList: OffListTables,
  onReady: () => void,
): TableWindowPreparation | undefined {
  if (!mayHoldLongTable(block.source)) {
    return undefined;
  }
  const tables = longTablesOf(block.root);
  return tables.length === 0
    ? undefined
    : new LongTablesPreparation(tables, block, offList, onReady);
}

/** One block's long tables being measured, until they are released. */
class LongTablesPreparation implements TableWindowPreparation {
  readonly #withdrawals: (() => void)[] = [];
  #pendingCount = 0;
  #isReleased = false;

  public constructor(
    tables: readonly Table[],
    block: PreparedBlock,
    offList: OffListTables,
    onReady: () => void,
  ) {
    for (const table of tables) {
      let hasLanded = false;
      const tableKey = settledTableKeyOf(block.fingerprint, block.definitionPreamble, table);
      const withdraw = offList.measure(table, tableKey, block.definedFootnoteIdentifiers, () => {
        if (hasLanded || this.#isReleased) {
          return;
        }
        hasLanded = true;
        this.#pendingCount -= 1;
        if (this.#pendingCount === 0) {
          onReady();
        }
      });
      if (withdraw !== undefined) {
        this.#pendingCount += 1;
        this.#withdrawals.push(withdraw);
      }
    }
  }

  public get isReady(): boolean {
    return this.#pendingCount === 0;
  }

  public release(): void {
    if (this.#isReleased) {
      return;
    }
    this.#isReleased = true;
    for (const withdraw of this.#withdrawals) {
      withdraw();
    }
  }
}
