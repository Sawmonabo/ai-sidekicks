// Setup the Codex lifecycle test files share, beside the doubles in `test-doubles.ts`.

import type { CreateSessionParams, ResumeSessionParams } from "../../../provider-driver.js";

import { SESSION_CONFIG, SESSION_ID, TEST_MODEL, THREAD_ID } from "./test-doubles.js";

/** The create every lifecycle test opens its session with. */
export const CREATE_PARAMS: CreateSessionParams = {
  model: TEST_MODEL,
  sessionId: SESSION_ID,
  config: SESSION_CONFIG,
};

/** A resume of the test thread with nothing else stated. */
export const RESUME_PARAMS: ResumeSessionParams = {
  model: TEST_MODEL,
  sessionId: SESSION_ID,
  resumeHandle: THREAD_ID,
};
