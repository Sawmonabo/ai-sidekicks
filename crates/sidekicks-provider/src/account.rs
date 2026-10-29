//! Provider accounts, naming no provider: the registry of the accounts this machine runs providers
//! on, with each account's minted identity, its current-account mark, its generation and stored
//! health, the credential home the daemon makes for each under its data folder, each provider's
//! readiness derived from those rows, the custody of each pasted token, and the usage turns the
//! daemon keeps per account.

pub mod credential_home;
pub mod errors;
pub mod readiness;
pub mod registry;
pub mod token_custody;
pub mod usage_turns;
