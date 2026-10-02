// Plain stubs for the three account-plane verbs, shared by the suites that drive them. One
// builder keeps two suites from carrying two sets of default answers; a verb a case does not
// script never answers.

import { vi } from "vitest";

import type {
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts";

import { NEVER_SETTLES } from "@test/helpers/abandoned-pass.js";
import type {
  ProviderAccountLoginCall,
  ProviderAccountLoginCancelCall,
  ProviderAccountRegisterCall,
} from "./provider-sign-in-flow.js";

/** One brokered attempt, as the account plane answers a start with it. */
export const PROVIDER_SIGN_IN_ATTEMPT: ProviderAccountLoginResponse = {
  attemptId: "attempt-1",
  verificationUri: "https://provider.example.test/device",
  userCode: "WXYZ-1234",
  expiresAt: "2026-01-01T08:15:00.000Z",
};

/** What one case wants the three account-plane verbs to answer with. */
export interface AccountPlaneScript {
  readonly login?: ProviderAccountLoginResponse;
  readonly cancel?: ProviderAccountLoginCancelResponse;
  readonly register?: ProviderAccountRegisterResponse;
}

/** The three verbs as recording stubs, keyed the way the fixture body's operations are. */
export interface AccountPlaneCalls {
  readonly login: ReturnType<typeof vi.fn<ProviderAccountLoginCall>>;
  readonly cancelLogin: ReturnType<typeof vi.fn<ProviderAccountLoginCancelCall>>;
  readonly register: ReturnType<typeof vi.fn<ProviderAccountRegisterCall>>;
}

/** The three verbs answering what a case scripted, and recording what they were asked. */
export function accountPlaneCalls(script: AccountPlaneScript): AccountPlaneCalls {
  const { login, cancel, register } = script;
  return {
    login: vi.fn<ProviderAccountLoginCall>(
      login === undefined ? () => NEVER_SETTLES : () => Promise.resolve(login),
    ),
    cancelLogin: vi.fn<ProviderAccountLoginCancelCall>(
      cancel === undefined ? () => NEVER_SETTLES : () => Promise.resolve(cancel),
    ),
    register: vi.fn<ProviderAccountRegisterCall>(
      register === undefined ? () => NEVER_SETTLES : () => Promise.resolve(register),
    ),
  };
}
