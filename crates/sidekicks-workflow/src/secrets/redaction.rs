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
//!
//! In a JSON value a number is read as its text, so a digit-only secret such as a PIN is masked
//! there too: a number whose text holds a secret becomes that text masked, a string.

use std::borrow::Cow;
use std::ops::Range;
use std::sync::{Arc, RwLock};

use aho_corasick::{AhoCorasick, MatchKind};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use secrecy::{ExposeSecret, SecretString};
use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;
use sidekicks_std::mutex_lock::{read, write};

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
        let mut current = write(&self.needle_set);
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

    /// Scrubs every string `value` holds in place, at any depth, member names included; a number
    /// whose text holds a secret becomes the masked text.
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
                let moved: Vec<(String, serde_json::Value)> = renamed
                    .into_iter()
                    .filter_map(|(name, scrubbed)| {
                        members.remove(&name).map(|member| (scrubbed, member))
                    })
                    .collect();
                for (scrubbed, member) in moved {
                    let name = free_member_name(members, scrubbed);
                    members.insert(name, member);
                }
                for member in members.values_mut() {
                    self.scrub_json(member);
                }
            }
            serde_json::Value::Number(number) => {
                if let Cow::Owned(scrubbed) = self.scrub(&number.to_string()) {
                    *value = serde_json::Value::String(scrubbed);
                }
            }
            serde_json::Value::Null | serde_json::Value::Bool(_) => {}
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

/// `name`, or when `members` holds it already, the first of `name (2)`, `name (3)` and on that it
/// does not, so two names masked alike keep both their members.
fn free_member_name(members: &serde_json::Map<String, serde_json::Value>, name: String) -> String {
    if !members.contains_key(&name) {
        return name;
    }
    (2..=members.len() + 1)
        .map(|number| format!("{name} ({number})"))
        .find(|candidate| !members.contains_key(candidate))
        .expect("the map holds `name` itself, so at most all but one candidate is taken")
}

