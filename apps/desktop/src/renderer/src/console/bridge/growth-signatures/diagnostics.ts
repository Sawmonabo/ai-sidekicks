// The diagnostics plane: this machine's health, one run's failure detail and stall
// reading, the operator's recovery request, and the redaction policy read.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The row
// comment below is the file's own, kept with the row it explains.
//
// THE SUBSCRIPTION IS NOT HERE, AND ITS ABSENCE IS THE SECTION'S OWN RULE.
// `healthSubscribe` sits in the session plane serving a different slate row, and
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health forbids this surface
// from using one outright — "there is no health subscription, so the surface re-reads
// on focus, on reconnect, and on run-terminal events". Five reads and one mutation is
// the whole plane; a sixth signature that streamed would be a wire this page may not
// call sitting in the table it calls from.

import type {
  GrowthFailureDetail,
  GrowthHealthStatus,
  GrowthRecoveryAction,
  GrowthRecoveryReceipt,
  GrowthRedactionPolicy,
  GrowthStuckRunInspection,
} from "../growth-values/index.js";

/**
 * The scopes the status read narrows to.
 *
 * The registered request's own four-member set. It is declared here rather than in
 * `growth-values/` because the console has exactly one reader for it — this request
 * — and the values module's rule is that a shape read at one call site earns no name
 * of its own.
 */
export type GrowthHealthScope = "daemon" | "control_plane" | "provider" | "replay";

export interface DiagnosticsGrowthSignatures {
  // The scope is optional and the console never sends it. It is stated all the same
  // because the registered request carries it: a member absent from this table is a
  // member a later caller would add without noticing the wire already has one, and
  // an unnarrowed read is what this page wants — every component at once, which is
  // what the banner renders.
  healthStatusRead: {
    request: { readonly scope?: GrowthHealthScope };
    value: GrowthHealthStatus;
  };
  healthFailureDetailRead: { request: { readonly runId: string }; value: GrowthFailureDetail };
  healthStuckRunInspect: { request: { readonly runId: string }; value: GrowthStuckRunInspection };
  // The one mutation of the plane. `reason` is optional on the wire and the page
  // sends none: the console has no field for it and inventing one would put words in
  // an operator's mouth on a record `Spec-020` makes durable.
  healthRecoveryActionRequest: {
    request: {
      readonly runId: string;
      readonly action: GrowthRecoveryAction;
      readonly reason?: string;
    };
    value: GrowthRecoveryReceipt;
  };
  // The daemon-singleton policy takes no parameters, and the empty request is NAMED
  // as an empty record rather than typed `unknown`: a caller that starts passing
  // something has to come here and say what.
  healthRedactionPolicyRead: {
    request: Record<string, never>;
    value: GrowthRedactionPolicy;
  };
}
