//! Code coloring: the daemon's one colorer, a span cache over one long-lived thread that runs
//! shiki's grammars line by line under a theme that names span classes instead of colors.

pub(crate) mod code_theme;
pub(crate) mod colorer;
pub(crate) mod thread;
pub(crate) mod tokenizer;
