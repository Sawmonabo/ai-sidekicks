//! A Codex session's context reading: the usable window, the last request's totals against it and
//! the compaction stops. A usage report of the session's own conversation gives the window and
//! the totals; before the first report, and again whenever the session's model or window changes,
//! the reading carries no usage and its window comes from Codex's catalog. The top stop is where
//! Codex compacts, the limit the calibration measured, else Codex's own default point; the bottom
//! stop is the session's fixed start, its conversation's first request's input, plus a tenth of
//! the window, unknown on a conversation whose start this daemon run did not see.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::{
    SessionCompactionBound, SessionContextBreakdown, SessionContextReading, SessionContextUsage,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::lifecycle::CodexDriverParts;
use crate::driver::codex::model_windows::{
    CODEX_DEFAULT_COMPACTION_PERCENT, CODEX_DEFAULT_USABLE_PERCENT, CodexModelWindows,
};
use crate::driver::codex::notification_routing::CodexContextWindowReading;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::context_window::{BOTTOM_STOP_HEADROOM_PERCENT, share_percent};
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::usage_delta_accountant::WindowTelemetry;

/// What a context reading is composed from beyond its window and usage, in tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CodexContextStops {
    /// Where Codex compacts: the calibrated limit, else the catalog's default point, `None` while
    /// neither is known.
    compaction_limit_tokens: Option<u64>,
    /// The session's fixed start, `None` while it is unknown.
    fixed_start_tokens: Option<u64>,
}

/// The model and chosen window a reading is composed for.
#[derive(Clone, Debug, PartialEq, Eq)]
struct CodexReadingSettings {
    model: String,
    requested_window: Option<u64>,
}

impl CodexReadingSettings {
    fn of(record: &CodexSessionRecord) -> Self {
        Self {
            model: record.thread_settings.model.clone(),
            requested_window: record.thread_settings.model_context_window,
        }
    }
}

/// One session's context readings, published on its task: from each usage report, and with no
/// usage at its start and on each change of its model or window.
pub(crate) struct CodexSessionContextReadings {
    session_id: SessionId,
    fixed_start_tokens: Option<u64>,
    // The model and window the last reading was composed for.
    published_for: Option<CodexReadingSettings>,
    // How many readings were published, so a reading composed off the session's task is dropped
    // once another was published after it began.
    published: Arc<Mutex<u64>>,
}

impl CodexSessionContextReadings {
    /// No reading published yet for `session_id`.
    pub(crate) fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            fixed_start_tokens: None,
            published_for: None,
            published: Arc::default(),
        }
    }

    /// Publishes the reading of one usage report of the session's own conversation, whose
    /// conversation's first request also sets the fixed start.
    pub(crate) fn publish_report(
        &mut self,
        parts: &CodexDriverParts,
        record: &CodexSessionRecord,
        reading: &CodexContextWindowReading,
    ) {
        self.note_fixed_start(reading);
        let settings = CodexReadingSettings::of(record);
        // Before the reading's owner registers there is no one to tell.
        let Some(publisher) = parts.ports.context_readings.port().map(Arc::clone) else {
            self.published_for = Some(settings);
            return;
        };
        let windows = parts.model_windows.cached(&record.service);
        let stops = CodexContextStops {
            compaction_limit_tokens: read_compaction_limit(
                parts,
                record,
                &settings,
                windows.as_deref(),
            ),
            fixed_start_tokens: self.fixed_start_tokens,
        };
        self.published_for = Some(settings);
        if let Some(composed) = compose_report_reading(self.session_id, reading, stops) {
            publish_counted(&self.published, None, publisher.as_ref(), composed);
        }
    }

    // Takes the fixed start from the conversation's first request, never from a later one.
    fn note_fixed_start(&mut self, reading: &CodexContextWindowReading) {
        if reading.is_conversation_start {
            self.fixed_start_tokens = self.fixed_start_tokens.or(reading.breakdown.input);
        }
    }

    /// Publishes a reading with no usage when the session's model or window is not the one its
    /// last reading was composed for, its window read from the service's catalog off the
    /// session's task where none is kept yet.
    pub(crate) fn publish_settings_change(
        &mut self,
        parts: &CodexDriverParts,
        record: &CodexSessionRecord,
    ) {
        let settings = CodexReadingSettings::of(record);
        if self.published_for.as_ref() == Some(&settings) {
            return;
        }
        self.published_for = Some(settings.clone());
        let Some(publisher) = parts.ports.context_readings.port().map(Arc::clone) else {
            return;
        };
        let calibrated = parts.compaction_limits.limit(
            &record.service,
            &settings.model,
            settings.requested_window,
        );
        let session_id = self.session_id;
        let fixed_start_tokens = self.fixed_start_tokens;
        let compose = move |windows: &CodexModelWindows| {
            compose_settings_reading(
                session_id,
                windows,
                &settings,
                calibrated,
                fixed_start_tokens,
            )
        };
        if let Some(windows) = parts.model_windows.cached(&record.service) {
            if let Some(composed) = compose(&windows) {
                publish_counted(&self.published, None, publisher.as_ref(), composed);
            }
            return;
        }
        let published_before = *lock(&self.published);
        let published = Arc::clone(&self.published);
        let model_windows = Arc::clone(&parts.model_windows);
        let service = Arc::clone(&record.service);
        parts.tasks.spawn(async move {
            let windows = model_windows.read(&service).await;
            if let Some(composed) = compose(&windows) {
                publish_counted(
                    &published,
                    Some(published_before),
                    publisher.as_ref(),
                    composed,
                );
            }
        });
    }
}

