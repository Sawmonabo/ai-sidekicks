// A provider's new build as the projection hands it over, for the suites that read one.

import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

/** The provider the build entry names. */
export const UPDATED_PROVIDER_ID = "claudeCode" as ProviderId;

/** The release notes address the build entry carries. */
export const RELEASE_NOTES_ADDRESS = "https://example.com/release-notes/2.1.294";

/** A provider that updated itself from one build to the next. */
export function providerBuildItem(): AttentionItem {
  return {
    id: "providerBuild:0123456789abcdef0123456789abcdef",
    momentId: "providerBuild:0123456789abcdef0123456789abcdef",
    trigger: "providerBuild",
    severity: "informational",
    displayName: "Claude Code",
    stateWord: "updated · 2.1.293 → 2.1.294",
    providerBuild: {
      provider: UPDATED_PROVIDER_ID,
      fromVersion: "2.1.293",
      toVersion: "2.1.294",
      releaseNotesAddress: RELEASE_NOTES_ADDRESS,
    },
    createdAt: "2026-01-01T09:00:00.000Z",
    bannerState: "withheld",
  };
}
