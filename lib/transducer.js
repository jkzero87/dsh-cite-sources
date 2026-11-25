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
 *   Code regions pass through unchanged and are never scanned for groups or URLs: ``` fenced blocks (a line
 *   starting with up to three spaces and three or more backticks, to the next such line), single-line `…`
 *   spans, and lines starting with `> ` (quoted log lines).
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
  let region = null; // "fence" while inside a ``` ... ``` block: lines pass through unchanged

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
   * Citation group starting at `held[start]`: `(` or `[` whose content is ONLY `S<digits>` ids separated by
   * commas, semicolons, spaces, `y`/`and`, or nested groups of the same kind — `(S1)`, `[S1]`,
   * `(S2, S6)`, `(S2; S6)`, `[S2, S6]`, `[S1 [S2]]`.
   * Returns `{ matched, end, final }`: `matched` is the whole pattern (or null), `end` how many chars it
   * consumes from `start`, and `final` whether a null match is definite. Without `final`, a null match is
   * held only while the text from `start` is still a prefix of a group. A group may hold nested groups one
   * level deep (`nested` is true inside one); a delimiter inside a nested group ends the match, so the
   * recursion depth is at most 2 whatever the text.
   */
  const groupMatch = (start, final, nested = false) => {
    const open = held[start];
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
      const sep = /^(?:[,;]|y\b|and\b)/.exec(held.slice(end));
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
    const notGroup = { matched: null, end: 1, final: true };
    const undecided = { matched: null, end: 0, final: false };
    let j = start + 1;
    let parts = 0;
    // Two ids need a separator or whitespace between them (`(S2S6)` is not a group).
    let prevConsumedSep = false;
    while (j < held.length) {
      const c = held[j];
      if (/\s/.test(c)) { j++; continue; }
      if (c === close) {
        if (parts === 0) return notGroup; // the delimiter alone
        return { matched: held.slice(start, j + 1), end: j + 1 - start, final: true };
      }
      if (c === open) { // nested group: `[S1 [S2]]`
        if (nested) return notGroup;
        const sub = groupMatch(j, final, true);
        if (sub.matched === null) return sub.final ? notGroup : undecided;
        parts++;
        j += sub.end;
        prevConsumedSep = false; // a nested group needs no separator
        continue;
      }
      const id = idPart(j);
      if (id !== null) {
        if (parts > 0 && !prevConsumedSep) return notGroup; // `(S2S6)`: no separator between two ids
        parts++;
        prevConsumedSep = id.hasSep;
        j = id.end;
        continue;
      }
      // `c` cannot start an id, a group or a delimiter. Only a partial `and` after an id (`(S1 an`) can still
      // become a separator once more text arrives.
      if (!final && parts > 0 && "and".startsWith(held.slice(j))) return undecided;
      return notGroup;
    }
    return undecided; // the group may still continue
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
      // Inside a fenced block: pass each line through unchanged until the closing fence line.
      if (region === "fence") {
        const nl = held.indexOf("\n");
        if (nl === -1) {
          if (!final) return;
          emit(held);
          held = "";
          region = null;
          return;
        }
        const line = held.slice(0, nl + 1);
        held = held.slice(nl + 1);
        if (/^ {0,3}`{3,}/.test(line)) region = null; // the closing fence line
        emit(line);
        continue;
      }
      const lineStart = tail === "" || tail.endsWith("\n");
      if (lineStart) {
        // A fenced block opens at a line start with three or more backticks (up to three leading spaces).
        if (/^ {0,3}`{3,}/.test(held)) {
          const nl = held.indexOf("\n");
          if (nl === -1) {
            if (!final) return; // the info string may still be coming
            emit(held);
            held = "";
            region = null;
            return;
          }
          emit(held.slice(0, nl + 1));
          held = held.slice(nl + 1);
          region = "fence";
          continue;
        }
        // A quoted log line passes through unchanged.
        if (held.startsWith(">")) {
          if (held.length === 1) {
            if (!final) return; // it may still become "> "
            emit(">");
            held = "";
            continue;
          }
          if (held[1] !== " ") {
            emit(">"); // a bare ">" is not a quoted line
            held = held.slice(1);
            continue;
          }
          const nl = held.indexOf("\n");
          if (nl === -1) {
            if (!final) return; // the line may still be coming
            emit(held);
            held = "";
            continue;
          }
          emit(held.slice(0, nl + 1));
          held = held.slice(nl + 1);
          continue;
        }
      }
      const start = held.search(/[(\[h`\n]/);
      if (start === -1) {
        emit(held);
        held = "";
        return;
      }
      if (start > 0) {
        emit(held.slice(0, start));
        held = held.slice(start);
      }
      if (held[0] === "\n") {
        emit("\n");
        held = held.slice(1);
        continue;
      }
      if (held[0] === "[" || held[0] === "(") {
        const g = groupMatch(0, final);
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
      if (held[0] === "`") {
        // An inline `code` span passes through to its closing backtick (before the next newline); a lone
        // backtick stays literal. At a line start one or two backticks are held: they may still become a fence.
        if (lineStart && /^[`]{1,2}$/.test(held) && !final) return;
        const close = held.indexOf("`", 1);
        const nl = held.indexOf("\n");
        if (nl !== -1 && (close === -1 || nl < close)) {
          emit("`"); // the newline comes first: a literal backtick, keep scanning the line
          held = held.slice(1);
          continue;
        }
        if (close !== -1) {
          emit(held.slice(0, close + 1)); // the whole span passes through
          held = held.slice(close + 1);
          continue;
        }
        if (!final) return; // no closer and no newline yet: hold
        emit("`");
        held = held.slice(1);
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
