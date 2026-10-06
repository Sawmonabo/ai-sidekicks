// This machine's id and friendly name: minted and read at the daemon's first start, then read back
// unchanged at every later start, so the id a mount, an event or a registration carries never
// moves.

import type { Database } from "better-sqlite3";

import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/node-id";

import { mintUuidV7 } from "../../uuid-v7.js";

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
 * when no daemon has started on this database before. One daemon at a time holds the data folder,
 * so no other start writes the row meanwhile.
 */
export async function readOrMintLocalMachine(
  database: Database,
  readName: () => Promise<string>,
  now: () => Date,
): Promise<LocalMachine> {
  const existing = database
    .prepare<[], LocalMachineRow>("SELECT node_id, name FROM local_machine WHERE singleton = 1")
    .get();
  if (existing !== undefined) {
    return toLocalMachine(existing);
  }

  const minted: LocalMachineRow = { node_id: mintUuidV7(), name: await readName() };
  database
    .prepare(
      `INSERT INTO local_machine (singleton, node_id, name, minted_at)
       VALUES (1, @nodeId, @name, @mintedAt)`,
    )
    .run({ nodeId: minted.node_id, name: minted.name, mintedAt: now().toISOString() });
  return toLocalMachine(minted);
}

// The row is read back from the daemon's own file, which another program could have written.
function toLocalMachine(row: LocalMachineRow): LocalMachine {
  return { nodeId: NodeIdSchema.parse(row.node_id), name: row.name };
}
