import { registerSettingsPageBody } from "../../page-body-registry.js";
import { AccountsFixtureMount } from "./AccountsFixtureMount.js";

/**
 * Mount the accounts fixture body in the Providers page. Only a fixture launch's composition
 * calls it.
 */
export function registerAccountsFixtureBody(): void {
  registerSettingsPageBody("providers", "providers-fixture", AccountsFixtureMount);
}
