//! A workflow run's exact-value redaction: every secret value the run resolved, and the forms a
//! step is likely to write it in, masked before any of the run's writes. A whole record is scrubbed
//! in one pass; a stream holds back a carry so a value split across two writes is still masked.
//!
//! The raw value is always masked. A value of 8 characters or more also registers its derived
//! forms, each of 8 characters or more, so a short encoding does not blank unrelated text: its six
//! aligned base64 cores, its `encodeURIComponent` and form encodings, its JSON string body and each
//! line of a multi-line value. Matches are found overlapping and merged, so two secrets that
//! overlap in the text leave no piece of either showing.
//!
//! A stream holds back at most the longest form's length less one byte, plus up to three bytes of
//! a split character: a merged range reaching the cut is masked up to it at once and goes on into
//! the next push as the same mask, so a run of matches never grows the carry.

use std::borrow::Cow;
use std::ops::Range;
use std::sync::{Arc, PoisonError, RwLock};

use aho_corasick::{AhoCorasick, MatchKind};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use secrecy::{ExposeSecret, SecretString};
use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;

/// The shortest value whose derived forms are registered, and the shortest derived form kept.
const DERIVED_FORM_FLOOR: usize = 8;

/// The bytes `encodeURIComponent` leaves as they are: letters, digits and `-_.!~*'()`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// The secret values of one workflow run and the matcher built over their forms, masking each
/// before a write the run makes. Shared by every stream it makes, so a secret added mid-run reaches
/// them all.
pub struct RunRedaction {
    /// The current needle set, replaced whole when a secret is added.
    needle_set: Arc<RwLock<Arc<NeedleSet>>>,
}

/// Every needle of the run's secrets and the automaton built over them.
struct NeedleSet {
    /// The needles, deduplicated, kept so a rebuild can add to them.
    needles: Vec<SecretString>,
    /// The overlapping matcher over `needles`.
    automaton: AhoCorasick,
}

impl RunRedaction {
    /// A redaction masking each of `values`, the secrets the run resolved at its start.
    pub fn new(values: &[SecretString]) -> Self {
        let mut needles = Vec::new();
        for value in values {
            push_needles(&mut needles, value.expose_secret());
        }
        Self {
            needle_set: Arc::new(RwLock::new(Arc::new(NeedleSet::build(needles)))),
        }
    }

    /// Adds `value`, a secret resolved mid-run, rebuilding the matcher; every stream already made
    /// masks it from its next push and keeps its carry.
    pub fn add_secret(&self, value: &SecretString) {
        let mut current = self
            .needle_set
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        let mut needles: Vec<SecretString> = current
            .needles
            .iter()
            .map(|needle| SecretString::from(needle.expose_secret()))
            .collect();
        push_needles(&mut needles, value.expose_secret());
        *current = Arc::new(NeedleSet::build(needles));
    }

    /// `text`, a record written at once, with each secret form in it masked; borrowed when nothing
    /// matched.
    pub fn scrub<'text>(&self, text: &'text str) -> Cow<'text, str> {
        let ranges = current_needle_set(&self.needle_set).merged_ranges(text.as_bytes(), None);
        if ranges.is_empty() {
            return Cow::Borrowed(text);
        }
        Cow::Owned(
            String::from_utf8(masked(text.as_bytes(), &ranges, false))
                .expect("every needle is whole UTF-8 text, so a mask replaces whole characters"),
        )
    }

    /// Scrubs every string `value` holds in place, at any depth, member names included.
    pub fn scrub_json(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => {
                if let Cow::Owned(scrubbed) = self.scrub(text) {
                    *text = scrubbed;
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    self.scrub_json(value);
                }
            }
            serde_json::Value::Object(members) => {
                let renamed: Vec<(String, String)> = members
                    .keys()
                    .filter_map(|name| match self.scrub(name) {
                        Cow::Owned(scrubbed) => Some((name.clone(), scrubbed)),
                        Cow::Borrowed(_) => None,
                    })
                    .collect();
                for (name, scrubbed) in renamed {
                    if let Some(member) = members.remove(&name) {
                        members.insert(scrubbed, member);
                    }
                }
                for member in members.values_mut() {
                    self.scrub_json(member);
                }
            }
            serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            }
        }
    }

    /// A scrubber for one stream the run writes, such as a step's stdout, stderr, log or progress.
    pub fn stream(&self) -> StreamScrubber {
        StreamScrubber {
            needle_set: Arc::clone(&self.needle_set),
            carry: Vec::new(),
            masked_start: None,
        }
    }
}

/// Masks one stream of the run's output as it arrives in chunks, holding back the bytes a secret
/// split across two chunks could still be starting in.
pub struct StreamScrubber {
    /// The run's needle set, read afresh at each push.
    needle_set: Arc<RwLock<Arc<NeedleSet>>>,
    /// The bytes held back from the last push, not yet written.
    carry: Vec<u8>,
    /// How many bytes at the carry's start lie inside a mask already written, `Some(0)` when the
    /// last byte written was masked; `None` when it was not.
    masked_start: Option<usize>,
}

