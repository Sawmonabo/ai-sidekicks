// Where a driver hands the structured questions a provider asks the person, so the questions card
// asks them and the answer goes back through `ProviderDriver.respondToRequest`.
import type { QuestionPrompt } from "@ai-sidekicks/contracts/question";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * The questions one provider request asks, in its order, with the provider's own request id the
 * answer goes back under.
 */
interface ProviderQuestion {
  sessionId: SessionId;
  runId: RunId;
  requestId: string;
  questions: readonly QuestionPrompt[];
}

/** A question the provider withdrew before anyone answered it, by the request id it came under. */
interface ProviderQuestionWithdrawal {
  sessionId: SessionId;
  requestId: string;
}

/**
 * The questions card's intake, registered through a `PortRegistration`. Each call resolves once it
 * is recorded and rejects when it could not be; the answer comes later. A withdrawn question
 * settles its card canceled. Until it is registered, a question stays pending at the provider:
 * nothing answers it.
 */
export interface QuestionPort {
  takeQuestion(question: ProviderQuestion): Promise<void>;
  withdrawQuestion(withdrawal: ProviderQuestionWithdrawal): Promise<void>;
}
