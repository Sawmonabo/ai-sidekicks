//! The usage record's priced requests: one cost per account, written together, each naming its
//! rows and the run and helper they agree on.

use serde_json::{Value, json};
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::port::usage_sink::{
    MeteredUsageOwner, PricedRequest, PricedUsageRow, RecordedUsage, UsageSink,
};

use super::{ACCOUNT, Harness, MODEL, RECORDED, account};
use crate::run::inbound::InboundDispatchError;
use crate::usage_record::UsageRecordError;

impl Harness {
    // `rows` priced at the test's model from the price list's exact rates.
    fn priced_request(&self, rows: Vec<PricedUsageRow>) -> PricedRequest {
        PricedRequest {
            session_id: self.session_id,
            model_id: FreeFormText::new(MODEL.to_owned()).expect("the test's model is an id"),
            cost_source: UsageCostSource::DerivedExact,
            rows,
        }
    }

    // The `usage.cost.updated` payload of a request at `total` micro-dollars charged to `run_id`
    // and `helper` where each is named, naming each of `priced_events`' ids at its figure.
    fn cost_payload(
        &self,
        run_id: Option<RunId>,
        helper: Option<&str>,
        total: u64,
        priced_events: &[(&str, u64)],
    ) -> Value {
        let mut payload = json!({
            "sessionId": self.session_id.text().as_str(),
            "costUsdMicros": total,
            "modelId": MODEL,
            "costSource": "derivedExact",
            "pricedEvents": priced_events
                .iter()
                .map(|(event_id, figure)| json!({"eventId": event_id, "costUsdMicros": figure}))
                .collect::<Vec<_>>(),
        });
        if let Some(run_id) = run_id {
            payload["runId"] = json!(run_id.text().as_str());
        }
        if let Some(helper) = helper {
            payload["subagentId"] = json!(helper);
        }
        payload
    }
}

const COST: &str = "usage.cost.updated";

// A token row on `account_id`'s account charged to `run_id`, which the record never wrote.
fn hand_built_row(run_id: RunId, account_id: &str) -> RecordedUsage {
    RecordedUsage {
        event_id: FreeFormText::new(mint_uuid_v7().to_string())
            .expect("a minted UUID is an event id"),
        run_id: Some(run_id),
        provider_account_id: ProviderAccountId::new(account_id.to_owned())
            .expect("the test's account id is one"),
        subagent_id: None,
    }
}

// `row`'s share of a priced request: `figure` micro-dollars.
fn priced(row: RecordedUsage, figure: u64) -> PricedUsageRow {
    PricedUsageRow {
        row,
        cost_usd_micros: UsdMicros(SafeInt::new(figure).expect("a test figure is a safe integer")),
    }
}