impl StreamScrubber {
    /// The scrubbed bytes of `chunk` and the carry before it, up to a cut held back by the longest
    /// needle less one byte and moved back to a UTF-8 character's start. A merged range reaching
    /// the cut is masked up to it and goes on as the same mask, so the carry stays within that
    /// bound.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let needle_set = current_needle_set(&self.needle_set);
        self.carry.extend_from_slice(chunk);
        let is_continuing = self.masked_start.is_some();
        let ranges = needle_set.merged_ranges(&self.carry, self.masked_start);
        let hold = needle_set.automaton.max_pattern_len().saturating_sub(1);
        let cut = character_start(&self.carry, self.carry.len().saturating_sub(hold));
        let held = self.carry.split_off(cut);
        let written = std::mem::replace(&mut self.carry, held);
        let is_reaching_cut = |range: &Range<usize>| {
            (range.start < cut || (is_continuing && range.start == 0)) && range.end >= cut
        };
        self.masked_start = ranges
            .iter()
            .find(|range| is_reaching_cut(range))
            .map(|range| range.end - cut);
        let written_ranges: Vec<Range<usize>> = ranges
            .iter()
            .filter(|range| range.start < cut)
            .map(|range| range.start..range.end.min(cut))
            .collect();
        masked(&written, &written_ranges, is_continuing)
    }

    /// The carry, scrubbed, at the end of the stream.
    pub fn finish(self) -> Vec<u8> {
        let ranges =
            current_needle_set(&self.needle_set).merged_ranges(&self.carry, self.masked_start);
        masked(&self.carry, &ranges, self.masked_start.is_some())
    }
}

impl NeedleSet {
    /// The set over `needles`.
    fn build(needles: Vec<SecretString>) -> Self {
        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::Standard)
            .build(
                needles
                    .iter()
                    .map(|needle| needle.expose_secret().as_bytes()),
            )
            .expect("a run's secret forms stay far under the matcher's pattern and state limits");
        Self { needles, automaton }
    }

    /// Every match in `haystack`, overlapping ones included, and the first `masked_start` bytes
    /// where a mask already covers them, sorted and merged where they overlap or touch, so each
    /// merged range takes one mask.
    fn merged_ranges(&self, haystack: &[u8], masked_start: Option<usize>) -> Vec<Range<usize>> {
        let mut matches: Vec<Range<usize>> = self
            .automaton
            .find_overlapping_iter(haystack)
            .map(|found| found.range())
            .chain(masked_start.map(|end| 0..end))
            .collect();
        matches.sort_unstable_by_key(|range| (range.start, range.end));
        let mut merged: Vec<Range<usize>> = Vec::with_capacity(matches.len());
        for range in matches {
            match merged.last_mut() {
                Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
                Some(_) | None => merged.push(range),
            }
        }
        merged
    }
}

/// The needle set `shared` holds now; a poisoned lock still holds a whole set, since a writer only
/// swaps one in.
fn current_needle_set(shared: &RwLock<Arc<NeedleSet>>) -> Arc<NeedleSet> {
    Arc::clone(&shared.read().unwrap_or_else(PoisonError::into_inner))
}

/// `bytes` with each of `ranges`, sorted and apart, replaced by one mask; a first range at the
/// start goes on a mask already written when `is_continuing`, so it writes nothing.
fn masked(bytes: &[u8], ranges: &[Range<usize>], is_continuing: bool) -> Vec<u8> {
    let mut scrubbed = Vec::with_capacity(bytes.len());
    let mut position = 0;
    for range in ranges {
        scrubbed.extend_from_slice(&bytes[position..range.start]);
        if !(is_continuing && range.start == 0) {
            scrubbed.extend_from_slice(CREDENTIAL_REDACTION.as_bytes());
        }
        position = range.end;
    }
    scrubbed.extend_from_slice(&bytes[position..]);
    scrubbed
}

/// `cut` moved back to the start of the UTF-8 character it falls inside, at most three bytes, so
/// output that is not UTF-8 never walks it further.
fn character_start(bytes: &[u8], cut: usize) -> usize {
    let mut start = cut;
    while start > 0
        && cut - start < 3
        && bytes
            .get(start)
            .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
    {
        start -= 1;
    }
    start
}

/// Adds the needles of `value` to `needles`, skipping an empty one and any already there.
fn push_needles(needles: &mut Vec<SecretString>, value: &str) {
    let mut add = |needle: String| {
        if !needle.is_empty() && needles.iter().all(|kept| kept.expose_secret() != needle) {
            needles.push(SecretString::from(needle));
        }
    };
    add(value.to_owned());
    if value.chars().count() < DERIVED_FORM_FLOOR {
        return;
    }
    let mut derived = Vec::new();
    let bytes = value.as_bytes();
    // Base64 encodes 3-byte groups from its input's start, so wherever the value sits in the
    // encoded text, one of these cores appears whole in it.
    for offset in 0..3 {
        let tail = &bytes[offset..];
        let aligned = &tail[..tail.len() - tail.len() % 3];
        derived.push(STANDARD_NO_PAD.encode(aligned));
        derived.push(URL_SAFE_NO_PAD.encode(aligned));
    }
    derived.push(utf8_percent_encode(value, URI_COMPONENT).to_string());
    derived.push(form_urlencoded::byte_serialize(bytes).collect());
    let quoted = serde_json::Value::String(value.to_owned()).to_string();
    derived.push(quoted[1..quoted.len() - 1].to_owned());
    if value.contains('\n') {
        derived.extend(value.lines().map(str::to_owned));
    }
    for form in derived {
        if form.chars().count() >= DERIVED_FORM_FLOOR {
            add(form);
        }
    }
}

#[cfg(test)]
mod tests;
