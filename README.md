[![Entered](https://make.fun/badges/entered.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Competition](https://make.fun/badges/competition.svg?slug=hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Build](https://make.fun/badges/build.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

mend is a small command-line tool that applies edits written by AI models to a
tree of text files. Models produce edits in several shapes, and mend reads all
of them:

- **unified diffs**, including ones whose line numbers have drifted from the
  file they describe;
- **SEARCH/REPLACE blocks**, the kind with `<<<<<<< SEARCH` and
  `>>>>>>> REPLACE` markers;
- **V4A patches**, the `*** Begin Patch` format with Add, Delete and Update
  file sections;
- **JSON tool calls**: an array of edit objects, or one object per line, with
  `create`, `str_replace` and `insert` commands.

Every edit in a patch is applied in order, and the run is all-or-nothing: if
any edit fails, nothing on disk changes and each failure is reported.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory. Omit it (or
  pass `-`) to read the patch from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or
  `json`. The default, `auto`, detects the format from the patch itself.
- `--check` runs everything and prints the same result, but writes nothing.
- `--strict` matches lines exactly; without it, matching also tolerates
  trailing-whitespace drift and, failing that, re-indentation.

The working directory is the root of the tree; every path in a patch is
relative to it. Paths that escape the tree are refused.

## Output

On success mend prints one line per changed path (`A` added, `D` deleted,
`M` modified, `R` renamed) and a summary such as `ok: 3 files`. When edits
fail it prints one `error: <code> <path>` line per failure and a
`failed: <k> of <n> edits` summary. Usage problems, unreadable patches,
undetectable formats and unparseable patches each print a single
`error: ...` line and exit with code 2.

## Implementation

One file, `main.ts`, written in plain JavaScript syntax and run directly by
Node — no build step and nothing outside the Node standard library. The whole
patch is parsed before any file is examined, edits are applied to an
in-memory copy of the tree, and the tree is written back only when every edit
succeeded.
