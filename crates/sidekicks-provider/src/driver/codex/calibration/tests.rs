use std::collections::HashMap;
use std::sync::Arc;

use super::{CodexLimitKey, CodexLimitState, list_catalog_keys, select_due_limits};
use crate::driver::codex::calibration::measurement::CodexCalibrationRequest;
use crate::driver::codex::model_windows::{CodexCatalogReading, CodexModelWindow};

const VERSION: &str = "codex-cli 0.163.0";

fn key(model_id: &str, requested_window: Option<u64>) -> CodexLimitKey {
    CodexLimitKey {
        provider_version: VERSION.to_owned(),
        request: CodexCalibrationRequest {
            model_id: model_id.to_owned(),
            requested_window,
        },
    }
}

fn window(context_window: u64, max_context_window: u64) -> CodexModelWindow {
    CodexModelWindow {
        context_window: Some(context_window),
        max_context_window: Some(max_context_window),
        usable_percent: 95,
        auto_compact_token_limit: None,
    }
}

// A catalog read settles every listed model's default window and its larger one where it offers
// one: on the same catalog only what is not known yet or failed, and every one once the catalog
// changed.
#[test]
fn a_catalog_read_settles_what_is_unknown_and_everything_once_the_catalog_changed() {
    let catalog = CodexCatalogReading {
        dump: Arc::from("{}"),
        windows: Arc::new(HashMap::from([
            ("gpt-5.5".to_owned(), window(272_000, 1_000_000)),
            ("gpt-5.4".to_owned(), window(272_000, 272_000)),
        ])),
    };
    let mut keys = list_catalog_keys(VERSION, &catalog);
    keys.sort_by_key(|key| (key.request.model_id.clone(), key.request.requested_window));
    assert_eq!(
        keys,
        [
            key("gpt-5.4", None),
            key("gpt-5.5", None),
            key("gpt-5.5", Some(1_000_000)),
        ]
    );

    let limits = HashMap::from([
        (key("gpt-5.4", None), CodexLimitState::Known(244_800)),
        (key("gpt-5.5", None), CodexLimitState::Unknown),
        (key("gpt-5.5", Some(1_000_000)), CodexLimitState::Pending),
    ]);
    assert_eq!(
        select_due_limits(&limits, keys.clone(), false),
        [key("gpt-5.5", None)],
        "only the failed limit is tried again on the same catalog"
    );
    assert_eq!(select_due_limits(&limits, keys.clone(), true), keys);
}
