// The attention plane: a session's attention projection, and the per-participant
// preferences that shape what lands in it.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The row
// comment below is the file's own, kept with the row it explains.

import type { AttentionProjection } from "../wire-shapes/index.js";
import type { GrowthAttentionPreference } from "../growth-values/index.js";

export interface AttentionGrowthSignatures {
  // The registered request also carries a `scope` / `runId` narrowing pair. It is
  // deliberately absent here: the console reads a session's whole projection — the
  // run-scoped items and the session aggregate arrive together and are told apart by
  // the presence of `runId` on each item — so a narrowing member would be a request
  // field with no caller, minted ahead of its reader.
  attentionProjectionRead: { request: { readonly sessionId: string }; value: AttentionProjection };
  attentionPreferenceRead: {
    request: { readonly participantId: string };
    value: { readonly preferences: readonly GrowthAttentionPreference[] };
  };
  attentionPreferenceUpdate: {
    request: GrowthAttentionPreference & { readonly participantId: string };
    value: { readonly updatedAt: string };
  };
  /**
   * Whether the operating system will let this machine raise a notification.
   *
   * Three states and not a boolean, because "nobody has been asked yet" is a real
   * position on this question and is neither granted nor denied — the page says
   * something different for each, and a boolean would collapse two of them.
   */
  attentionOsPermissionRead: {
    request: Record<string, never>;
    value: { readonly status: "granted" | "denied" | "not-determined" };
  };
}
