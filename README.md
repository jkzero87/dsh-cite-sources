# dsh-cite-sources

A DeepSeek Harness plugin that stops the model from re-typing URLs.

- **Labels.** In `web_search`, `advanced_search`, `platform_search` and `web_fetch` results, every source line `- [title](url)` becomes `- [S#] title — url`, and the fetch header becomes `Fetched [S#] <url> (HTTP …)`. tool-web's line `Cite the relevant URLs above as markdown links in your answer.` becomes `Cite sources as [S#]. Never type a URL yourself.` Labels continue across a session; a URL labeled earlier keeps its label. Result `meta` is untouched, so the search and fetch cards do not change.
- **Substitution.** While the answer streams, `[S#]` becomes `[title](exact url)`; an unknown label becomes `[S#](unknown source) ⚠️(unverified)`.
- **Unverified marker.** Any `http(s)://` URL in assistant text whose normalized form (the rules of `~/dsh-compare/compare.py` `normalize_url`) is not among the URLs of the session's tool results gets ` ⚠️(unverified)`.

Reasoning and tool-call chunks are not touched. The rewritten text is what the agent loop logs as `assistant/message`, so later turns and replays see the same text the user saw.

## How it hooks in

| Hook | What it does |
|---|---|
| `tools/post-execute` (waterfall) | Rewrites the content of successful root calls of the configured tools after the other listeners decide. |
| Host-only session projection `citeSources` | Folds logged `tool/result` events into `{ next, sources, seen }`, so the label map is rebuilt from the log on resume. |
| `llm/stream` (waterfall) | For `isAgentLoopRequest` requests with a `sessionId`, runs each text block through `lib/transducer.js`. Text is held back only while it could still be `[S<digits>]` or a URL. The block end carries exactly the concatenated emitted deltas, and a block end that differs from its input deltas throws. |

## Config

```yaml
- id: cite-sources
  name: dsh-cite-sources
  config:
    tools: [ web_search, advanced_search, platform_search, web_fetch ]
    marker: " ⚠️(unverified)"
```

A non-array `tools` or an empty `marker` fails at load.

## Tests

`npm test` uses real desktop sessions from `~/.local/share/deepseek-harness/sessions` and the offline oracle in `~/dsh-compare` (`url_audit.py`, `compare.py`) through `test/url_audit_export.py`. No network or GPU.

## Install

`./install_desktop.sh` installs into the desktop profile. It refuses to run while the app is open and backs up every file it changes.

## Known limits

- Only source lines and the fetch header get labels; links inside fetched pages keep their raw form. Only tool-web's `web_search` output carries the citation instruction line, so `advanced_search`, `platform_search` and `web_fetch` results get labels without the instruction.
- `normalize_url` treats a decoded Bing redirect and its target as the same URL, so a model that decodes a redirect is not marked, and doubled `&&` in a Bing redirect query normalizes to the same target.
- URLs the user typed in chat are not "seen"; only tool results count.
