// Setup the Codex lifecycle test files share, beside the doubles in
// `__fixtures__/app-server-doubles.ts`.

import type { CreateSessionParams, ResumeSessionParams } from "../../contract.js";

import {
  SESSION_ID,
  TEST_MODEL,
  TEST_POSTURE,
  THREAD_ID,
} from "../__fixtures__/app-server-doubles.js";

/** The create every lifecycle test opens its session with. */
export const CREATE_PARAMS: CreateSessionParams = {
  model: TEST_MODEL,
  largerWindow: undefined,
  sessionId: SESSION_ID,
  config: {},
  executionPosture: TEST_POSTURE,
};

/** A resume of the test thread at the test posture. */
export const RESUME_PARAMS: ResumeSessionParams = {
  model: TEST_MODEL,
  largerWindow: undefined,
  sessionId: SESSION_ID,
  resumeHandle: THREAD_ID,
  executionPosture: TEST_POSTURE,
  mode: "build",
};
