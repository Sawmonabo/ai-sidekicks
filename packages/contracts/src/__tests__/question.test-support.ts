// Question payloads several contracts tests parse.

/** The question a fixture card asks. */
export const QUESTION_ID = "1f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** The run a fixture question holds. */
export const RUN_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

/** One question offering two options, of which one answer is picked. */
export const PICK_ONE: Readonly<Record<string, unknown>> = {
  header: "Auth",
  text: "Which login flow should the service use?",
  options: [
    { label: "OAuth", description: "Sign in with the hosting service" },
    { label: "Token", description: "A pasted access token" },
  ],
  severalAnswers: false,
  secret: false,
};

/** A valid `question.asked` payload: an agent's question that holds its run. */
export const QUESTION_ASKED_ON_RUN_PAYLOAD: Readonly<Record<string, unknown>> = {
  questionId: QUESTION_ID,
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  isAgentWaiting: true,
  questions: [PICK_ONE],
  runId: RUN_ID,
};
