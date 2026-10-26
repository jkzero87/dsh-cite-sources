/**
 * Streaming rewrite of one assistant text block.
 *
 * Input arrives as arbitrary text deltas; output is emitted as deltas whose concatenation is a function
 * of the input text alone (never of how it was chunked). Text is held back only while it could still
 * become a pattern:
 *   a citation group: `(` or `[` whose content is ONLY `S<digits>` ids separated by commas, semicolons,
 *   spaces, `y`/`and`, or more groups — `(S1)`, `[S1]`, `(S2, S6)`, `(S2; S6)`, `[S2, S6]`, adjacent groups
 *   like `[S2][S6]`. A `( )` group keeps its delimiters and separators: `(S2, S6)` → `([S2](url2), [S6](url6))`.
 *   A `[ ]` group becomes the links themselves, and directly adjacent `[ ]` groups are joined by `, `:
 *   `[S1]` → `[S1](url1)`, `[S2, S6]` and `[S2][S6]` → `[S2](url2), [S6](url6)`. Each link is
 *   `[S#](<canonical url>)` from the session's source map, or `S<digits> ⚠️(unknown source)` when the label
 *   is not in the map.
 *   At the end of each text block that cited at least one known id, a `Fuentes:` block with one
 *   `- [S#] <title> — <canonical url>` line per cited id, once each, in first-citation order, is appended
 *   (before the block end, so the deltas still concatenate to the end text);
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
const UNKNOWN_SOURCE = " ⚠️(unknown source)";

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
  const citedIds = []; // known ids cited by a matched group, each once, in first-citation order

  let afterBracketGroup = false; // the last emitted text was a `[ ]` group's links
  const emit = (text) => {
    out += text;
    tail = (tail + text).slice(-2);
    afterBracketGroup = false;
  };

  /** One citation id: its short link `[S<id>](<canonical url>)` (titles appear only in the `Fuentes:` block), or
   * `S<id> ⚠️(unknown source)` when the label is not in the map. Known ids are recorded for that block. */
  const idLink = (id) => {
    const source = sources[id];
    if (source === undefined) return decide("label", `S${id}`, `S${id}${UNKNOWN_SOURCE}`, "unknown");
    if (!citedIds.includes(id)) citedIds.push(id);
    return decide("label", `S${id}`, `[S${id}](${canonicalUrl(source.url)})`, "substituted");
  };

  /**
   * Citation group starting at index 0: `(` or `[` whose content is ONLY `S<digits>` ids separated by
   * commas, semicolons, spaces, `y`/`and`, or adjacent groups of the same kind — `(S1)`, `[S1]`,
   * `(S2, S6)`, `(S2; S6)`, `[S2, S6]`, `[S2][S6]`.
   * Returns `{ matched, end, final }`: `matched` is the whole pattern (or null), `end` how many chars it
   * consumes, and `final` whether a null match is definite (the text cannot become a group yet).
   */
  const groupMatch = (final) => {
    const open = held[0];
    const close = open === "(" ? ")" : "]";
    // An id at `j`: `S<digits>`, then optional whitespace, an optional separator (`,`, `;`, `y`, `and`) and
    // optional whitespace, all consumed so `j` lands on the next id. A separator is consumed only when an id
    // or the closing delimiter follows it. Whitespace alone also separates two ids (`(S2 S6)`).
    const idPart = (j) => {
      const m = /S\d*/.exec(held.slice(j));
      if (!m || held[j] !== "S") return null;
      let end = j + m[0].length;
      // Skip optional whitespace before the separator
      const ws1 = /^\s*/.exec(held.slice(end));
      end += ws1[0].length;
      const sep = /[,;]|y\b|and\b/.exec(held.slice(end));
      if (sep) {
        end += sep[0].length;
        // Skip optional whitespace after the separator
        const ws2 = /^\s*/.exec(held.slice(end));
        end += ws2[0].length;
        // Only accept the separator if what follows is another id or the closing delimiter
        const next = held[end];
        if (next !== undefined && !/^[S)\]]/.test(next)) {
          // Not actually a separator: back off and don't consume it
          end -= ws2[0].length;
          end -= sep[0].length;
          return { end, hasSep: ws1[0].length > 0 };
        }
      }
      return { end, hasSep: sep !== null || ws1[0].length > 0 };
    };
    let j = 1;
    let parts = 0;
    // Two ids need a separator or whitespace between them (`(S2S6)` is not a group).
    let prevConsumedSep = false;
    while (j < held.length) {
      const c = held[j];
      if (/\s/.test(c)) { j++; continue; }
      if (c === close) {
        if (parts === 0) return { matched: null, end: 1, final: true }; // the delimiter alone
        return { matched: held.slice(0, j + 1), end: j + 1, final: true };
      }
      if (c === open) { // adjacent group: `[S2][S6]`, `(S1) (S2)`
        const sub = groupMatch(final);
        if (!sub.final && sub.matched === null) return { matched: null, end: 0, final: false };
        if (sub.matched === null) return { matched: null, end: 1, final: true }; // inner group impossible
        parts++;
        j += sub.end;
        prevConsumedSep = false; // adjacent groups need no separator
        continue;
      }
      const id = idPart(j);
      if (id !== null) {
        if (parts > 0 && !prevConsumedSep) {
          // no separator between this id and the previous one: not a group
          if (!final) return { matched: null, end: 0, final: false }; // still possible
          return { matched: null, end: 1, final: true }; // definite: not a group
        }
        parts++;
        prevConsumedSep = id.hasSep;
        j = id.end;
        continue;
      }
      if (!final) return { matched: null, end: 0, final: false }; // still possible
      return { matched: null, end: 1, final: true };
    }
    return { matched: null, end: 0, final: false }; // the group may still continue
  };

  /** Render one matched group. `( )` keeps its delimiters and separators (whitespace normalized); a `[ ]` group
   * becomes its links alone, joined by `, `. */
  const renderGroup = (match) => {
    const open = match[0];
    if (open === "[") return [...match.matchAll(/S(\d+)/g)].map((m) => idLink(Number(m[1]))).join(", ");
    const close = open === "(" ? ")" : "]";
    const inner = match.slice(1, -1);
    const parts = [];
    const re = /S\d+|,|;|\b(?:y|and)\b|\s+|\S+/g;
    let last = 0;
    for (const m of inner.matchAll(re)) {
      if (m.index > last) parts.push(inner.slice(last, m.index));
      if (m[0].startsWith("S")) parts.push(idLink(Number(m[0].slice(1))));
      else if (m[0] === ",") parts.push(",");
      else if (m[0] === ";") parts.push(";");
      else if (/^\s+$/.test(m[0])) parts.push(" ");
      else parts.push(m[0]); // `y`, `and`, or an adjacent-group token
      last = m.index + m[0].length;
    }
    if (last < inner.length) parts.push(inner.slice(last));
    return open + parts.join("") + close;
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
      const start = held.search(/[(\[h]/);
      if (start === -1) {
        emit(held);
        held = "";
        return;
      }
      if (start > 0) {
        emit(held.slice(0, start));
        held = held.slice(start);
      }
      if (held[0] === "[" || held[0] === "(") {
        const g = groupMatch(final);
        if (g.matched !== null) {
          const bracket = held[0] === "[";
          const separator = bracket && afterBracketGroup ? ", " : "";
          emit(separator + renderGroup(g.matched));
          afterBracketGroup = bracket;
          held = held.slice(g.end);
          continue;
        }
        if (!g.final) return; // still possible: hold
        emit(held[0]); // definite: emit the delimiter and keep parsing its content
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

  const sourcesBlock = () => {
    if (citedIds.length === 0) return "";
    const lines = citedIds.map((id) => `- [S${id}] ${sources[id].title || sources[id].url} — ${canonicalUrl(sources[id].url)}`);
    return `\n\nFuentes:\n${lines.join("\n")}`;
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
      const ready = out + sourcesBlock();
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
