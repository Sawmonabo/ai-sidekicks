//! Provider accounts, naming no provider: the registry of the accounts this machine runs providers
//! on, with each account's minted identity, its current-account mark, its generation and stored
//! health, the credential home the daemon makes for each under its data folder and its reset, the
//! folders in every home that a backup keeps and the diagnostic expiry sweeps, and the usage turns
//! the daemon keeps per account.

pub mod credential_home;
pub mod errors;
pub mod homes;
pub mod registry;
pub mod usage_turns;
