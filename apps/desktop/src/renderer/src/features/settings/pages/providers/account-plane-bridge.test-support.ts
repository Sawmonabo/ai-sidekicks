// Plain stubs for the three account-plane verbs, shared by the suites that drive them. One
// builder keeps two suites from carrying two sets of default answers; a verb a case does not
// script never answers.

import { vi } from "vitest";

import type {
  ProviderAccountSignInAttemptCancelResponse,
  ProviderAccountSignInResponse,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts/provider/account/sign-in";

import { NEVER_SETTLES } from "#test/helpers/abandoned-pass.js";
import type {
  ProviderAccountSignInCall,
  ProviderAccountSignInCancelCall,
  ProviderAccountRegisterCall,
} from "./sign-in/flow.js";

/** One brokered attempt, as the account plane answers a start with it. */
export const PROVIDER_SIGN_IN_ATTEMPT: ProviderAccountSignInResponse = {
  attemptId: "attempt-1",
  verificationUri: "https://provider.example.test/device",
  userCode: "WXYZ-1234",
  expiresAt: "2026-01-01T08:15:00.000Z",
  isBrowserOpenedByProvider: false,
};

/** What one case wants the three account-plane verbs to answer with. */
export interface AccountPlaneScript {
  readonly signIn?: ProviderAccountSignInResponse;
  readonly cancel?: ProviderAccountSignInAttemptCancelResponse;
  readonly register?: ProviderAccountRegisterResponse;
}

/** The three verbs as recording stubs, keyed the way the page's operations are. */
export interface AccountPlaneCalls {
  readonly signIn: ReturnType<typeof vi.fn<ProviderAccountSignInCall>>;
  readonly cancelSignIn: ReturnType<typeof vi.fn<ProviderAccountSignInCancelCall>>;
  readonly register: ReturnType<typeof vi.fn<ProviderAccountRegisterCall>>;
}

/** The three verbs answering what a case scripted, and recording what they were asked. */
export function accountPlaneCalls(script: AccountPlaneScript): AccountPlaneCalls {
  const { signIn, cancel, register } = script;
  return {
    signIn: vi.fn<ProviderAccountSignInCall>(
      signIn === undefined ? () => NEVER_SETTLES : () => Promise.resolve(signIn),
    ),
    cancelSignIn: vi.fn<ProviderAccountSignInCancelCall>(
      cancel === undefined ? () => NEVER_SETTLES : () => Promise.resolve(cancel),
    ),
    register: vi.fn<ProviderAccountRegisterCall>(
      register === undefined ? () => NEVER_SETTLES : () => Promise.resolve(register),
    ),
  };
}
