// The two refusals a saved list or pattern meets, in the page's words, for the machine's own
// settings and a project's override alike: an environment row whose name the shared rule refuses,
// and a branch-name pattern refused by its placeholder rule or by git.
import {
  DAEMON_BRANCH_PATTERN_REFUSED_CODE,
  DAEMON_ENVIRONMENT_NAME_REFUSED_CODE,
  environmentNameRefusal,
  type BranchPatternRefusalReason,
  type DaemonBranchPatternRefusedDetails,
  type DaemonEnvironmentNameRefusedDetails,
  type EnvironmentNameRefusalReason,
  type EnvironmentRow,
} from "@ai-sidekicks/contracts/machine-settings";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";

import { DaemonDomainError } from "../../../ipc/domain-error.js";

// What the page says under a refused row, for each reason.
const ENVIRONMENT_NAME_REFUSAL_WORDS: Readonly<Record<EnvironmentNameRefusalReason, string>> =
  Object.freeze({
    not_a_name: "A name is letters, digits and underscores, and never starts with a digit.",
    credential_shaped:
      "Credentials are not set here. Sign in to a provider on Providers, or add a workflow " +
      "step's token in its Credential field.",
    set_by_app: "The app sets this.",
  });

// What the page says under a refused pattern, for each reason.
const BRANCH_PATTERN_REFUSAL_WORDS: Readonly<Record<BranchPatternRefusalReason, string>> =
  Object.freeze({
    title_not_once: "Put {title} in the name once.",
    not_a_branch_name: "Git does not accept this as a branch name.",
  });

/**
 * Throws `daemon.environment_name_refused` (`InvalidParams`) for the first row whose name the
 * environment-name rule refuses, naming the row, in the page's words; returns when every name may
 * be saved. Called before anything is written.
 */
export function refuseEnvironmentRows(rows: readonly EnvironmentRow[]): void {
  for (const row of rows) {
    const reason = environmentNameRefusal(row.name);
    if (reason !== null) {
      const detail: DaemonEnvironmentNameRefusedDetails = { name: row.name, reason };
      throw new DaemonDomainError(ENVIRONMENT_NAME_REFUSAL_WORDS[reason], {
        code: DAEMON_ENVIRONMENT_NAME_REFUSED_CODE,
        jsonRpcCode: JsonRpcErrorCode.InvalidParams,
        detail: { ...detail },
      });
    }
  }
}

/**
 * Throws `daemon.branch_pattern_refused` (`InvalidParams`) when `reason` is a refusal, in the
 * page's words; returns when it is `null`.
 */
export function refuseBranchPattern(reason: BranchPatternRefusalReason | null): void {
  if (reason === null) {
    return;
  }
  const detail: DaemonBranchPatternRefusedDetails = { reason };
  throw new DaemonDomainError(BRANCH_PATTERN_REFUSAL_WORDS[reason], {
    code: DAEMON_BRANCH_PATTERN_REFUSED_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { ...detail },
  });
}
