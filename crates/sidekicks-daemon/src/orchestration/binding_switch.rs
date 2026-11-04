//! What every switch of an agent's binding settles with: its fresh switch id, and the state of the
//! account a refusal of the target names.

use sidekicks_contracts::agent::provider_binding::{AgentBindingSwitchAccountState, SwitchId};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::contract::error::DriverError;

/// A fresh switch id, minted as a UUID, for a switch of an agent's binding.
pub(crate) fn mint_switch_id() -> SwitchId {
    SwitchId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a switch id")
}

/// The state a failed move's refusal names of the account: `reauthRequired` for a gone sign-in,
/// `homeMissing` for a gone home, `notRegistered` for no account registered or the one named not
/// found, and `indeterminate` for any other failure, a current account not set among them.
pub(crate) fn account_state_of(error: &DriverError) -> AgentBindingSwitchAccountState {
    let code = match error {
        DriverError::Refused(refusal) => Some(refusal.code),
        DriverError::Unanswered(_)
        | DriverError::SteerTurnEnded(_)
        | DriverError::RunRefused(_)
        | DriverError::CapabilityProbe(_)
        | DriverError::ExecutableUnresolvable(_)
        | DriverError::ModelCatalogUnreadable(_)
        | DriverError::ProviderAxisInvalid(_)
        | DriverError::RuleNotKept(_)
        | DriverError::SkillNotListed(_)
        | DriverError::NoPersonServerEntry(_)
        | DriverError::SignInFailed(_)
        | DriverError::Internal(_) => None,
    };
    match code {
        Some(RefusalCode::ProviderAccountNotAuthenticated) => {
            AgentBindingSwitchAccountState::ReauthRequired
        }
        Some(RefusalCode::ProviderAccountCredentialHomeUnavailable) => {
            AgentBindingSwitchAccountState::HomeMissing
        }
        Some(RefusalCode::ProviderAccountNotRegistered | RefusalCode::ProviderAccountNotFound) => {
            AgentBindingSwitchAccountState::NotRegistered
        }
        _ => AgentBindingSwitchAccountState::Indeterminate,
    }
}
