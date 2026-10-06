// An omitted `idempotency_class` defaults to `manual_reconcile_only`, so a tool that declares
// nothing is never shown as safe to repeat.
import { describe, expect, it } from "vitest";

import { ProviderToolMetadataSchema, type NormalizedProviderToolMetadata } from "../tools.js";

describe("ProviderToolMetadataSchema: ingress→normalized idempotency default", () => {
  it("defaults an omitted idempotency_class to 'manual_reconcile_only' at parse time", () => {
    const normalized: NormalizedProviderToolMetadata = ProviderToolMetadataSchema.parse({
      name: "delete_branch",
    });
    expect(normalized.idempotency_class).toBe("manual_reconcile_only");
    expect(normalized.name).toBe("delete_branch");
  });
});
