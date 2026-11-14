import type { ProviderAccountSignInResponse } from "@ai-sidekicks/contracts/provider/account/sign-in";
import { useEffect, useState } from "react";

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";

/**
 * `Open the sign-in page`: hands the attempt's sign-in address to the system browser, once on its
 * own where the provider opened no browser itself and again on each press, keeping the refusal
 * where the browser could not be reached so the address beside it is the way on.
 */
export function useOpenSignInPage(attempt: ProviderAccountSignInResponse): {
  readonly refusal: Refusal | undefined;
  readonly openSignInPage: () => void;
} {
  const bridge = usePlatformBridge();
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const { attemptId, verificationUri, isBrowserOpenedByProvider } = attempt;
  const openSignInPage = (): void => {
    setRefusal(undefined);
    // The rejection's own message crosses IPC with the channel's name in it, so it is not shown.
    bridge.native.openExternal(verificationUri).catch(() => {
      setRefusal(SIGN_IN_PAGE_UNOPENED);
    });
  };
  // Once per attempt: a redraw of the same attempt opens no second browser tab.
  useEffect(() => {
    if (!isBrowserOpenedByProvider) {
      openSignInPage();
    }
  }, [attemptId]);
  return { refusal, openSignInPage };
}

/** What a refused open says. */
const SIGN_IN_PAGE_UNOPENED = refuse(
  "provider-sign-in-page",
  "open-sign-in-page-failed",
  "Couldn't open the browser. Copy the address beside it to sign in.",
);
