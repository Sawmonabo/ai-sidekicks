//! The test message the person asks for: one signed `POST` through the same path every moment's
//! message takes, with no retry and no row written. While the switch reads off before the post, the
//! client it built goes after it.

use std::error::Error;

use bytes::Bytes;
use sidekicks_contracts::attention::{
    AttentionDeliveryOutcome, AttentionDeliveryStoreUnavailableDetails,
    AttentionDeliveryTestResponse,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_store::machine::local::read_local_machine;
use uuid::Uuid;

use super::secrets::{WebAddressCallError, address_not_configured, store_unavailable};
use super::{SecretsReadError, WebAddressSender, end_of_post};
use crate::attention::delivery::web_address::message::test_message_body;
use crate::attention::delivery::web_address::post::WebAddressPost;

impl WebAddressSender {
    /// Sends one test message, `Test message from <machine>`, to the saved address and reports how
    /// it ended, with the messages given up on since the last delivery. Refuses with no address
    /// saved `attention.delivery.notConfigured`, and a keychain that could not be used, or an
    /// address saved with no signing secret, `attention.delivery.storeUnavailable` with its cause.
    pub async fn test_web_address(
        &self,
    ) -> Result<AttentionDeliveryTestResponse, WebAddressCallError> {
        let held = self.lock_secrets().await;
        let secrets = self.read_secrets().await.map_err(|unread| {
            let cause = unread.cause();
            match unread {
                SecretsReadError::Refused(refusal) => store_unavailable(refusal),
                // The line the test send settles with.
                SecretsReadError::SigningSecretMissing => DomainError::new(
                    "Nothing was sent: the signing secret is missing. Make a new secret.",
                    RefusalCode::AttentionDeliveryStoreUnavailable,
                )
                .with_detail(AttentionDeliveryStoreUnavailableDetails { cause }),
            }
        })?;
        drop(held);
        let Some((address, signing_secret)) = secrets else {
            return Err(address_not_configured().into());
        };
        let machine = read_local_machine(&self.pool)
            .await?
            .ok_or(WebAddressCallError::MachineUnrecorded)?
            .name;
        let (attempted_at, at) = self.now();
        let body = Bytes::from(test_message_body(&machine, &at));
        #[expect(
            clippy::disallowed_methods,
            reason = "a test message's id names one post and is kept in no row"
        )]
        let message_id = Uuid::now_v7().to_string();
        // Read before the post, so the post's outcome is the answer whatever the read does.
        let is_switched_on = self.is_switched_on().await;
        let end = end_of_post(
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
        match is_switched_on {
            Ok(true) => {}
            // No pass releases the client while the switch stays off.
            Ok(false) => self.poster.release(),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the machine's settings did not read for a test message, so its client goes"
                );
                self.poster.release();
            }
        }
        let undelivered = self.read_outcomes().await?.web_address.undelivered;
        Ok(AttentionDeliveryTestResponse {
            outcome: AttentionDeliveryOutcome {
                at,
                result: end.outcome.result,
                cause: end.cause,
                http_status: end.outcome.http_status,
                undelivered,
            },
        })
    }
}
