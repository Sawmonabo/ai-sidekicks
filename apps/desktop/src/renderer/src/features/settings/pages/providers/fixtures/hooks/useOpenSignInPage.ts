import { useState } from "react";

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";

/**
 * `Open the sign-in page`: hands the provider's sign-in address to the system browser, keeping
 * the refusal where the browser could not be reached so the address beside it is the way on.
 */
export function useOpenSignInPage(): {
  readonly refusal: Refusal | undefined;
  readonly openSignInPage: (verificationUri: string) => void;
} {
  const bridge = usePlatformBridge();
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const openSignInPage = (verificationUri: string): void => {
    setRefusal(undefined);
    // The rejection's own message crosses IPC with the channel's name in it, so it is not shown.
    bridge.native.openExternal(verificationUri).catch(() => {
      setRefusal(SIGN_IN_PAGE_UNOPENED);
    });
  };
  return { refusal, openSignInPage };
}

/** What a refused open says. */
const SIGN_IN_PAGE_UNOPENED = refuse(
  "provider-sign-in-page",
  "open-sign-in-page-failed",
  "Could not open the sign-in page.",
);
