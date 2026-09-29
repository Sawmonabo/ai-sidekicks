// What settled one question, read from the session store.
//
// The store folds every terminal it admits, so a question answered on another window or
// device loses its controls here as well, which a fold over one transcript window could
// not see.

import { useMemo } from "react";

import { useSessionPartition } from "../../session/hooks/useOpenSessionStore.js";
import type { SessionStore } from "../../session/session-store.js";
import type { DriverAskReading, QuestionSettlement } from "../question-reading.js";
import { findQuestionSettlement } from "../question-settlement-projection.js";

/**
 * What settled this question, or `undefined` while it is still open, and then the card
 * keeps offering its answer controls.
 */
export function useQuestionSettlement(
  sessionStore: SessionStore,
  ask: DriverAskReading,
): QuestionSettlement | undefined {
  const questions = useSessionPartition(sessionStore, "question");
  return useMemo(() => findQuestionSettlement(questions, ask), [questions, ask]);
}
