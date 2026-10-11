// The artifact id minter mints RFC 9562 version 7 ids: the version nibble reads 7 and the variant
// bits read 10, each id parses as a branded artifact id, no two are equal, and they come out in
// order. The same version check refuses the version 4 id `crypto.randomUUID()` mints.

import { randomUUID } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vitest";

import { ArtifactIdSchema, type ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

import { mintArtifactId } from "../id.js";

const BATCH_SIZE = 512;

// The most significant 4 bits of octet 6: the first digit of the third group.
function versionOf(uuid: string): number {
  return Number.parseInt(uuid.charAt(14), 16);
}

// The two most significant bits of octet 8: the first digit of the fourth group.
function variantBitsOf(uuid: string): number {
  return Number.parseInt(uuid.charAt(19), 16) >> 2;
}

describe("mintArtifactId", () => {
  it("mints distinct, ordered version 7 ids that parse as artifact ids", () => {
    const ids = Array.from({ length: BATCH_SIZE }, () => mintArtifactId());
    expectTypeOf(ids).toEqualTypeOf<ArtifactId[]>();

    for (const id of ids) {
      expect(versionOf(id)).toBe(7);
      expect(variantBitsOf(id)).toBe(0b10);
      expect(ArtifactIdSchema.safeParse(id).success).toBe(true);
    }
    expect(new Set(ids).size).toBe(BATCH_SIZE);
    expect(ids.toSorted()).toStrictEqual(ids);
  });

  it("the version check refuses the version 4 id crypto.randomUUID mints", () => {
    expect(versionOf(randomUUID())).not.toBe(7);
  });
});
