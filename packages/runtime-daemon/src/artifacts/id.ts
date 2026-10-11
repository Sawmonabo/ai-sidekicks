// The one minter of artifact ids: a manifest's id is the daemon-wide UUIDv7, branded, so ids sort
// by the time their manifest was written. `crypto.randomUUID()` would mint a version 4 id that
// still parses as an artifact id, which is why every producer mints here.

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

import { mintUuidV7 } from "../uuid-v7.js";

/** Mints the id of a new artifact manifest, a UUIDv7 from the daemon-wide minter. */
export function mintArtifactId(): ArtifactId {
  return mintUuidV7() as ArtifactId;
}
