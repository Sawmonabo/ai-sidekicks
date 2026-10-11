// The artifact id minter mints ids that parse as artifact ids and carry version 7.

import { describe, expect, it } from "vitest";

import { ArtifactIdSchema } from "@ai-sidekicks/contracts/artifacts/id";

import { mintArtifactId } from "../id.js";

describe("mintArtifactId", () => {
  it("mints a version 7 id that parses as an artifact id", () => {
    const id = mintArtifactId();

    expect(ArtifactIdSchema.safeParse(id).success).toBe(true);
    // The first digit of the third group is the version.
    expect(id.charAt(14)).toBe("7");
  });
});
