/**
 * Streaming rewrite of one assistant text block.
 *
 * Input arrives as arbitrary text deltas; output is emitted as deltas whose concatenation is a function
 * of the input text alone (never of how it was chunked). Text is held back only while it could still
 * become a pattern:
 *   `[S<digits>]`  → `[<title>](<canonical url>)` from the session's source map, or
 *                    `[S<digits>](unknown source)<marker>` when no such label exists;
 *   `http(s)://…`  → the canonical spelling of the seen URL it normalizes to (HTML-unescaped, Bing/DuckDuckGo
 *                    redirects resolved); unchanged when it is only a path-segment prefix of a seen URL (see
 *                    `isVerifiedUrl`); otherwise unchanged with `<marker>` appended.
 *                    A URL ends at whitespace, `<>"'` or a backtick,
 *                    `]`, an unbalanced `)`, or the end of the block. Inside a markdown link target the marker
 *                    goes after the closing `)`, inside `<…>` after the `>`; after a bare URL it goes before
 *                    trailing `.,;:*`.
 */
import { canonicalUrl, normalizeUrl } from "./normalize.js";

const URL_STOP = /[\s<>"'`\]]/;

/**
 * Whether a cited URL is backed by the session's tool results: its normalized form is a seen URL, or (without
 * a query) a path-segment prefix of one: `github.com/a/b` is backed by `github.com/a/b/releases/x`, not by
 * `github.com/a/bc`. Normalized forms carry the host first, so a prefix match is always on the same host.
 * @param {string} url - the cited URL without trailing punctuation.
 * @param {Set<string>} seen - normalized URLs from the session's tool results.
 * @returns {boolean}
 */
export function isVerifiedUrl(url, seen) {
  const norm = normalizeUrl(url);
  if (norm === null) return false;
  if (seen.has(norm)) return true;
  if (norm.includes("?")) return false;
  const prefix = `${norm}/`;
  for (const candidate of seen) if (candidate.startsWith(prefix)) return true;
  return false;
}

/**
 * @param {{ sources: Record<string, {url: string, title: string}>, seen: Record<string, string>, marker: string,
 *   onDecision?: (d: { kind: 'label' | 'url', input: string, output: string,
 *     verdict: 'substituted' | 'unknown' | 'exact' | 'canonicalized' | 'prefix' | 'marked' }) => void }} options
 *   `seen` maps normalized form → canonical URL; `onDecision` observes each label or URL decision.
 * @returns {{ push(text: string): string, flush(): string }} `push` returns the deltas safe to emit now;
 *   `flush` ends the block and returns everything still held back.
 */
export function createTransducer({ sources, seen, marker, onDecision }) {
  const seenSet = new Set(Object.keys(seen));
  const decide = (kind, input, output, verdict) => {
    onDecision?.({ kind, input, output, verdict });
    return output;
  };
  let held = "";
  let tail = "";
  let out = "";

  const emit = (text) => {
    out += text;
    tail = (tail + text).slice(-2);
  };


  /** Index just past the URL starting at 0 (scheme length `from`), or -1 while it may still continue. */
  const urlEnd = (text, from) => {
    let depth = 0;
    for (let j = from; j < text.length; j++) {
      const c = text[j];
      if (URL_STOP.test(c)) return j;
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) return j;
        depth--;
      }
    }
    return -1;
  };

  const run = (final) => {
    while (held.length > 0) {
      const start = held.search(/[[h]/);
      if (start === -1) {
        emit(held);
        held = "";
        return;
      }
      if (start > 0) {
        emit(held.slice(0, start));
        held = held.slice(start);
      }
      if (held[0] === "[") {
        const label = /^\[S(\d+)\]/.exec(held);
        if (label) {
          const source = sources[Number(label[1])];
          emit(source === undefined
            ? decide("label", label[0], `[S${label[1]}](unknown source)${marker}`, "unknown")
            : decide("label", label[0], `[${source.title || source.url}](${canonicalUrl(source.url)})`, "substituted"));
          held = held.slice(label[0].length);
          continue;
        }
        if (!final && /^\[(S\d*)?$/.test(held)) return;
        emit("[");
        held = held.slice(1);
        continue;
      }
      const scheme = /^https?:\/\//.exec(held);
      if (scheme) {
        let end = urlEnd(held, scheme[0].length);
        if (end === -1) {
          if (!final) return;
          end = held.length;
        }
        const raw = held.slice(0, end);
        held = held.slice(end);
        const trailing = /[.,;:*]+$/.exec(raw)?.[0] ?? "";
        const core = raw.slice(0, raw.length - trailing.length);
        const inLink = tail.endsWith("](");
        const inAutolink = tail.endsWith("<");
        const norm = normalizeUrl(core);
        if (norm !== null && Object.hasOwn(seen, norm)) {
          const canonical = seen[norm];
          emit(`${decide("url", core, canonical, canonical === core ? "exact" : "canonicalized")}${trailing}`);
        } else if (isVerifiedUrl(core, seenSet)) {
          emit(`${decide("url", core, core, "prefix")}${trailing}`);
        } else if (inLink && held[0] === ")") {
          emit(`${decide("url", core, `${core}${trailing})${marker}`, "marked")}`);
          held = held.slice(1);
        } else if (inAutolink && held[0] === ">") {
          emit(`${decide("url", core, `${core}${trailing}>${marker}`, "marked")}`);
          held = held.slice(1);
        } else if (inLink) {
          emit(decide("url", core, `${core}${trailing}${marker}`, "marked"));
        } else {
          emit(`${decide("url", core, `${core}${marker}`, "marked")}${trailing}`);
        }
        continue;
      }
      if (!final && ("https://".startsWith(held) || "http://".startsWith(held))) return;
      emit(held[0]);
      held = held.slice(1);
    }
  };

  return {
    push(text) {
      held += text;
      run(false);
      const ready = out;
      out = "";
      return ready;
    },
    flush() {
      run(true);
      const ready = out;
      out = "";
      return ready;
    },
  };
}

/**
 * Rewrite a whole text in one call (the same transducer, fed once).
 * @returns {string}
 */
export function rewriteText(text, options) {
  const t = createTransducer(options);
  return t.push(text) + t.flush();
}
