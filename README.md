# dsh-cite-sources

A DeepSeek Harness plugin that stops the model from re-typing URLs.

- **Labels.** In `web_search`, `advanced_search`, `platform_search` and `web_fetch` results, every source line `- [title](url)` becomes `- [S#] title — url`, and the fetch header becomes `Fetched [S#] <url> (HTTP …)`. tool-web's line `Cite the relevant URLs above as markdown links in your answer.` becomes `Cite sources as [S1] or [S2, S6]. Never type a URL yourself.`; the other tools get that line appended once per labeled result. Labels continue across a session; a URL labeled earlier keeps its label. Result `meta` is untouched, so the search and fetch cards do not change.
- **Substitution.** While the answer streams, a citation group in `( )` or `[ ]` whose ids are separated by `,`, `;`, spaces, `y` or `and` becomes short links: `( )` is kept, `(S2, S6)` → `([S2](url2), [S6](url6))`; a `[ ]` group becomes the links themselves, `[S1]` → `[S1](url1)`, `[S2, S6]` and `[S2][S6]` → `[S2](url2), [S6](url6)`. An unknown id becomes `S9 ⚠️(unknown source)`. A text block that cited a known id ends with `\n\nFuentes:` and one `- [S#] <title> — <url>` line per cited id, once each, in first-citation order.
- **Canonical URLs.** A typed URL that normalizes to a seen URL is replaced by the seen spelling, HTML-unescaped, with Bing and DuckDuckGo redirects decoded to their targets. A URL that is a path-segment prefix of a seen URL on the same host passes unchanged.
- **Unverified marker.** Any other `http(s)://` URL in assistant text (comparison by the rules of `~/dsh-compare/compare.py` `normalize_url`) gets ` ⚠️(unverified)`.

Reasoning and tool-call chunks are not touched. The rewritten text is what the agent loop logs as `assistant/message`, so later turns and replays see the same text the user saw.

## How it hooks in

| Hook | What it does |
|---|---|
| `tools/post-execute` (waterfall) | Rewrites the content of successful root calls of the configured tools after the other listeners decide. |
| Host-only session projection `citeSources` | Folds logged events into `{ next, sources, seen, pending }`: labels only from results of calls to the configured tools (other results, such as a shell printing a log, never enter the map), seen URLs from every result. The map is rebuilt from the log on resume. |
| `agent/request` (agent-scoped waterfall) | Arms the session with the turn `signal` of the step about to be requested. |
| `llm/stream` (waterfall) | For a request whose `signal` is the armed one and that carries no `purpose` (title and compaction calls do), runs each text block through `lib/transducer.js`. Text is held back only while it could still be a citation group or a URL. The block end carries exactly the concatenated emitted deltas, and a block end that differs from its input deltas throws. |
| `agent/assistant-stream`, `agent/turn-stopping` | Trace: a `NOT ACTIVE` warning when an armed step ends without a rewritten stream; per-turn decision counts. |

## Trace

Every line goes to `ctx.logger` and is appended to `traceFile` (default `$DSH_HOME/logs/cite-sources.log`): `loaded …` at plugin load, `active session=<id> sources=<n>` on the first rewritten stream of a session in this process, `turn session=<id> turn=<n> substituted= unknown= exact= canonicalized= prefix= marked=` when a rewritten turn stops, and `WARN … NOT ACTIVE …` when a step was not rewritten.

## Config

```yaml
- id: cite-sources
  name: dsh-cite-sources
  config:
    tools: [ web_search, advanced_search, platform_search, web_fetch ]
    marker: " ⚠️(unverified)"
    traceFile: logs/cite-sources.log   # relative to the DeepSeek Harness home, or absolute
```

A non-array `tools`, an empty `marker` or `traceFile`, or a relative `traceFile` without a host `dshHomePath` fails at load.

## Tests

`npm test` uses real desktop sessions from `~/.local/share/deepseek-harness/sessions` and the offline oracle in `~/dsh-compare` (`url_audit.py`, `compare.py`) through `test/url_audit_export.py`. No network or GPU.

## Install

`./install_desktop.sh` installs into the desktop profile with the pnpm that wrote it (the app-bundled pnpm recorded in `node_modules/.modules.yaml`). It refuses to run while the app is open, backs up every file it changes, and restores in-place-patched plugin copies (dsh-recall, dsh-compaction-select) if pnpm rewrites them.

## Known limits

- Only source lines and the fetch header get labels; links inside fetched pages keep their raw form. Results other than tool-web's `web_search` get the citation instruction appended once.
- URLs the user typed in chat are not "seen"; only tool results count.
