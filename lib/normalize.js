/**
 * URL comparison rules, ported from ~/dsh-compare/compare.py (`normalize_url`, `urls_in`) so the plugin
 * and the offline audit classify the same URL the same way.
 */

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode the HTML character references that appear in provider URLs (Python `html.unescape` subset). */
export function unescapeHtml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : whole;
  });
}

/** Percent-decode as UTF-8 with U+FFFD for invalid bytes and literal invalid escapes (Python `unquote`). */
export function unquote(text, plus = false) {
  const source = plus ? text.replace(/\+/g, " ") : text;
  return source.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  });
}

/** Split like Python `urllib.parse.urlsplit` for the fields `normalize_url` reads. */
function urlsplit(url) {
  const clean = url.trim().replace(/[\t\r\n]/g, "");
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
  let rest = schemeMatch ? clean.slice(schemeMatch[0].length) : clean;
  let netloc = "";
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end === -1 ? rest.slice(2) : rest.slice(2, 2 + end);
    rest = end === -1 ? "" : rest.slice(2 + end);
  }
  const hashAt = rest.indexOf("#");
  if (hashAt !== -1) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
  let host = netloc.slice(netloc.lastIndexOf("@") + 1);
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]") === -1 ? undefined : host.indexOf("]"));
  else if (host.includes(":")) host = host.slice(0, host.indexOf(":"));
  return { scheme, host: host.toLowerCase(), path, query };
}

/** First non-blank value of `key` in a query string (Python `parse_qs(query).get(key, [''])[0]`). */
function queryParam(query, key) {
  for (const pair of query.split("&")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    const value = unquote(pair.slice(at + 1), true);
    if (unquote(pair.slice(0, at), true) === key && value !== "") return value;
  }
  return "";
}

/**
 * Follow a Bing (`/ck/a?u=a1<base64>`) or DuckDuckGo (`/l/?uddg=`) redirect to its target, in that order.
 * @param {string} raw - an HTML-unescaped, trimmed URL.
 * @returns {string | null} the target (the input when it is no redirect), or null when a redirect cannot be decoded.
 */
function resolveRedirect(raw) {
  let resolved = raw;
  let parsed = urlsplit(resolved);
  if (parsed.host.endsWith("bing.com") && parsed.path.startsWith("/ck/a")) {
    const target = queryParam(parsed.query, "u");
    if (!target.startsWith("a1")) return null;
    try {
      resolved = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(target.slice(2), "base64url"));
    } catch {
      return null; // not UTF-8: Python's .decode('utf-8') raises here and compare.py reports "not comparable"
    }
    parsed = urlsplit(resolved);
  }
  if (parsed.host.endsWith("duckduckgo.com") && parsed.path.startsWith("/l/")) {
    const target = queryParam(parsed.query, "uddg");
    if (target === "") return null;
    resolved = target;
  }
  return resolved;
}

/** HTML-unescaped, trimmed URL without trailing `.,;:*>` (the first step of compare.py `normalize_url`). */
function cleanUrl(url) {
  return unescapeHtml(url).trim().replace(/[.,;:*>]+$/, "");
}

/**
 * Comparable form of a URL: host + percent-decoded path without trailing '/' + decoded query, with Bing and
 * DuckDuckGo redirects resolved to their targets (compare.py `normalize_url`).
 * @param {string} url - a URL as written in a tool result or an answer.
 * @returns {string | null} the comparable form, or null when it cannot be compared.
 */
export function normalizeUrl(url) {
  const resolved = resolveRedirect(cleanUrl(url));
  if (resolved === null) return null;
  const parsed = urlsplit(resolved);
  if ((parsed.scheme !== "http" && parsed.scheme !== "https") || parsed.host === "") return null;
  const path = unquote(parsed.path).replace(/\/+$/, "");
  const query = parsed.query ? `?${unquote(parsed.query)}` : "";
  return `${parsed.host}${path}${query}`;
}

/**
 * The URL to show for a seen URL: HTML-unescaped, with a Bing or DuckDuckGo redirect replaced by its target.
 * @param {string} url - a URL as written in a tool result.
 * @returns {string} the URL to emit (the cleaned input when a redirect cannot be decoded).
 */
export function canonicalUrl(url) {
  const cleaned = cleanUrl(url);
  return resolveRedirect(cleaned) ?? cleaned;
}

const MD_LINK = /\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'\])]+/g;

/**
 * URLs in a text: markdown link targets first, then bare URLs in the remaining text (compare.py `urls_in`).
 * @param {string} text - any text.
 * @returns {Set<string>} the raw URLs.
 */
export function urlsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(MD_LINK)) found.add(m[1]);
  for (const m of text.replace(MD_LINK, "] ").matchAll(BARE_URL)) found.add(m[0]);
  return found;
}
