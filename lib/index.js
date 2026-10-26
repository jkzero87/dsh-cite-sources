/**
 * dsh-cite-sources: citable source labels for web tools and a verified-citation rewrite of assistant text.
 *
 * - `tools/post-execute`: labels each source of the configured web tools as `[S#]` in the tool result
 *   content (logged as `tool/result`; `meta`, and so the UI cards, is unchanged). Labels continue across
 *   the session; an exact URL already labeled keeps its label.
 * - Host-only projection `citeSources`: the label map and the normalized URLs seen in tool results,
 *   folded from logged `tool/result` events, so it is rebuilt from the log on resume.
 * - `llm/stream`: for agent-loop requests, rewrites text blocks while they stream (see transducer.js).
 *   The rewritten deltas and block end are what the loop logs as `assistant/message`.
 */
import { isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { allocator, emptyState, foldEvent, labelText, stateSchema } from "./labels.js";
import { rewriteStream } from "./stream.js";

const name = "cite-sources";
const inject = ["sessions", "sessionProjections"];

const PROJECTION_KEY = "citeSources";
const DEFAULT_TOOLS = ["web_search", "advanced_search", "platform_search", "web_fetch"];
const DEFAULT_MARKER = " ⚠️(unverified)";

/** Validate the row config; misconfiguration fails at load. */
function resolveConfig(config) {
  const tools = config?.tools ?? DEFAULT_TOOLS;
  const marker = config?.marker ?? DEFAULT_MARKER;
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === "string" && t.length > 0)) {
    throw new TypeError("cite-sources: config.tools must be a non-empty array of tool names");
  }
  if (typeof marker !== "string" || marker.length === 0) {
    throw new TypeError("cite-sources: config.marker must be a non-empty string");
  }
  return { tools: new Set(tools), marker };
}

function apply(ctx, config) {
  const { tools, marker } = resolveConfig(config);
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema,
    stateVersion: 2,
    init: () => emptyState(),
    apply: foldEvent,
  });
  const readState = (session) => ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? emptyState();
  // Labels handed out to results not yet committed (parallel calls in one step), per session.
  const reserved = new WeakMap();

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    const session = exec.agent?.session;
    if (decision.kind !== "accept" || Object.hasOwn(decision, "value") || result.isError
      || exec.parent !== undefined || session === undefined || !tools.has(exec.name)) {
      return decision;
    }
    const alloc = allocator(readState(session), reserved.get(session) ?? 0);
    const content = (decision.content ?? result.content).map((block) => (
      block.type === "text" ? { ...block, text: labelText(block.text, alloc.labelFor) } : block
    ));
    reserved.set(session, alloc.next());
    return { ...decision, content };
  });

  ctx.on("llm/stream", (options, next) => {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next();
    const session = ctx.sessions.get(options.sessionId);
    if (session === undefined) return next();
    return rewriteStream(next(), () => readState(session), marker);
  });
}

export { name, inject, apply };
