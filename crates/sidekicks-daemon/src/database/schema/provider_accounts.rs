//! The provider accounts' part of the daemon's schema: the registry of the accounts this machine
//! may run against, truth no event rebuilds, and the newest quota reading per account and limit,
//! a cache each read replaces. No column holds credential material: credentials live in each
//! account's credential home, written by the provider's own tooling.

use sidekicks_contracts::provider::account::record::{
    BillingMode, MemoryImportOutcomeKind, ProviderAccountHealthState,
    ProviderAccountMemoryImportOutcome, ProviderAccountUsageWindowSource, ProviderAuthMode,
};
use strum::VariantNames as _;

use crate::database::sql_list::{sql_list_of, sql_list_of_every};

/// The provider accounts' tables, indexes and triggers, in foreign-key order.
pub(super) fn provider_accounts_schema_sql() -> String {
    let billing_modes = sql_list_of_every::<BillingMode>();
    let health_states = sql_list_of_every::<ProviderAccountHealthState>();
    let auth_modes = sql_list_of_every::<ProviderAuthMode>();
    let imported = <&'static str>::from(MemoryImportOutcomeKind::Imported);
    let memory_import_outcomes =
        sql_list_of(ProviderAccountMemoryImportOutcome::VARIANTS.iter().copied());
    let reading_sources = sql_list_of_every::<ProviderAccountUsageWindowSource>();
    format!(
        "
-- ---------------------------------------------------------------------------
-- Provider accounts and their quota readings.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_accounts (
  -- Daemon-minted and immutable, never derived from credential material or a provider's subject.
  account_id                TEXT NOT NULL PRIMARY KEY,
  -- The open provider id, with no CHECK: the service checks it against the registered drivers
  -- where it comes in, and a stored row keeps it as written.
  provider                  TEXT NOT NULL,
  -- The name the person typed for an account added from a pasted token or API key, which its
  -- provider names nowhere; NULL on every other account. Personal data.
  display_label             TEXT,
  -- The full-Unicode case fold of display_label, written by the store on every insert and rename
  -- so the unique index compares names the way the screen does; NULL exactly where it is.
  display_label_folded      TEXT,
  -- The daemon builds each spawn environment from this path and never inherits ambient provider
  -- credentials.
  credential_home_path      TEXT NOT NULL,
  -- Starts at 1 and is bumped at every credential-home transition; below 1 a reading would sort
  -- before the account it describes.
  credential_generation     INTEGER NOT NULL DEFAULT 1 CHECK(credential_generation >= 1),
  -- How the account is charged; unknown is honest absence, never metered.
  billing_mode              TEXT NOT NULL CHECK(billing_mode IN ({billing_modes})),
  -- The provider's current account, the one a new run starts on; one per provider.
  is_default                INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
  -- The stored outcome of the last validation, with the credential-home observation taken with
  -- it. NULL until first probed. A registry read never re-derives it, so a read spawns nothing.
  health_state              TEXT
                            CHECK(health_state IS NULL OR health_state IN ({health_states})),
  -- When health_state was observed; not updated_at, which a relabel moves.
  health_observed_at        TEXT,
  -- The mode the provider's own status surface reports, never assumed; unknown is a mode this
  -- daemon does not recognize.
  observed_auth_mode        TEXT
                            CHECK(observed_auth_mode IS NULL
                              OR observed_auth_mode IN ({auth_modes})),
  last_refresh_observed_at  TEXT,               -- NULL means not observed, never fine
  -- When the credential was issued: the observed sign-in, or a token's issuance time. Never the
  -- registration time. NULL renders the re-login estimate as unknown.
  logged_in_at              TEXT,
  -- Provider-reported identity, so two accounts of one provider can be told apart. Replaced by a
  -- later observation; never logged, evented or put on an error.
  observed_account_email    TEXT,
  observed_account_plan     TEXT,               -- the plan id exactly as the provider sends it
  observed_account_org_id   TEXT,
  observed_account_org_name TEXT,
  -- Removal marks this first, then destroys the stored token, then deletes the row: SQLite and the
  -- credential store commit separately, so a crash strands a row marked unusable, never a live
  -- secret. Admission refuses a marked account.
  removal_intent            INTEGER NOT NULL DEFAULT 0 CHECK(removal_intent IN (0, 1)),
  -- Opt-out for the background health observer only; the probe verb and spawn validation still
  -- write the pair.
  probe_enabled             INTEGER NOT NULL DEFAULT 1 CHECK(probe_enabled IN (0, 1)),
  -- An account's redeemable limit resets from its last limits read; NULL where the read
  -- carried none.
  reset_credits_available   INTEGER
                            CHECK(reset_credits_available IS NULL OR reset_credits_available >= 0),
  -- Start each usage window as it opens; does nothing while probe_enabled is 0.
  window_start_enabled      INTEGER NOT NULL DEFAULT 1 CHECK(window_start_enabled IN (0, 1)),
  -- Wake the machine for a window that resets while it sleeps; does nothing while
  -- window_start_enabled is 0.
  wake_for_window_start_enabled INTEGER NOT NULL DEFAULT 0
                            CHECK(wake_for_window_start_enabled IN (0, 1)),
  -- The one memory import: NULL until it runs, then imported with its count and time, or nothing
  -- to import with neither.
  memory_import_outcome     TEXT
                            CHECK(memory_import_outcome IS NULL
                              OR memory_import_outcome IN ({memory_import_outcomes})),
  memory_import_count       INTEGER
                            CHECK(memory_import_count IS NULL OR memory_import_count >= 1),
  memory_imported_at        TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  -- The observation is a pair: a reading without its time, or a time without a reading, is
  -- refused.
  CHECK((health_state IS NULL) = (health_observed_at IS NULL)),
  -- An import that copied something has its count and time; no other outcome has either.
  CHECK((memory_import_outcome IS '{imported}')
    = (memory_import_count IS NOT NULL AND memory_imported_at IS NOT NULL)),
  CHECK((memory_import_count IS NULL) = (memory_imported_at IS NULL)),
  -- A typed name and its fold are written together, so the unique index never misses a name.
  CHECK((display_label IS NULL) = (display_label_folded IS NULL))
) STRICT;

-- One current account per provider. Two concurrent updates would each see no other; the index
-- refuses the second.
CREATE UNIQUE INDEX provider_accounts_one_default_per_provider
  ON provider_accounts(provider)
  WHERE is_default = 1;

-- One account per credential home, across providers: two rows on one home would share
-- credentials and spend.
CREATE UNIQUE INDEX provider_accounts_unique_credential_home
  ON provider_accounts(credential_home_path);

-- One typed name per provider, compared by its fold, where a name is present.
CREATE UNIQUE INDEX provider_accounts_unique_display_label
  ON provider_accounts(provider, display_label_folded)
  WHERE display_label_folded IS NOT NULL;

-- A typed name is renamed only on an account that carries one: an account its provider names
-- never gains one, and a pasted-token account never loses its.
CREATE TRIGGER trg_provider_accounts_display_label_kept
  BEFORE UPDATE OF display_label ON provider_accounts
  WHEN (OLD.display_label IS NULL) != (NEW.display_label IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'display_label is renamed only on an account that carries one');
END;

-- The table's rules against INSERT OR REPLACE, which deletes every row it collides with instead
-- of refusing, fires no UPDATE trigger and cascades the delete to the account's quota readings.
-- Refused before the insert: one that names an account already held, which is changed by UPDATE
-- so the rules above see it, and one that collides with another account on a unique index, which
-- REPLACE would answer by deleting that account. A plain INSERT meets the same refusal.
CREATE TRIGGER trg_provider_accounts_never_written_over
  BEFORE INSERT ON provider_accounts
  WHEN EXISTS (SELECT 1 FROM provider_accounts AS held WHERE held.account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'an account is changed by UPDATE, never written over');
END;

CREATE TRIGGER trg_provider_accounts_display_label_unique_on_replace
  BEFORE INSERT ON provider_accounts
  WHEN NEW.display_label_folded IS NOT NULL AND EXISTS (
    SELECT 1 FROM provider_accounts AS held
    WHERE held.provider = NEW.provider
      AND held.display_label_folded = NEW.display_label_folded
      AND held.account_id != NEW.account_id
  )
BEGIN
  SELECT RAISE(ABORT, 'another account of this provider holds that display_label');
END;

CREATE TRIGGER trg_provider_accounts_one_default_on_replace
  BEFORE INSERT ON provider_accounts
  WHEN NEW.is_default = 1 AND EXISTS (
    SELECT 1 FROM provider_accounts AS held
    WHERE held.provider = NEW.provider
      AND held.is_default = 1
      AND held.account_id != NEW.account_id
  )
BEGIN
  SELECT RAISE(ABORT, 'another account of this provider is the default');
END;

CREATE TRIGGER trg_provider_accounts_credential_home_on_replace
  BEFORE INSERT ON provider_accounts
  WHEN EXISTS (
    SELECT 1 FROM provider_accounts AS held
    WHERE held.credential_home_path = NEW.credential_home_path
      AND held.account_id != NEW.account_id
  )
BEGIN
  SELECT RAISE(ABORT, 'another account holds that credential_home_path');
END;

-- The newest quota reading per account, limit and window length. One provider files two windows
-- under one limit identifier while another publishes several limits sharing a window length, so
-- the key is the identifier and the length together; the label is still read from the length.
CREATE TABLE provider_account_usage_windows (
  account_id    TEXT NOT NULL
                REFERENCES provider_accounts(account_id) ON DELETE CASCADE,
  -- The provider's own identifier, verbatim and untrusted; 'default' when the reading names none.
  -- No CHECK: the provider's limit set is open.
  limit_id      TEXT NOT NULL,
  window_mins   INTEGER NOT NULL,               -- with the limit, which window the reading is
  label         TEXT,                           -- display only
  -- Not capped at 100: a provider may report over-consumption.
  used_percent  REAL NOT NULL CHECK(used_percent >= 0),
  resets_at     TEXT,                           -- NULL is unknown, never now
  -- The ordering key: the later reading is current; source breaks exact ties.
  observed_at   TEXT NOT NULL,
  -- The account's generation when read. A home rebuild keeps these rows, so this stamp marks a
  -- reading from before it stale.
  observed_credential_generation INTEGER NOT NULL CHECK(observed_credential_generation >= 1),
  -- A whole-account read, which replaces the stored set, or what the provider pushes during a
  -- turn, which is merged.
  source        TEXT NOT NULL CHECK(source IN ({reading_sources})),
  PRIMARY KEY (account_id, limit_id, window_mins)
) STRICT;
"
    )
}
