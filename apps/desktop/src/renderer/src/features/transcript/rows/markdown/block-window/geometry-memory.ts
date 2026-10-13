// Block geometry remembered across mounts. A long body drawn again, its row scrolled back in, lays
// its undrawn blocks out at the heights they last measured rather than at estimates, so its height
// does not jump as they are drawn and measured again. Filed by text, the body's type and whether
// the block ends its body: the same text at the same width and text size measures the same in any
// body. A body of tens of thousands of blocks asks for every one each time it is laid out at a new
// type, so a block whose text's hash nothing remembered is answered from that number alone, before
// any key is spelled out.

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { bodyTypeKeyOf, type MarkdownBodyType } from "../body-type.js";
import { fingerprintFrom } from "../settled-block.js";
import { type BlockGeometry } from "./geometry.js";

/** Where one block's geometry is filed. */
export interface BlockGeometryAddress {
  /** The block text's length, in UTF-16 code units. */
  readonly textLength: number;
  /** The block text's `hashOf` hash. */
  readonly textHash: number;
  /** The body's width and text size: text wraps differently at another. */
  readonly bodyType: MarkdownBodyType;
  /** Whether the block ends its body, where its last paragraph keeps no margin below it. */
  readonly isFinal: boolean;
}

/** The geometry last measured for a block at this address, or `undefined`. */
export function recallBlockGeometry(address: BlockGeometryAddress): BlockGeometry | undefined {
  return blockGeometryMemory.recall(address);
}

/** Files a measured block's geometry, the oldest giving way once the cap is reached. */
export function rememberBlockGeometry(
  address: BlockGeometryAddress,
  geometry: BlockGeometry,
): void {
  blockGeometryMemory.remember(address, geometry);
}

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

/** One remembered geometry and the hash of the text it was measured for. */
interface RememberedGeometry {
  readonly geometry: BlockGeometry;
  readonly textHash: number;
}

/** The remembered geometries, and how many of them each text hash has. */
class BlockGeometryMemory {
  readonly #geometries = new ByteBoundedCache<RememberedGeometry>(
    BLOCK_GEOMETRY_MEMORY_BYTE_CAP,
    () => BLOCK_GEOMETRY_ENTRY_BYTES,
    (removed) => {
      this.#forgetHash(removed.textHash);
    },
  );
  /** How many remembered geometries each text hash has; a hash with none is not here. */
  readonly #countsByTextHash = new Map<number, number>();

  public recall(address: BlockGeometryAddress): BlockGeometry | undefined {
    return this.#countsByTextHash.has(address.textHash)
      ? this.#geometries.get(memoryKeyOf(address))?.geometry
      : undefined;
  }

  public remember(address: BlockGeometryAddress, geometry: BlockGeometry): void {
    const { textHash } = address;
    this.#countsByTextHash.set(textHash, (this.#countsByTextHash.get(textHash) ?? 0) + 1);
    this.#geometries.set(memoryKeyOf(address), { geometry, textHash });
  }

  #forgetHash(textHash: number): void {
    const count = this.#countsByTextHash.get(textHash) ?? 0;
    if (count <= 1) {
      this.#countsByTextHash.delete(textHash);
    } else {
      this.#countsByTextHash.set(textHash, count - 1);
    }
  }
}

const blockGeometryMemory = new BlockGeometryMemory();

function memoryKeyOf(address: BlockGeometryAddress): string {
  const fingerprint = fingerprintFrom(address.textLength, address.textHash);
  return `${fingerprint}@${bodyTypeKeyOf(address.bodyType)}${address.isFinal ? "$" : ""}`;
}
