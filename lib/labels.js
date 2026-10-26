/**
 * Source labeling for web tool results and the per-session source map rebuilt from the logged results.
 *
 * Labeled forms written into tool results (and therefore into the session log):
 *   search line:  `- [S3] <title> — <url><rest of line>`  (from `- [<title>](<url>)<rest of line>`)
 *   fetch header: `Fetched [S4] <url> (HTTP <status>)`     (from `Fetched <url> (HTTP <status>)`)
 * The fold parses only these forms, so the map is a function of the log alone.
 */
import { normalizeUrl, urlsIn } from "./normalize.js";

export const CITE_LINE_FROM = "Cite the relevant URLs above as markdown links in your answer.";
export const CITE_LINE_TO = "Cite sources as [S#]. Never type a URL yourself.";

const SOURCE_LINE = /^- \[([^\n]*?)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/;
const FETCH_HEADER = /^Fetched (https?:\/\/\S+) \(HTTP (\d+)\)/;
const LABELED_SOURCE = /^- \[S(\d+)\] (.*) — (https?:\/\/(?:[^()\s]|\([^()\s]*\))+)/;
const LABELED_FETCH = /^Fetched \[S(\d+)\] (https?:\/\/\S+) \(HTTP \d+\)/;

/** Empty per-session state: next free label, label → source, and normalized URLs seen in tool results. */
export function emptyState() {
  return { next: 1, sources: {}, seen: [] };
}

/**
 * Rewrite one tool result text: label each source line and the fetch header, replace the citation line.
 * @param {string} text - the model-facing tool result text.
 * @param {(url: string, title: string) => number} labelFor - returns the label number for a source.
 * @returns {string} the rewritten text (identical when nothing matched).
 */
export function labelText(text, labelFor) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === CITE_LINE_FROM) {
      lines[i] = CITE_LINE_TO;
      continue;
    }
    const fetch = i === 0 ? FETCH_HEADER.exec(line) : null;
    if (fetch) {
      lines[i] = `Fetched [S${labelFor(fetch[1], "")}] ${fetch[1]} (HTTP ${fetch[2]})${line.slice(fetch[0].length)}`;
      continue;
    }
    const source = SOURCE_LINE.exec(line);
    if (source) {
      const title = source[1].replace(/[[\]]/g, "");
      lines[i] = `- [S${labelFor(source[2], title)}] ${title} — ${source[2]}${line.slice(source[0].length)}`;
    }
  }
  return lines.join("\n");
}

/**
 * Allocator over a state snapshot: an exact URL already labeled in the session keeps its label; a new
 * URL takes the next number at or above `floor` (the caller's reservation for concurrent results).
 * @returns {{ labelFor: (url: string, title: string) => number, next: () => number }}
 */
export function allocator(state, floor = state.next) {
  const byUrl = new Map(Object.entries(state.sources).map(([id, s]) => [s.url, Number(id)]));
  let next = Math.max(state.next, floor);
  return {
    labelFor(url) {
      if (!byUrl.has(url)) byUrl.set(url, next++);
      return byUrl.get(url);
    },
    next: () => next,
  };
}

/** Text of a logged `tool/result` event. */
function resultText(event) {
  const content = event.data?.message?.content;
  return Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
}

/**
 * Projection fold: add the labels and seen URLs one committed event contributes. Returns the same state
 * reference for every event that is not a `tool/result`, as the projection registry requires.
 */
export function foldEvent(state, event) {
  if (event.type !== "tool/result") return state;
  const text = resultText(event);
  const sources = { ...state.sources };
  let next = state.next;
  for (const line of text.split("\n")) {
    const labeled = LABELED_SOURCE.exec(line) ?? LABELED_FETCH.exec(line);
    if (!labeled) continue;
    const id = Number(labeled[1]);
    sources[id] = labeled.length === 4 ? { url: labeled[3], title: labeled[2] } : { url: labeled[2], title: "" };
    next = Math.max(next, id + 1);
  }
  const seen = new Set(state.seen);
  const metaUrls = (event.data?.meta?.sources ?? []).map((s) => s?.url).filter((u) => typeof u === "string");
  for (const raw of [...urlsIn(text), ...metaUrls]) {
    const norm = normalizeUrl(raw);
    if (norm !== null) seen.add(norm);
  }
  if (next === state.next && seen.size === state.seen.length && Object.keys(sources).length === Object.keys(state.sources).length) {
    return state;
  }
  return { next, sources, seen: [...seen] };
}

/** Projection state validation used at checkpoint restore (the registry calls `parse`). */
export const stateSchema = {
  parse(value) {
    const ok = value !== null && typeof value === "object"
      && Number.isSafeInteger(value.next) && value.next >= 1
      && value.sources !== null && typeof value.sources === "object"
      && Object.values(value.sources).every((s) => s && typeof s.url === "string" && typeof s.title === "string")
      && Array.isArray(value.seen) && value.seen.every((u) => typeof u === "string");
    if (!ok) throw new TypeError("cite-sources: invalid projection state");
    return value;
  },
};
