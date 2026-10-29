//! Provider accounts: the registry of the accounts this machine runs providers on, with each
//! account's minted identity, its current-account mark, its generation and stored health, and the
//! credential home the daemon makes for each under its data folder.

pub mod credential_home;
pub mod errors;
pub mod registry;
