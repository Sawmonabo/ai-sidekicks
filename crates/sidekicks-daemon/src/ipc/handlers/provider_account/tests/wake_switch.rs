//! The wake switch on `provider.account.update`: the helper installed with the first switch on and
//! removed with the last switch off, each reply naming the helper's state.

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::account::methods::{
    ProviderAccountUpdate, ProviderAccountUpdateResponse, ProviderWakeHelperState,
};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::WakeHelperStatus;
use sidekicks_provider::account::wake_helper::{ScriptedWakeHelper, WakeHelperCall};

use super::MethodInputs;
use crate::ipc::handlers::provider_account::registration::WAKE_HELPER_REMOVED_REASON;

impl MethodInputs {
    // Turns `account_id`'s wake switch to `is_on`.
    async fn switch_wake(
        &self,
        account_id: &ProviderAccountId,
        is_on: bool,
    ) -> ProviderAccountUpdateResponse {
        self.call(
            ProviderAccountUpdate::DESCRIPTOR.method,
            &json!({ "accountId": account_id.as_str(), "wakeForWindowStartEnabled": is_on }),
        )
        .await
    }
}

// A wake switch turned on whose install the person refuses stays off, in the reply and the stored
// row, and the reply names why. Killed by the refusal dropped, where the switch is stored on with
// no helper to wake the computer.
#[tokio::test]
async fn a_refused_install_leaves_the_wake_switch_off_and_says_why() {
    let helper = Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Missing));
    helper.refuse_installs();
    let inputs = MethodInputs::new(Arc::clone(&helper)).await;
    let account_id = inputs
        .register_token_account()
        .await
        .account
        .account_id()
        .clone();

    let updated = inputs.switch_wake(&account_id, true).await;

    assert!(matches!(
        updated.wake_helper,
        Some(ProviderWakeHelperState::NotInstalled { .. })
    ));
    assert_eq!(helper.calls(), [WakeHelperCall::Install]);
    let stored = inputs
        .accounts
        .read(account_id)
        .await
        .expect("the account reads");
    assert!(!stored.wake_for_window_start_enabled);
}

// The last wake switch turned off removes the helper and the reply says why it is gone. Killed by
// the removal's reason missing, where the reply reads the helper as still installed.
#[tokio::test]
async fn the_last_wake_switch_off_removes_the_helper_with_its_reason() {
    let helper = Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::Installed));
    let inputs = MethodInputs::new(Arc::clone(&helper)).await;
    let account_id = inputs
        .register_token_account()
        .await
        .account
        .account_id()
        .clone();
    let turned_on = inputs.switch_wake(&account_id, true).await;
    assert_eq!(
        turned_on.wake_helper,
        Some(ProviderWakeHelperState::Installed {})
    );

    let turned_off = inputs.switch_wake(&account_id, false).await;

    let Some(ProviderWakeHelperState::NotInstalled { reason }) = turned_off.wake_helper else {
        panic!("the helper reads as removed");
    };
    assert_eq!(reason.as_str(), WAKE_HELPER_REMOVED_REASON);
    assert_eq!(helper.calls(), [WakeHelperCall::Uninstall]);
}
