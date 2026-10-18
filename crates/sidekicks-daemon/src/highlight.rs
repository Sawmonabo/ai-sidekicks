//! Code coloring: shiki's grammars run line by line on the daemon's one coloring thread, under a
//! theme that names span classes instead of colors.

pub(crate) mod code_theme;
pub(crate) mod tokenizer;