// Where Codex compacts the session: the limit calibrated for its build, model and window, else
// the catalog's default point.
fn read_compaction_limit(
    parts: &CodexDriverParts,
    record: &CodexSessionRecord,
    settings: &CodexReadingSettings,
    windows: Option<&CodexModelWindows>,
) -> Option<u64> {
    parts
        .compaction_limits
        .limit(&record.service, &settings.model, settings.requested_window)
        .or_else(|| {
            windows?
                .get(&settings.model)?
                .default_compaction_limit(settings.requested_window)
        })
}

// Publishes `reading` and counts it, unless `published_before` is given and a reading was
// published since, which `reading` would otherwise replace with an older view.
fn publish_counted(
    published: &Mutex<u64>,
    published_before: Option<u64>,
    publisher: &dyn ContextReadingPublisher,
    reading: SessionContextReading,
) {
    let mut published = lock(published);
    if published_before.is_some_and(|before| before != *published) {
        return;
    }
    *published += 1;
    publisher.publish_context_reading(reading);
}

// The reading of one usage report, `None` for a report that names no window.
fn compose_report_reading(
    session_id: SessionId,
    reading: &CodexContextWindowReading,
    stops: CodexContextStops,
) -> Option<SessionContextReading> {
    let WindowTelemetry::Counted {
        window_used_tokens,
        window_max_tokens,
        ..
    } = reading.window
    else {
        return None;
    };
    let breakdown = reading.breakdown;
    let count = |tokens: Option<u64>| SafeInt::<0>::new(tokens.unwrap_or(0));
    let usage = SessionContextUsage {
        used_tokens: SafeInt::new(window_used_tokens)?,
        used_percent: Percent::new(share_percent(window_used_tokens, window_max_tokens))?,
        breakdown: SessionContextBreakdown::Totals {
            cached_input_tokens: count(breakdown.cached_input)?,
            input_tokens: count(breakdown.input)?,
            output_tokens: count(breakdown.output)?,
            reasoning_tokens: count(breakdown.reasoning_output)?,
        },
    };
    compose_context_reading(session_id, window_max_tokens, stops, Some(usage))
}

// The reading with no usage of a session on `settings`' model and window, its usable window and
// default point from `windows`; `None` for a model the catalog gives no window.
fn compose_settings_reading(
    session_id: SessionId,
    windows: &CodexModelWindows,
    settings: &CodexReadingSettings,
    calibrated_limit_tokens: Option<u64>,
    fixed_start_tokens: Option<u64>,
) -> Option<SessionContextReading> {
    let window = windows.get(&settings.model)?;
    let usable_window = window.usable_window(settings.requested_window)?;
    let stops = CodexContextStops {
        compaction_limit_tokens: calibrated_limit_tokens
            .or_else(|| window.default_compaction_limit(settings.requested_window)),
        fixed_start_tokens,
    };
    compose_context_reading(session_id, usable_window, stops, None)
}

// The reading against the usable window `window_tokens`. The session's own bound follows the top
// stop and is never its own.
fn compose_context_reading(
    session_id: SessionId,
    window_tokens: u64,
    stops: CodexContextStops,
    usage: Option<SessionContextUsage>,
) -> Option<SessionContextReading> {
    // Codex's default point as a share of the usable window, where the catalog is not known.
    #[expect(
        clippy::cast_precision_loss,
        reason = "both percents are at most 100, which an f64 holds exactly"
    )]
    let default_top_stop =
        CODEX_DEFAULT_COMPACTION_PERCENT as f64 * 100.0 / CODEX_DEFAULT_USABLE_PERCENT as f64;
    let top_stop = stops
        .compaction_limit_tokens
        .map_or(default_top_stop.min(100.0), |limit| {
            share_percent(limit, window_tokens)
        });
    let top_stop_percent = Percent::new(top_stop)?;
    let bottom_stop_percent = stops.fixed_start_tokens.and_then(|fixed_start| {
        let bottom = (share_percent(fixed_start, window_tokens) + BOTTOM_STOP_HEADROOM_PERCENT)
            .ceil()
            .min(top_stop);
        Percent::new(bottom)
    });
    Some(SessionContextReading {
        session_id,
        window_tokens: SafeInt::<1>::new(window_tokens)?,
        compaction: SessionCompactionBound {
            bound_percent: top_stop_percent,
            top_stop_percent,
            bottom_stop_percent,
            session_override: false,
        },
        usage,
    })
}

#[cfg(test)]
mod tests;
