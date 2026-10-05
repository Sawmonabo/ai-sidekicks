// This machine's id and friendly name: minted and read at the daemon's first start, then read back
// unchanged at every later start, so the id a mount, an event or a registration carries never
// moves.

import type { Database } from "better-sqlite3";

import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/node-id";

import { mintUuidV7 } from "../ids/uuid-v7.js";

/** This machine as the daemon knows it. */
export interface LocalMachine {
  readonly nodeId: NodeId;
  readonly name: string;
}

interface LocalMachineRow {
  readonly node_id: string;
  readonly name: string;
}

/**
 * Returns this machine's id and name, minting the id and reading the name through `readName` only
 * when no daemon has started on this database before. Two daemons racing on a fresh database
 * serialize on the write lock and both return the one row that won.
 */
export async function readOrMintLocalMachine(
  database: Database,
  readName: () => Promise<string>,
  now: () => Date,
): Promise<LocalMachine> {
  const selectRow = database.prepare<[], LocalMachineRow>(
    "SELECT node_id, name FROM local_machine WHERE singleton = 1",
  );
  const existing = selectRow.get();
  if (existing !== undefined) {
    return toLocalMachine(existing);
  }

  const name = await readName();
  const insertRow = database.prepare(
    `INSERT INTO local_machine (singleton, node_id, name, minted_at)
     VALUES (1, @nodeId, @name, @mintedAt)
     ON CONFLICT(singleton) DO NOTHING`,
  );
  const minted = database
    .transaction((): LocalMachineRow => {
      insertRow.run({ nodeId: mintUuidV7(), name, mintedAt: now().toISOString() });
      return selectRow.get()!;
    })
    .immediate();
  return toLocalMachine(minted);
}

// The row is read back from the daemon's own file, which another program could have written.
function toLocalMachine(row: LocalMachineRow): LocalMachine {
  return { nodeId: NodeIdSchema.parse(row.node_id), name: row.name };
}
