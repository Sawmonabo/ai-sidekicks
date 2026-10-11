// This machine's id, its owner's user id and its friendly name: minted and read at the daemon's
// first start, then read back unchanged at every later start, so the id a mount, an event or a
// registration carries never moves, and the owner every policy check decides as is the one user
// from the first start on, with or without a hosted account.

import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import { UserIdSchema, type UserId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import { mintUuidV7 } from "../../uuid-v7.js";

/** This machine as the daemon knows it, with the one user who owns it. */
export interface LocalMachine {
  readonly nodeId: NodeId;
  /** Minted once at the first start; a hosted account signed in to later attaches to it. */
  readonly ownerUserId: UserId;
  readonly name: string;
}

interface LocalMachineRow {
  readonly node_id: string;
  readonly owner_user_id: string;
  readonly name: string;
}

/**
 * Reads this machine's stored row, or at the first start mints the machine id and the owner's
 * user id, reads the friendly name with `readName`, and stores them for every later start.
 */
export async function readOrMintLocalMachine(
  database: DatabaseConnections,
  readName: () => Promise<string>,
  now: () => Date,
): Promise<LocalMachine> {
  const existing = database.reader
    .prepare<
      [],
      LocalMachineRow
    >("SELECT node_id, owner_user_id, name FROM local_machine WHERE singleton = 1")
    .get();
  if (existing !== undefined) {
    return toLocalMachine(existing);
  }
  const minted: LocalMachineRow = {
    node_id: mintUuidV7(),
    owner_user_id: mintUuidV7(),
    name: await readName(),
  };
  await database.writer.write([
    {
      sql: `INSERT INTO local_machine (singleton, node_id, owner_user_id, name, minted_at)
            VALUES (1, @nodeId, @ownerUserId, @name, @mintedAt)`,
      bindings: {
        nodeId: minted.node_id,
        ownerUserId: minted.owner_user_id,
        name: minted.name,
        mintedAt: now().toISOString(),
      },
    },
  ]);
  return toLocalMachine(minted);
}

function toLocalMachine(row: LocalMachineRow): LocalMachine {
  return {
    nodeId: NodeIdSchema.parse(row.node_id),
    ownerUserId: UserIdSchema.parse(row.owner_user_id),
    name: row.name,
  };
}
