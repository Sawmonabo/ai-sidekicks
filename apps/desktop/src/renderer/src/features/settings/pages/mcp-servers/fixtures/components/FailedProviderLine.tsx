import type { ReactNode } from "react";

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useProviderName } from "#renderer/store/providers/hooks/useProviderName.js";

/** The code a provider whose server list the service could not read is drawn under. */
const PROVIDER_READ_FAILED_CODE = "mcp-provider-read-failed";

/**
 * Where a provider's group of servers would stand, the line saying its server list could not be
 * read, ending in `Try again`, which asks for the whole list again.
 */
export function FailedProviderLine(props: {
  readonly provider: ProviderId;
  readonly onTryAgain: () => void;
}): ReactNode {
  const providerName = useProviderName(props.provider);
  return (
    <InlineRefusal
      code={PROVIDER_READ_FAILED_CODE}
      detail={`${providerName}'s server list could not be read.`}
      onTryAgain={props.onTryAgain}
    />
  );
}
