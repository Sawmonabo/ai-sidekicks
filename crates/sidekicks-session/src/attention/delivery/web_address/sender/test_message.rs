//! The test message the person asks for: one signed `POST` through the same path every moment's
//! message takes, with no retry and no row written.

use sidekicks_contracts::attention::{AttentionDeliveryOutcome, AttentionDeliveryTestResponse};
use sidekicks_store::machine::local::read_local_machine;
use uuid::Uuid;

use super::secrets::{WebAddressCallError, address_not_configured, store_unavailable};
use super::{WebAddressSender, outcome_of_post};
use crate::attention::delivery::web_address::message::test_message_body;
use crate::attention::delivery::web_address::post::WebAddressPost;

impl WebAddressSender {
    /// Sends one test message, `Test message from <machine>`, to the saved address and reports how
    /// it ended, with the messages given up on since the last delivery. Refuses with no address
    /// saved `attention.delivery.notConfigured`, and a keychain that could not be used
    /// `attention.delivery.storeUnavailable`.
    pub async fn test_web_address(
        &self,
    ) -> Result<AttentionDeliveryTestResponse, WebAddressCallError> {
        let held = self.lock_secrets().await;
        let secrets = self.read_secrets().await.map_err(store_unavailable)?;
        drop(held);
        let Some((address, signing_secret)) = secrets else {
            return Err(address_not_configured().into());
        };
        let machine = read_local_machine(&self.pool)
            .await?
            .ok_or(WebAddressCallError::MachineUnrecorded)?
            .name;
        let (attempted_at, at) = self.now();
        let body = test_message_body(&machine, &at);
        #[expect(
            clippy::disallowed_methods,
            reason = "a test message's id names one post and is kept in no row"
        )]
        let message_id = Uuid::now_v7().to_string();
        let outcome = outcome_of_post(
            self.poster
                .post(WebAddressPost {
                    address: &address,
                    signing_secret: &signing_secret,
                    message_id: &message_id,
                    body: &body,
                    attempted_at,
                })
                .await,
        );
        let undelivered = self.read_outcomes().await?.web_address.undelivered;
        Ok(AttentionDeliveryTestResponse {
            outcome: AttentionDeliveryOutcome {
                at,
                result: outcome.result,
                http_status: outcome.http_status,
                undelivered,
            },
        })
    }
}
