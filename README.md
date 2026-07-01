# pi-clj-paren-repair

Auto-fixes unbalanced delimiters in Clojure / ClojureScript files edited by the LLM.

## What it does

LLMs frequently produce mismatched `()`, `[]`, `{}` when editing Clojure source. This extension intercepts `write` and `edit` tool calls, pipes the content through [parinfer-rust](https://github.com/eraserhd/parinfer-rust) for delimiter repair, and then formats with [cljfmt](https://github.com/weavejester/cljfmt), and:

| Scenario | Action |
|---|---|
| Delimiters balanced | Format with cljfmt, pass through |
| Delimiters broken, fixable | Auto-repair via parinfer, then format, mutate tool input in place |
| Delimiters broken, unfixable | **Block** the write / **restore** the edit from backup |

Inspired by [bhauman/clojure-mcp-light](https://github.com/bhauman/clojure-mcp-light/tree/main) — same edamame + parinfer + cljfmt stack, adapted as a pi extension.

### cljfmt Integration

Every Clojure file processed by this extension is formatted with cljfmt. The user's `.cljfmt.edn` config is loaded from the file's directory (searching upward), so project-local formatting rules are respected automatically.

## Requirements

- [pi](https://github.com/badlogic/pi-coding-agent)
- [babashka](https://github.com/babashka/babashka) ≥ 1.12 (edamame is bundled)
- [parinfer-rust](https://github.com/eraserhd/parinfer-rust) on `PATH`

## Install

```bash
git clone https://github.com/carloshernandez2/pi-clj-paren-repair.git \
  ~/.pi/agent/extensions/clj-paren-repair
```

That's it — pi auto-discovers extensions in `~/.pi/agent/extensions/`.

## How it works

```
LLM calls write/edit on .clj / .cljs / .cljc file
  │
  ├─ tool_call (write) ──────────────────┐
  │  → pipe content → bb repair.bb       │
  │  → edamame detects delimiter error?  │
  │    yes → parinfer-rust repairs       │
  │    no  → pass through                │
  │  → mutate event.input.content        │
  │                                     │
  ├─ tool_call (edit) ───────────────────┤
  │  → create temp backup of file        │
  │                                     │
  └─ tool_result (edit) ────────────────┘
     → read edited file → bb repair.bb
     → repaired? → write fixed content
     → failed?  → restore from backup, signal isError
```

### `repair.bb`

A standalone Babashka script:

1. Parses input with **edamame** (bundled with bb) using full Clojure reader features (`:all true`, reader conditionals, data readers, etc.)
2. If edamame reports a delimiter error, pipes the text through `parinfer-rust --mode indent --language clojure`
3. Verifies the repaired output is clean; returns original content if no error or repair failed
4. Formats the output with **cljfmt**, loading `.cljfmt.edn` from the file's directory via the `CLJ_FILE_PATH` env var

### `index.ts`

The pi extension that wires everything together:

- **`tool_call`** — intercepts `write` and `edit` on `.clj`, `.cljs`, `.cljc`, `.cljd`, `.bb`, `.lpy`, `.edn` files
- **`tool_result`** — post-edit fix + restore-on-failure for `edit`
- **`session_shutdown`** — cleanup of stale backups

## Testing

```bash
# Valid code passes through unchanged
echo '(defn foo [x] (+ x 1))' | bb repair.bb

# Missing paren is fixed
echo '(+ 1 2 3' | bb repair.bb
# → (+ 1 2 3)

# Nested error
echo '(defn bar [y]
  (let [z (* y 2]
    (+ z 1)))' | bb repair.bb
# → (defn bar [y]
#     (let [z (* y 2)]
#       (+ z 1)))
```

## License

EPL-2.0
