# The `sqlite3` shell the daemon repairs a damaged database with. It compiles the binding's own
# SQLite source with the binding's compile options, so both read and write the same SQL, and adds
# the page table the shell's `.recover` reads through. `shell.c` comes from the same release's
# amalgamation, fetched by `fetch-source.ts`.
{
  'targets': [{
    'target_name': 'sqlite3',
    'type': 'executable',
    'win_delay_load_hook': 'false',
    'includes': ['../node_modules/better-sqlite3/deps/defines.gypi'],
    'defines': ['SQLITE_ENABLE_DBPAGE_VTAB'],
    # `.recover` turns foreign keys off inside its own transaction, where SQLite ignores that, so
    # a row whose parent was lost would fail the whole recovery; the shell keeps SQLite's default.
    'defines!': ['SQLITE_DEFAULT_FOREIGN_KEYS=1'],
    'include_dirs': ['../node_modules/better-sqlite3/deps/sqlite3'],
    'sources': ['build/source/shell.c', '../node_modules/better-sqlite3/deps/sqlite3/sqlite3.c'],
    'cflags': ['-w'],
    'xcode_settings': {'WARNING_CFLAGS': ['-w']},
    'msvs_settings': {'VCCLCompilerTool': {'WarningLevel': 0}},
    'conditions': [['OS=="linux"', {'libraries': ['-lm', '-ldl', '-lpthread']}]],
  }],
}
