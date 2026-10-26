/**
 * Streaming rewrite of one assistant text block.
 *
 * Input arrives as arbitrary text deltas; output is emitted as deltas whose concatenation is a function
 * of the input text alone (never of how it was chunked). Text is held back only while it could still
 * become a pattern:
 *   `[S<digits>]`  → `[<title>](<exact url>)` from the session's source map, or
 *                    `[S<digits>](unknown source)<marker>` when no such label exists;
 *   `http(s)://…`  → passed through, with `<marker>` appended when its normalized form is not among the
 *                    URLs seen in this session's tool results. A URL ends at whitespace, `<>"'` or a backtick,
 *                    `]`, an unbalanced `)`, or the end of the block. Inside a markdown link target the marker
 *                    goes after the closing `)`, inside `<…>` after the `>`; after a bare URL it goes before
 *                    trailing `.,;:*`.
 */
import { normalizeUrl } from "./normalize.js";

const URL_STOP = /[\s<>"'`\]]/;

/**
 * @param {{ sources: Record<string, {url: string, title: string}>, seen: Iterable<string>, marker: string }} options
 * @returns {{ push(text: string): string, flush(): string }} `push` returns the deltas safe to emit now;
 *   `flush` ends the block and returns everything still held back.
 */
export function createTransducer({ sources, seen, marker }) {
  const seenSet = seen instanceof Set ? seen : new Set(seen);
  let held = "";
  let tail = "";
  let out = "";

  const emit = (text) => {
    out += text;
    tail = (tail + text).slice(-2);
  };

  const isVerified = (url) => {
    const norm = normalizeUrl(url);
    return norm !== null && seenSet.has(norm);
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
            ? `[S${label[1]}](unknown source)${marker}`
            : `[${source.title || source.url}](${source.url})`);
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
        if (core.length === 0 || isVerified(core)) {
          emit(raw);
        } else if (inLink && held[0] === ")") {
          emit(`${raw})${marker}`);
          held = held.slice(1);
        } else if (inAutolink && held[0] === ">") {
          emit(`${raw}>${marker}`);
          held = held.slice(1);
        } else if (inLink) {
          emit(`${raw}${marker}`);
        } else {
          emit(`${core}${marker}${trailing}`);
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
