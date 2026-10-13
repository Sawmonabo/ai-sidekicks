//! A seeded set of sessions shaped like the endurance tier's: titled sessions, some in groups,
//! nested tags, and messages of words drawn on a Zipf curve, every fiftieth in one session. The
//! same size always draws the same rows.

use std::collections::{BTreeMap, HashSet};

use crate::index::{IndexRow, IndexRowKind, IndexRowTag};

use super::support::row;

/// How many of each thing the set holds.
#[derive(Clone, Copy, Debug)]
pub(super) struct SeededSetSize {
    /// Sessions, each with a title row.
    pub(super) sessions: usize,
    /// Message rows across the sessions.
    pub(super) messages: usize,
    /// Groups, each with a name row; about half the sessions join one.
    pub(super) groups: usize,
    /// Tag rows, each a distinct tag of one session.
    pub(super) tags: usize,
}

#[cfg(feature = "measurements")]
impl SeededSetSize {
    /// The endurance tier's sizes at `scale`: scale 1 is 10,000 sessions and 1M messages, and
    /// every count grows with it.
    pub(super) fn at_scale(scale: usize) -> SeededSetSize {
        SeededSetSize {
            sessions: 10_000 * scale,
            messages: 1_000_000 * scale,
            groups: 1_000 * scale,
            tags: 30_000 * scale,
        }
    }
}

/// What the set says besides its rows.
pub(super) struct SeededDirectory {
    /// Each group's key and its member sessions' keys in session id order.
    pub(super) group_members: Vec<(u64, Vec<u64>)>,
}

// mulberry32: integer arithmetic only, so a seed always draws the same sequence.
struct Mulberry(u32);

impl Mulberry {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let seed = self.0;
        let mut mixed = (seed ^ (seed >> 15)).wrapping_mul(1 | seed);
        mixed = (mixed.wrapping_add((mixed ^ (mixed >> 7)).wrapping_mul(0x3d | mixed))) ^ mixed;
        f64::from(mixed ^ (mixed >> 14)) / 4_294_967_296.0
    }

    #[expect(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a count far below 2^52 scaled by a draw in [0, 1) is a whole index below it"
    )]
    fn pick(&mut self, count: usize) -> usize {
        (self.next() * count as f64).floor() as usize
    }

    // A word index on a Zipf curve over the vocabulary, the common words drawn most.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the draw is floored and capped within the vocabulary"
    )]
    fn zipf(&mut self) -> usize {
        let vocabulary = u32::try_from(VOCABULARY).expect("the vocabulary is 20,000 words");
        ((self.next() * f64::from(vocabulary).ln()).exp() - 1.0)
            .floor()
            .min(19_999.0) as usize
    }
}

const SYLLABLES: [&str; 14] = [
    "ka", "lo", "mi", "ne", "ru", "ta", "vo", "zi", "pe", "sa", "do", "fu", "gri", "ble",
];
const TAG_ROOTS: [&str; 10] = [
    "billing", "auth", "infra", "docs", "perf", "ui", "api", "release", "bugs", "research",
];
const VOCABULARY: usize = 20_000;
// Every session's last activity: 2026-10-06T12:00:00.000Z.
const SEEDED_AT_MS: u64 = 1_791_288_000_000;

/// The set's word at `index` of its 20,000; low indexes are the common words.
pub(super) fn word_at(index: usize) -> String {
    let mut remaining = index + 1;
    let mut word = String::new();
    while remaining > 0 {
        word.push_str(SYLLABLES[remaining % 14]);
        remaining /= 14;
    }
    word
}

/// Hands every row of the set to `emit` in order (groups, titles, tags, then messages) and returns
/// the groups' members. Keys follow the daemon's scheme: a message's key is
/// its rowid times four, a title's its session's rowid times four plus one, a group's name its
/// rowid times four plus two, a tag's its rowid times four plus three.
pub(super) fn generate(size: SeededSetSize, mut emit: impl FnMut(IndexRow)) -> SeededDirectory {
    let mut random = Mulberry(7);
    let words: Vec<String> = (0..VOCABULARY).map(word_at).collect();
    let sentence = |random: &mut Mulberry, count: usize| -> String {
        (0..count)
            .map(|_| words[random.zipf()].as_str())
            .collect::<Vec<_>>()
            .join(" ")
    };
    for index in 0..size.groups {
        let name = format!("{} work {index}", words[random.pick(2_000)]);
        let rowid = (index + 1) as u64;
        emit(row(rowid * 4 + 2, IndexRowKind::Group, rowid, &name));
    }
    let mut members: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
    for index in 0..size.sessions {
        let name = sentence(&mut random, 3);
        let group = if random.next() < 0.5 {
            Some(random.pick(size.groups) + 1)
        } else {
            None
        };
        let rowid = (index + 1) as u64;
        if let Some(group) = group {
            members.entry(group as u64).or_default().push(rowid);
        }
        emit(row(rowid * 4 + 1, IndexRowKind::Title, rowid, &name));
    }
    let mut seen: HashSet<(usize, String)> = HashSet::new();
    let mut session_tags: Vec<(u64, String)> = Vec::new();
    while session_tags.len() < size.tags {
        let root = TAG_ROOTS[random.pick(10)];
        let tag = if random.next() < 0.5 {
            root.to_string()
        } else {
            format!("{root}/{}", words[random.pick(500)])
        };
        let session = random.pick(size.sessions);
        if seen.insert((session, tag.clone())) {
            session_tags.push(((session + 1) as u64, tag));
        }
    }
    for (index, (session, tag)) in session_tags.iter().enumerate() {
        let key = (index as u64 + 1) * 4 + 3;
        emit(IndexRow {
            tag: Some(IndexRowTag {
                fold: tag.clone(),
                session_last_activity_ms: SEEDED_AT_MS,
            }),
            ..row(key, IndexRowKind::Tag, *session, tag)
        });
    }
    for index in 0..size.messages {
        let session = if index % 50 == 0 {
            1
        } else {
            index % size.sessions
        };
        let roll = random.next();
        let text = sentence(&mut random, 18);
        let text = if roll < 0.8 {
            text
        } else {
            format!("Bash {{\"command\":\"{text}\"}}")
        };
        let key = (index as u64 + 1) * 4;
        emit(row(key, IndexRowKind::Event, (session + 1) as u64, &text));
    }
    SeededDirectory {
        group_members: members.into_iter().collect(),
    }
}
