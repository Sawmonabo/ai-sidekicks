// Block geometry remembered across mounts. A long body drawn again, its row scrolled back in, lays
// its undrawn blocks out at the heights they last measured rather than at estimates, so its height
// does not jump as they are drawn and measured again. Filed by text, width and whether the block
// ends its body: the same text at the same width measures the same in any body.

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { type BlockGeometry } from "./geometry.js";

/**
 * Bytes of remembered geometry across every body: about 2,000 blocks, every block of three 200 KB
 * replies at the 285 characters a block measured in a mix of prose, code and lists.
 */
const BLOCK_GEOMETRY_MEMORY_BYTE_CAP = 524_288;

/**
 * What one remembered geometry holds on the heap beyond its key's text. Measured in V8: 100,000
 * entries with 16-character keys held 266 bytes each, key string included.
 */
const BLOCK_GEOMETRY_ENTRY_BYTES = 250;

const blockGeometryMemory: ByteBoundedCache<BlockGeometry> = new ByteBoundedCache<BlockGeometry>(
  BLOCK_GEOMETRY_MEMORY_BYTE_CAP,
  () => BLOCK_GEOMETRY_ENTRY_BYTES,
);

/** Where one block's geometry is filed. */
export interface BlockGeometryAddress {
  /** The block text's fingerprint. */
  readonly fingerprint: string;
  /** The body's content width, in whole CSS pixels: text wraps differently at another. */
  readonly widthPx: number;
  /** Whether the block ends its body, where its last paragraph keeps no margin below it. */
  readonly isFinal: boolean;
}

/** The geometry last measured for a block at this address, or `undefined`. */
export function recallBlockGeometry(address: BlockGeometryAddress): BlockGeometry | undefined {
  return blockGeometryMemory.get(memoryKeyOf(address));
}

/** Files a measured block's geometry, the oldest giving way once the cap is reached. */
export function rememberBlockGeometry(
  address: BlockGeometryAddress,
  geometry: BlockGeometry,
): void {
  blockGeometryMemory.set(memoryKeyOf(address), geometry);
}

function memoryKeyOf(address: BlockGeometryAddress): string {
  return `${address.fingerprint}@${String(address.widthPx)}${address.isFinal ? "$" : ""}`;
}