/// The needle set `shared` holds now; a poisoned lock still holds a whole set, since a writer only
/// swaps one in.
fn current_needle_set(shared: &RwLock<Arc<NeedleSet>>) -> Arc<NeedleSet> {
    Arc::clone(&read(shared))
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
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE};
    use secrecy::SecretString;
    use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;

    use super::RunRedaction;

    /// A canary whose forms all differ: a space, quotes, `/` and `+` change its URI, form and JSON
    /// forms, and its run of `~` puts `+` in its standard base64 and `-` in its URL-safe base64.
    const CANARY: &str = "pass \"word\"/x+~~~~~~~~~";

    /// A redaction over `values`.
    fn redaction_of(values: &[&str]) -> RunRedaction {
        let secrets: Vec<SecretString> = values
            .iter()
            .map(|value| SecretString::from(*value))
            .collect();
        RunRedaction::new(&secrets)
    }

    /// Every piece `chunks` writes through one stream of `redaction`, its finish last.
    fn streamed(redaction: &RunRedaction, chunks: &[&[u8]]) -> Vec<Vec<u8>> {
        let mut stream = redaction.stream();
        let mut pieces: Vec<Vec<u8>> = chunks.iter().map(|chunk| stream.push(chunk)).collect();
        pieces.push(stream.finish());
        pieces
    }

    #[test]
    fn a_canary_in_each_form_reaches_no_output() {
        let redaction = redaction_of(&[CANARY, "first-line-of-two\nsecond-line-of-two"]);
        let forms = [
            CANARY,
            "pass%20%22word%22%2Fx%2B~~~~~~~~~",
            "pass+%22word%22%2Fx%2B%7E%7E%7E%7E%7E%7E%7E%7E%7E",
            "pass \\\"word\\\"/x+~~~~~~~~~",
            "second-line-of-two",
        ];
        for form in forms {
            assert_eq!(
                redaction.scrub(&format!("before {form} after")),
                format!("before {CREDENTIAL_REDACTION} after"),
                "the form {form:?} was written",
            );
        }
        // A prefix of 0, 1 or 2 bytes puts the canary's aligned core at 0, 2 or 1 bytes into it.
        for (prefix, core_start) in [("", 0), ("u", 2), ("us", 1)] {
            for engine in [&STANDARD, &URL_SAFE] {
                let encoded = engine.encode(format!("{prefix}{CANARY}@host"));
                let tail = &CANARY.as_bytes()[core_start..];
                let core = engine.encode(&tail[..tail.len() - tail.len() % 3]);
                let scrubbed = redaction.scrub(&encoded);
                assert!(
                    scrubbed.contains(CREDENTIAL_REDACTION) && !scrubbed.contains(&core),
                    "the base64 of {prefix:?} and the canary was written: {scrubbed}",
                );
            }
        }
    }

    /// A digit-only secret is masked in a JSON number as in a string, and a number holding none
    /// stays a number. Mutation: pass numbers through.
    #[test]
    fn a_json_value_is_masked_in_its_numbers_too() {
        let redaction = redaction_of(&["4821"]);
        let mut value =
            serde_json::json!({ "pin": 4821, "code": 948_217, "count": 3, "note": "4821" });

        redaction.scrub_json(&mut value);

        assert_eq!(
            value,
            serde_json::json!({
                "pin": CREDENTIAL_REDACTION,
                "code": format!("9{CREDENTIAL_REDACTION}7"),
                "count": 3,
                "note": CREDENTIAL_REDACTION,
            })
        );
    }

    /// Two member names that mask to the same text both keep their members. Mutation: insert
    /// the masked name over the member already holding it.
    #[test]
    fn two_member_names_masked_alike_keep_both_members() {
        let redaction = redaction_of(&["alpha-key", "omega-key"]);
        let mut value = serde_json::json!({ "alpha-key": 1, "omega-key": 2, "plain": 3 });

        redaction.scrub_json(&mut value);

        let serde_json::Value::Object(members) = value else {
            panic!("an object stays an object");
        };
        let mut kept: Vec<(String, serde_json::Value)> = members.into_iter().collect();
        kept.sort_by_key(|(_, member)| member.as_u64());
        assert_eq!(
            kept.iter()
                .map(|(_, member)| member.clone())
                .collect::<Vec<_>>(),
            [
                serde_json::json!(1),
                serde_json::json!(2),
                serde_json::json!(3)
            ]
        );
        assert!(
            kept[..2]
                .iter()
                .all(|(name, _)| name.starts_with(CREDENTIAL_REDACTION))
        );
    }

    #[test]
    fn overlapping_secrets_take_one_mask_with_nothing_of_either_left() {
        let redaction = redaction_of(&["abcd", "cdef"]);

        assert_eq!(
            redaction.scrub("xabcdefy"),
            format!("x{CREDENTIAL_REDACTION}y")
        );
    }

    #[test]
    fn a_secret_split_across_two_pushes_is_masked_at_every_cut() {
        let secret = "Zq9-secret-Value";
        let redaction = redaction_of(&[secret]);
        let text = format!("head {secret} tail");
        for cut in 0..=text.len() {
            let pieces = streamed(
                &redaction,
                &[&text.as_bytes()[..cut], &text.as_bytes()[cut..]],
            );

            assert_eq!(
                pieces.concat(),
                format!("head {CREDENTIAL_REDACTION} tail").into_bytes(),
                "split at byte {cut}",
            );
        }
    }

    #[test]
    fn a_stream_never_splits_a_character_across_two_pieces() {
        // A three-byte secret holds back two bytes, which falls inside each multi-byte character
        // below at some cut.
        let redaction = redaction_of(&["abc"]);
        let text = "aé€😀b😀éabc z".as_bytes();
        for cut in 0..=text.len() {
            let pieces = streamed(&redaction, &[&text[..cut], &text[cut..]]);

            for piece in &pieces {
                assert!(
                    std::str::from_utf8(piece).is_ok(),
                    "split at byte {cut}: {piece:?}"
                );
            }
            assert_eq!(
                pieces.concat(),
                format!("aé€😀b😀é{CREDENTIAL_REDACTION} z").into_bytes()
            );
        }
    }

    #[test]
    fn a_short_secret_or_line_registers_no_derived_form() {
        // `p/w+d` is under 8 characters, though its URI form `p%2Fw%2Bd` is not; the braces are
        // lines of a longer secret, each under 8 characters.
        let redaction = redaction_of(&["p/w+d", "{\nlong-secret-line-value\n}"]);

        assert_eq!(
            redaction.scrub("q=p%2Fw%2Bd b64=cC93K2Q= raw=p/w+d {ok}"),
            format!("q=p%2Fw%2Bd b64=cC93K2Q= raw={CREDENTIAL_REDACTION} {{ok}}"),
        );
    }

    #[test]
    fn a_secret_added_mid_stream_is_masked_from_the_next_push_and_the_carry_still_is() {
        let first = "alpha-secret-0001";
        let added = "bravo-secret-0002";
        let redaction = redaction_of(&[first]);
        let mut stream = redaction.stream();

        let mut written = stream.push(format!("x {}", &first[..5]).as_bytes());
        redaction.add_secret(&SecretString::from(added));
        written.extend(stream.push(format!("{} then {added} end", &first[5..]).as_bytes()));
        written.extend(stream.finish());

        assert_eq!(
            written,
            format!("x {CREDENTIAL_REDACTION} then {CREDENTIAL_REDACTION} end").into_bytes()
        );
    }

    /// A long run of one short secret is written as it arrives, as one mask, the carry never
    /// holding more than the longest form less one byte. Mutation: hold a range reaching the cut
    /// whole in the carry, which grows it with the run.
    #[test]
    fn a_run_of_matches_is_written_as_it_arrives_as_one_mask() {
        let redaction = redaction_of(&["aaaa"]);
        let mut stream = redaction.stream();
        let mut written = Vec::new();
        for _ in 0..100 {
            written.extend(stream.push(&[b'a'; 1000]));
            assert!(
                stream.carry.len() <= 3,
                "the carry grew to {}",
                stream.carry.len()
            );
        }
        written.extend(stream.push(b"!"));
        written.extend(stream.finish());

        assert_eq!(written, format!("{CREDENTIAL_REDACTION}!").into_bytes());
    }

    /// A secret's tail held in the carry after its mask was written is never written plain, whether
    /// the next push carries the secret again or other text. Mutation: drop the carry's masked
    /// start, so its leading bytes match no form and are written.
    #[test]
    fn a_masked_tail_in_the_carry_is_never_written_plain() {
        let redaction = redaction_of(&["abcd"]);
        for (next, expected) in [
            ("abcd", CREDENTIAL_REDACTION.to_owned()),
            ("x", format!("{CREDENTIAL_REDACTION}x")),
        ] {
            let pieces = streamed(&redaction, &[b"abcd", next.as_bytes()]);

            assert_eq!(pieces.concat(), expected.into_bytes(), "then {next:?}");
        }
    }
}