// Each answer names the event its reading became, and a request whose rows sit on two accounts
// writes one cost per account, each naming its own rows and their sum, and the run and the helper
// only where all its rows agree. Killed by an id minted in the record rather than taken from the
// dispatch's outcome (the answers would name no stored event), by one event across the accounts
// (one event of 18), by the first figure taken as the total (account-1's would read 6), by the
// first row's run or helper kept (account-2's run, account-1's helper), and by a disagreement on
// one dropping both (account-2's helper).
#[tokio::test]
async fn a_request_priced_across_two_accounts_writes_one_cost_per_account_naming_its_rows() {
    let harness = Harness::new(None, true).await;
    let mut written = Vec::new();
    for _ in 0..2 {
        written.push(
            harness
                .record(MeteredUsageOwner::Run, None, 10, 5, 0)
                .await
                .expect("the lead's reading is recorded")
                .expect("the reading's row is written"),
        );
    }
    let lead = Some(harness.lead_run_id.text().as_str().to_owned());
    let tokens = harness.stored_events(RECORDED);
    let account_1 = account();
    assert_eq!(
        written
            .iter()
            .map(|row| (row.event_id.as_str(), row.run_id, &row.provider_account_id))
            .collect::<Vec<_>>(),
        tokens
            .iter()
            .map(|(id, _, _)| (id.as_str(), Some(harness.lead_run_id), &account_1))
            .collect::<Vec<_>>()
    );
    let helper = SubagentId::new("helper-1".to_owned()).expect("a helper id");
    let helpers_row = RecordedUsage {
        subagent_id: Some(helper.clone()),
        ..written[0].clone()
    };
    let elsewhere = RecordedUsage {
        subagent_id: Some(helper.clone()),
        ..hand_built_row(harness.lead_run_id, "account-2")
    };
    let side_question = RecordedUsage {
        run_id: None,
        subagent_id: Some(helper),
        ..hand_built_row(harness.lead_run_id, "account-2")
    };

    harness
        .record
        .record_cost(harness.priced_request(vec![
            priced(helpers_row, 6),
            priced(elsewhere.clone(), 4),
            priced(written[1].clone(), 5),
            priced(side_question.clone(), 3),
        ]))
        .await
        .expect("the request's cost is recorded");

    assert_eq!(
        harness
            .stored_events(COST)
            .into_iter()
            .map(|(_, run_id, payload)| (run_id, payload))
            .collect::<Vec<_>>(),
        vec![
            (
                lead,
                harness.cost_payload(
                    Some(harness.lead_run_id),
                    None,
                    11,
                    &[
                        (written[0].event_id.as_str(), 6),
                        (written[1].event_id.as_str(), 5)
                    ]
                )
            ),
            (
                None,
                harness.cost_payload(
                    None,
                    Some("helper-1"),
                    7,
                    &[
                        (elsewhere.event_id.as_str(), 4),
                        (side_question.event_id.as_str(), 3)
                    ]
                )
            ),
        ]
    );
}

// A request priced after its run's binding closed is still recorded, on the session. Killed by the
// cost routed through the binding's cursor, which fails with none open.
#[tokio::test]
async fn a_cost_is_recorded_with_the_bindings_cursor_closed() {
    let harness = Harness::new(None, false).await;
    let row = hand_built_row(harness.lead_run_id, ACCOUNT);

    harness
        .record
        .record_cost(harness.priced_request(vec![priced(row.clone(), 7)]))
        .await
        .expect("the cost is recorded with no cursor open");

    assert_eq!(
        harness
            .stored_events(COST)
            .into_iter()
            .map(|(_, run_id, payload)| (run_id, payload))
            .collect::<Vec<_>>(),
        vec![(
            Some(harness.lead_run_id.text().as_str().to_owned()),
            harness.cost_payload(
                Some(harness.lead_run_id),
                None,
                7,
                &[(row.event_id.as_str(), 7)]
            )
        )]
    );
}

// A request whose second account's cost cannot be written keeps neither account's. Killed by one
// append per account: account-1's cost of 7 would stay written.
#[tokio::test]
async fn a_request_whose_second_cost_is_refused_writes_no_cost() {
    let harness = Harness::new(None, true).await;
    harness
        .database
        .reader()
        .execute_batch(
            "CREATE TRIGGER refuse_second_cost BEFORE INSERT ON session_events
             WHEN NEW.type = 'usage.cost.updated'
               AND json_extract(NEW.payload, '$.costUsdMicros') = 4
             BEGIN SELECT RAISE(ABORT, 'the test refuses the second cost'); END",
        )
        .expect("the test refuses account-2's cost");

    let failure = harness
        .record
        .record_cost(harness.priced_request(vec![
            priced(hand_built_row(harness.lead_run_id, ACCOUNT), 7),
            priced(hand_built_row(harness.lead_run_id, "account-2"), 4),
        ]))
        .await
        .expect_err("a refused cost fails the request");

    assert!(matches!(
        failure.downcast_ref::<UsageRecordError>(),
        Some(UsageRecordError::Dispatch(InboundDispatchError::Append(_)))
    ));
    assert_eq!(harness.stored_events(COST), []);
}
