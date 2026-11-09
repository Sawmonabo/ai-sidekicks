// The rule a machine's environment row name is checked against before it is saved, the same rule
// the service runs.
import {
  APP_SET_ENVIRONMENT_NAMES,
  CREDENTIAL_NAME_SUFFIXES,
  ENVIRONMENT_NAME_PATTERN,
  type EnvironmentNameRefusalReason,
} from "../../generated/machine/settings.js";

const ENVIRONMENT_NAME_REGEX = new RegExp(ENVIRONMENT_NAME_PATTERN);

/**
 * Why the app's shared rules refuse a row's name, or `null` when they let it be saved; the service
 * also refuses a name a registered driver sets. Names compare without case, because Windows reads
 * `path` and `PATH` as one variable.
 */
export function environmentNameRefusal(name: string): EnvironmentNameRefusalReason | null {
  if (!ENVIRONMENT_NAME_REGEX.test(name)) {
    return "notAName";
  }
  const upperName = name.toUpperCase();
  if (CREDENTIAL_NAME_SUFFIXES.some((suffix) => upperName.endsWith(suffix))) {
    return "credentialShaped";
  }
  if ((APP_SET_ENVIRONMENT_NAMES as readonly string[]).includes(upperName)) {
    return "setByApp";
  }
  return null;
}
