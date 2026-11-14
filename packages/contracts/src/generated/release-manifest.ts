// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The release manifest: the JSON file a release publishes beside its artifacts, and the version a release carries.

import { type CompiledSchemaCheck, ucs2length } from "../schema-check.js";
import type { WireInstant } from "./internal/wire-scalars.js";

/** The longest release version accepted. */
export const RELEASE_VERSION_MAX_LEN = 64 as const;

/** The longest artifact name or artifact address a manifest carries. */
export const RELEASE_MANIFEST_FIELD_MAX_LEN = 2048 as const;

/**
 * A release's version as a person reads it, `0.1.0` or `1.4.0-beta.2`: `MAJOR.MINOR.PATCH`
 * with an optional pre-release and build suffix.
 */
export type ReleaseVersion = string;
/**
 * A SHA-256 digest in lowercase hex.
 */
export type Sha256Hex = string;

/**
 * One published artifact: where to fetch it, over `https`, and the SHA-256 of its bytes.
 */
export interface ReleaseManifestArtifact {
  /**
   * Where to fetch it.
   */
  url: string;
  /**
   * The SHA-256 of its bytes.
   */
  sha256: Sha256Hex;
}
/**
 * A release manifest as published.
 */
export interface ReleaseManifest {
  /**
   * A whole number that rises with every release, never reused.
   */
  version: number;
  /**
   * When the release was published.
   */
  released_at: WireInstant;
  /**
   * Each artifact keyed by its platform name, `linux-x64` or `darwin-arm64`.
   */
  artifacts: {
    [k: string]: ReleaseManifestArtifact | undefined;
  };
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern131 = new RegExp("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$", "u");
/** Checks that a value is a {@link ReleaseVersion}. */
// prettier-ignore
export const validateReleaseVersion: CompiledSchemaCheck<ReleaseVersion> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReleaseVersion {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReleaseVersion.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 64){validateReleaseVersion.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(!pattern131.test(data)){validateReleaseVersion.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"}}];return false;}}}else {validateReleaseVersion.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateReleaseVersion.errors = vErrors;return errors === 0;};
// prettier-ignore
validateReleaseVersion.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern87 = new RegExp("^[0-9a-f]{64}$", "u");
/** Checks that a value is a {@link Sha256Hex}. */
// prettier-ignore
export const validateSha256Hex: CompiledSchemaCheck<Sha256Hex> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Sha256Hex {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSha256Hex.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern87.test(data)){validateSha256Hex.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validateSha256Hex.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSha256Hex.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSha256Hex.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
