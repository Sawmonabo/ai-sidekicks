// The served manifest the manifest-row cases read, as the wire hands it over.

import type { ArtifactManifest } from "@ai-sidekicks/contracts";

import { SERVED_SUMMARY } from "@test/helpers/artifact-list-readers.js";

/**
 * The one served manifest row, before the row reader has read it. The overrides are `unknown`
 * per member, since cases driving the reader's guards need replies the declared type forbids (an
 * absent free-form map, an object where a string is declared).
 */
export function artifactManifest(
  overrides: Readonly<Record<string, unknown>> = {},
): ArtifactManifest {
  return { ...SERVED_SUMMARY, ...overrides } as unknown as ArtifactManifest;
}
