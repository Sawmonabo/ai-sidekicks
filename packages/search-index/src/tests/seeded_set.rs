//! The endurance tier's seeded set, drawn as the daemon's seeder draws it: the same seed, the same
//! draws in the same order, so scale 1 gives its 10,000 sessions and 1M messages row for row.

use std::collections::{BTreeMap, HashSet};

use crate::{IndexRow, IndexRowKind};

use super::support::row;

/// How many of each thing the set holds.
#[derive(Clone, Copy, Debug)]
pub struct SeededSetSize {
    pub sessions: usize,
    pub messages: usize,
    pub groups: usize,
    pub tags: usize,
    pub links: usize,
}

impl SeededSetSize {
    /// The endurance tier at `scale`: scale 1 is 10,000 sessions and 1M messages, and every count
    /// grows with it.
    pub fn at_scale(scale: usize) -> SeededSetSize {
        SeededSetSize {
            sessions: 10_000 * scale,
            messages: 1_000_000 * scale,
            groups: 1_000 * scale,
            tags: 30_000 * scale,
            links: 100_000 * scale,
        }
    }
}

/// What the set says besides its rows: each group's members in session id order, and each tag
/// with the session carrying it.
pub struct SeededDirectory {
    pub group_members: Vec<(u64, Vec<u64>)>,
    pub session_tags: Vec<(u64, String)>,
}

impl SeededDirectory {
    /// The sessions carrying `tag` or a tag nested under it.
    pub fn sessions_tagged(&self, tag: &str) -> Vec<u64> {
        let nested = format!("{tag}/");
        let mut sessions: Vec<u64> = self
            .session_tags
            .iter()
            .filter(|(_, carried)| carried == tag || carried.starts_with(&nested))
            .map(|(session, _)| *session)
            .collect();
        sessions.sort_unstable();
        sessions.dedup();
        sessions
    }
}

// The seeder's `seededRandom`: mulberry32.
struct Mulberry(u32);

impl Mulberry {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let seed = self.0;
        let mut mixed = (seed ^ (seed >> 15)).wrapping_mul(1 | seed);
        mixed = (mixed.wrapping_add((mixed ^ (mixed >> 7)).wrapping_mul(61 | mixed))) ^ mixed;
        f64::from(mixed ^ (mixed >> 14)) / 4_294_967_296.0
    }

    fn pick(&mut self, count: usize) -> usize {
        (self.next() * count as f64).floor() as usize
    }
}

const SYLLABLES: [&str; 14] = [
    "ka", "lo", "mi", "ne", "ru", "ta", "vo", "zi", "pe", "sa", "do", "fu", "gri", "ble",
];
const TAG_ROOTS: [&str; 10] = [
    "billing", "auth", "infra", "docs", "perf", "ui", "api", "release", "bugs", "research",
];
const VOCABULARY: usize = 20_000;

/// The set's word at `index` of its 20,000; low indexes are the common words.
pub fn word_at(index: usize) -> String {
    let mut remaining = index + 1;
    let mut word = String::new();
    while remaining > 0 {
        word.push_str(SYLLABLES[remaining % 14]);
        remaining /= 14;
    }
    word
}

/// Hands every row of the set to `emit` in the seeder's order (groups, titles, tags, then
/// messages) and returns the groups' members and the sessions' tags. Keys follow the daemon's
/// scheme: a message's key is its rowid times four, a title's its session's rowid times four plus
/// one, a group's name its rowid times four plus two, a tag's its rowid times four plus three.
pub fn generate(size: SeededSetSize, mut emit: impl FnMut(IndexRow)) -> SeededDirectory {
    let mut random = Mulberry(7);
    let words: Vec<String> = (0..VOCABULARY).map(word_at).collect();
    let zipf = |random: &mut Mulberry| -> usize {
        ((random.next() * (VOCABULARY as f64).ln()).exp() - 1.0)
            .floor()
            .min(19_999.0) as usize
    };
    let sentence = |random: &mut Mulberry, count: usize| -> String {
        (0..count)
            .map(|_| words[zipf(random)].as_str())
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
        let _archived = random.next() < 0.3;
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
        emit(row(
            (index as u64 + 1) * 4 + 3,
            IndexRowKind::Tag,
            *session,
            tag,
        ));
    }
    // Links hold no text, but their draws come before the messages'.
    let mut links: HashSet<(usize, usize, usize)> = HashSet::new();
    while links.len() < size.links {
        let source = random.pick(size.sessions);
        let target = random.pick(size.sessions);
        let kind = random.pick(6);
        if source != target {
            let _last_used = random.pick(90);
            if kind == 2 {
                let _uses = random.pick(40);
            }
            links.insert((source, target, kind));
        }
    }
    drop(links);
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
        session_tags,
    }
}
