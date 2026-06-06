/**
 * Pi provider for NanoClaw.
 *
 * Wraps @mariozechner/pi-agent-core's Agent class as a NanoClaw AgentProvider.
 * Uses @mariozechner/pi-coding-agent for file/shell tools (cherry-picked).
 * NanoClaw MCP tools are wrapped in-process as Pi AgentTools (no MCP subprocess).
 *
 * Design ref: docs/cc/DESIGN-phase1-pi-provider.md
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool, AgentToolUpdateCallback, AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult, ThinkingLevel } from '@mariozechner/pi-agent-core';
import { getEnvApiKey, getModel, streamSimple } from '@mariozechner/pi-ai';
import type { Message, Model, TextContent, UserMessage } from '@mariozechner/pi-ai';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

// Tool module imports trigger registerTools() side effects.
// Do NOT import mcp-tools/index.ts — that starts a stdio MCP server.
import '../mcp-tools/core.js';
import '../mcp-tools/scheduling.js';
import '../mcp-tools/interactive.js';
import '../mcp-tools/agents.js';
import '../mcp-tools/self-mod.js';
import { getRegisteredTools } from '../mcp-tools/server.js';

function log(msg: string): void {
  console.error(`[pi-provider] ${msg}`);
}

function isToolAllowed(toolName: string, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  return allowed.some((pattern) =>
    pattern.endsWith('*')
      ? toolName.startsWith(pattern.slice(0, -1))
      : toolName === pattern,
  );
}

/** Wrap all registered NanoClaw MCP tools as Pi AgentTools. */
function buildNanoClawTools(): AgentTool<any>[] {
  const mcpTools = getRegisteredTools();
  return mcpTools.map((def) => {
    const schema = def.tool.inputSchema as Record<string, unknown>;
    return {
      name: def.tool.name,
      label: def.tool.description ?? def.tool.name,
      description: def.tool.description ?? def.tool.name,
      parameters: schema,
      execute: async (_toolCallId: string, params: unknown) => {
        const result = await def.handler(params as Record<string, unknown>);
        const text = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        const isError = result.isError ?? false;
        return {
          content: [{ type: 'text' as const, text: text || '(no output)' }],
          details: undefined,
          ...(isError ? {} : {}),
        };
      },
    } satisfies AgentTool<any>;
  });
}

// Claude Code / NanoClaw model aliases → Anthropic model IDs registered in pi-ai.
const ALIAS_MAP: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5',
};

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';
const FALLBACK_MODEL_ID = 'claude-3-5-sonnet-20241022';

/**
 * Resolve a NanoClaw model string to a pi-ai Model object.
 *
 * Accepted formats (all map through the 'anthropic' provider unless a
 * provider prefix is given):
 *   - omitted / null      → default (claude-sonnet-4-6)
 *   - "sonnet" / "opus" / "haiku"  → alias expansion
 *   - "claude-sonnet-4-6"           → raw Anthropic model ID
 *   - "anthropic/claude-sonnet-4-6" → explicit provider/modelId
 *   - "deepseek/deepseek-chat"      → arbitrary pi-ai provider/modelId
 *
 * Falls back to the default model when the requested ID is not in the
 * pi-ai catalog so a misconfigured model doesn't crash the runner.
 */
function resolveModel(modelStr?: string) {
  const tryGet = (provider: string, id: string) => {
    try {
      return getModel(provider as never, id as never);
    } catch {
      return null;
    }
  };

  if (!modelStr) {
    return tryGet('anthropic', DEFAULT_MODEL_ID) ?? getModel('anthropic', FALLBACK_MODEL_ID as never);
  }

  // "provider/modelId" explicit form
  const slashIdx = modelStr.indexOf('/');
  if (slashIdx !== -1) {
    const provider = modelStr.slice(0, slashIdx);
    const id = modelStr.slice(slashIdx + 1);
    const resolved = tryGet(provider, id);
    if (resolved) return resolved;
    log(`Model "${modelStr}" not found in pi-ai catalog, falling back to default`);
    return tryGet('anthropic', DEFAULT_MODEL_ID) ?? getModel('anthropic', FALLBACK_MODEL_ID as never);
  }

  // Alias or raw Anthropic model ID
  const id = ALIAS_MAP[modelStr] ?? modelStr;
  const resolved = tryGet('anthropic', id);
  if (resolved) return resolved;
  log(`Model "${modelStr}" (resolved: "${id}") not found in pi-ai catalog, falling back to default`);
  return tryGet('anthropic', DEFAULT_MODEL_ID) ?? getModel('anthropic', FALLBACK_MODEL_ID as never);
}

/**
 * Map NanoClaw/Claude effort strings to pi-agent-core ThinkingLevel.
 * Claude: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 * Pi:     'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
 */
function effortToThinkingLevel(effort?: string): ThinkingLevel | undefined {
  if (!effort) return undefined;
  if (effort === 'max') return 'xhigh';
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort;
  return undefined;
}

/**
 * Recursively expand Claude Code `@` import directives in a file's content.
 * Returns the fully resolved text, or '' if the file cannot be read.
 * Symlinks are followed transparently by fs.readFileSync.
 */
function expandImports(filePath: string, visited = new Set<string>(), depth = 0): string {
  if (depth > 10) return '';

  let realPath: string;
  let content: string;
  try {
    realPath = fs.realpathSync(filePath);
    content = fs.readFileSync(realPath, 'utf8');
  } catch {
    return '';
  }

  if (visited.has(realPath)) return '';
  visited.add(realPath);

  const dir = path.dirname(filePath);
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('@')) {
      const importPath = path.resolve(dir, line.slice(1).trim());
      lines.push(expandImports(importPath, visited, depth + 1));
    } else if (/^<!--.*-->$/.test(line)) {
      // strip single-line compose headers
    } else {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * Load and expand CLAUDE.md + CLAUDE.local.md from the agent workspace,
 * mirroring what Claude Code auto-loads for the Claude provider.
 * Returns '' when running outside a container (no CLAUDE.md present).
 */
function loadWorkspaceInstructions(workspaceDir: string): string {
  const parts: string[] = [];

  const main = expandImports(path.join(workspaceDir, 'CLAUDE.md'));
  if (main.trim()) parts.push(main.trim());

  try {
    const local = fs.readFileSync(path.join(workspaceDir, 'CLAUDE.local.md'), 'utf8');
    if (local.trim()) parts.push(local.trim());
  } catch {
    // optional
  }

  return parts.join('\n\n');
}

/**
 * Convert Pi's AgentMessage[] to the Context-compatible Message[] the LLM expects.
 * Pi's UserMessage / AssistantMessage / ToolResultMessage are already Message-compatible.
 * Custom message types (notifications etc.) are dropped.
 */
function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      typeof m === 'object' &&
      m !== null &&
      'role' in m &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
  );
}

// ─── WebSearch ──────────────────────────────────────────────────────────────

const WEB_SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    count: { type: 'number', description: 'Max results to return (1–20, default 10)', minimum: 1, maximum: 20 },
  },
  required: ['query'],
} as const;

async function braveSearch(query: string, count: number, apiKey: string): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  });
  if (!res.ok) throw new Error(`Brave Search API ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  const results = data.web?.results ?? [];
  if (results.length === 0) return 'No results found.';
  return results
    .slice(0, count)
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
    .join('\n\n');
}

async function tavilySearch(query: string, count: number, apiKey: string): Promise<string> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count }),
  });
  if (!res.ok) throw new Error(`Tavily API ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as {
    results?: Array<{ title: string; url: string; content: string }>;
  };
  const results = data.results ?? [];
  if (results.length === 0) return 'No results found.';
  return results
    .slice(0, count)
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content}`)
    .join('\n\n');
}

function buildWebSearchTool(env: Record<string, string | undefined>): AgentTool<any> {
  const braveKey = env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_SEARCH_API_KEY;
  const tavilyKey = env.TAVILY_API_KEY ?? process.env.TAVILY_API_KEY;
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for current information, documentation, news, or any topic requiring up-to-date external knowledge. Returns a ranked list of results with titles, URLs, and descriptions.',
    parameters: WEB_SEARCH_PARAMS as any,
    execute: async (_id, params: unknown) => {
      const p = params as { query: string; count?: number };
      const count = Math.min(Math.max(p.count ?? 10, 1), 20);
      const query = p.query;
      try {
        let text: string;
        if (braveKey) {
          text = await braveSearch(query, count, braveKey);
        } else if (tavilyKey) {
          text = await tavilySearch(query, count, tavilyKey);
        } else {
          text = 'No search API configured. Set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY in the container environment.';
        }
        return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  } satisfies AgentTool<any>;
}

// ─── WebFetch ────────────────────────────────────────────────────────────────

const WEB_FETCH_PARAMS = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL to fetch' },
    maxLength: {
      type: 'number',
      description: 'Max content characters to return (default 50000)',
      minimum: 1000,
      maximum: 200000,
    },
  },
  required: ['url'],
} as const;

function extractTextFromHtml(html: string): string {
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.replace(/\s+/g, ' ').trim();
}

function buildWebFetchTool(): AgentTool<any> {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch and read the content of a URL. Use for reading web pages, online documentation, articles, or any resource when you know the specific URL.',
    parameters: WEB_FETCH_PARAMS as any,
    execute: async (_id, params: unknown) => {
      const p = params as { url: string; maxLength?: number };
      const maxLen = p.maxLength ?? 50000;
      const url = p.url;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/1.0)' },
          redirect: 'follow',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const ct = res.headers.get('content-type') ?? '';
        let text = await res.text();
        if (ct.includes('html') || ct.includes('xhtml')) {
          text = extractTextFromHtml(text);
        }
        if (text.length > maxLen) {
          text = text.slice(0, maxLen) + `\n\n[Truncated at ${maxLen} chars. Pass a larger maxLength to get more.]`;
        }
        return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  } satisfies AgentTool<any>;
}

// ─── Sub-agent model resolution ───────────────────────────────────────────────

/**
 * Create a Model object for a local OpenAI-compatible endpoint (Ollama/vLLM etc.).
 * Use env vars PI_LOCAL_LLM_ENDPOINT and PI_LOCAL_LLM_MODEL to configure.
 * Verify container → GPU host network connectivity before enabling (see §5.5 of design doc).
 */
function makeLocalLlmModel(endpoint: string, modelId: string): Model<any> {
  return {
    id: modelId,
    name: `Local LLM (${modelId})`,
    api: 'openai-completions',
    provider: 'local',
    baseUrl: endpoint.replace(/\/$/, ''),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  } as unknown as Model<any>;
}

/**
 * Resolve the model for a sub-agent role.
 * Priority: explicit override → role env var → role default.
 * Code default: local LLM if PI_LOCAL_LLM_ENDPOINT set, else claude-haiku-4-5.
 * Research default: deepseek/deepseek-v4-flash.
 */
function resolveSubagentModel(
  override: string | undefined,
  role: 'code' | 'research',
  env: Record<string, string | undefined>,
): ReturnType<typeof resolveModel> {
  if (override) return resolveModel(override);

  const envKey = role === 'code' ? 'PI_CODE_MODEL' : 'PI_RESEARCH_MODEL';
  const envModel = env[envKey] ?? process.env[envKey];
  if (envModel) return resolveModel(envModel);

  if (role === 'code') {
    const endpoint = env.PI_LOCAL_LLM_ENDPOINT ?? process.env.PI_LOCAL_LLM_ENDPOINT;
    if (endpoint) {
      const localId = env.PI_LOCAL_LLM_MODEL ?? process.env.PI_LOCAL_LLM_MODEL ?? 'qwen3-14b';
      log(`code_subagent: using local LLM at ${endpoint} model=${localId}`);
      return makeLocalLlmModel(endpoint, localId) as ReturnType<typeof resolveModel>;
    }
    return resolveModel('claude-haiku-4-5');
  }

  return resolveModel('deepseek/deepseek-v4-flash');
}

// ─── Sub-agent runner ─────────────────────────────────────────────────────────

async function runSubagent(params: {
  task: string;
  model: ReturnType<typeof resolveModel>;
  tools: AgentTool<any>[];
  systemPrompt: string;
  getApiKey: (provider: string) => string | undefined;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<string> {
  const childAgent = new Agent({
    initialState: {
      systemPrompt: params.systemPrompt,
      model: params.model as any,
      tools: params.tools,
    },
    convertToLlm,
    streamFn: (model, context, options) => streamSimple(model, context, options),
    getApiKey: params.getApiKey,
  });

  if (params.signal) {
    params.signal.addEventListener('abort', () => childAgent.abort(), { once: true });
  }

  let finalText = '';
  let stepCount = 0;

  const unsubscribe = childAgent.subscribe((event: AgentEvent) => {
    if (
      event.type === 'message_update' ||
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update'
    ) {
      stepCount++;
      params.onUpdate?.({
        content: [{ type: 'text', text: `[subagent step ${stepCount}]` }],
        details: undefined,
      });
    }

    if (event.type === 'agent_end') {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const m = event.messages[i];
        if (typeof m === 'object' && m !== null && 'role' in m && (m as any).role === 'assistant') {
          const asst = m as { content: Array<{ type: string; text?: string }> };
          const parts = asst.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
          if (parts.length > 0) {
            finalText = parts.join('');
            break;
          }
        }
      }
    }
  });

  try {
    const userMsg: UserMessage = { role: 'user', content: params.task, timestamp: Date.now() };
    await childAgent.prompt(userMsg);
  } finally {
    unsubscribe();
  }

  return finalText;
}

// ─── Sub-agent tool builders ──────────────────────────────────────────────────

const CODE_SUBAGENT_PARAMS = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Coding task — describe what to implement, fix, or refactor, including relevant file paths and constraints' },
    model: { type: 'string', description: 'Optional model override in provider/model-id format (e.g. anthropic/claude-haiku-4-5). Omit to use the configured default.' },
  },
  required: ['task'],
} as const;

const RESEARCH_SUBAGENT_PARAMS = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Research task — describe what information to find, the context, and what format the answer should be in' },
    model: { type: 'string', description: 'Optional model override in provider/model-id format (e.g. deepseek/deepseek-v4-flash). Omit to use the configured default.' },
  },
  required: ['task'],
} as const;

interface SubagentOpts {
  cwd: string;
  env: Record<string, string | undefined>;
  getApiKey: (provider: string) => string | undefined;
}

function buildCodeSubagentTool(opts: SubagentOpts): AgentTool<any> {
  const defaultModel = resolveSubagentModel(undefined, 'code', opts.env);
  return {
    name: 'code_subagent',
    label: 'Code Subagent',
    description: [
      'Launch a coding sub-agent that can read, write, edit, and run code files.',
      'Use for: implementing features, writing scripts, refactoring, fixing bugs, or any task that requires creating or modifying files.',
      'Do NOT use for: web research (use research_subagent instead), answering conceptual questions (answer directly), tasks that only need existing knowledge.',
      'For compound tasks (e.g. "research X then implement it"): call research_subagent first, then code_subagent with the findings included in the task description.',
    ].join('\n'),
    parameters: CODE_SUBAGENT_PARAMS as any,
    execute: async (_id, params: unknown, signal, onUpdate) => {
      const p = params as { task: string; model?: string };
      const model = p.model ? resolveSubagentModel(p.model, 'code', opts.env) : defaultModel;
      const tools: AgentTool<any>[] = [
        createReadTool(opts.cwd),
        createWriteTool(opts.cwd),
        createEditTool(opts.cwd),
        createBashTool(opts.cwd),
        createGrepTool(opts.cwd),
        createFindTool(opts.cwd),
        createLsTool(opts.cwd),
      ];
      const result = await runSubagent({
        task: p.task,
        model,
        tools,
        systemPrompt: 'You are a coding assistant. Complete the requested task carefully and thoroughly, reading existing code before modifying it.',
        getApiKey: opts.getApiKey,
        signal,
        onUpdate,
      });
      return {
        content: [{ type: 'text' as const, text: result || '(coding subagent produced no output)' }],
        details: undefined,
      };
    },
  } satisfies AgentTool<any>;
}

function buildResearchSubagentTool(
  opts: SubagentOpts & { webSearch: AgentTool<any>; webFetch: AgentTool<any> },
): AgentTool<any> {
  const defaultModel = resolveSubagentModel(undefined, 'research', opts.env);
  return {
    name: 'research_subagent',
    label: 'Research Subagent',
    description: [
      'Launch a research sub-agent with web search and web fetch capabilities.',
      'Use for: finding current information, reading online documentation, researching a technology, gathering facts from the web.',
      'Do NOT use for: writing or modifying code files (use code_subagent), tasks that only require knowledge already in context.',
    ].join('\n'),
    parameters: RESEARCH_SUBAGENT_PARAMS as any,
    execute: async (_id, params: unknown, signal, onUpdate) => {
      const p = params as { task: string; model?: string };
      const model = p.model ? resolveSubagentModel(p.model, 'research', opts.env) : defaultModel;
      const tools: AgentTool<any>[] = [opts.webSearch, opts.webFetch];
      const result = await runSubagent({
        task: p.task,
        model,
        tools,
        systemPrompt:
          'You are a research assistant with web search and fetch capabilities. Research the topic thoroughly, verify information from multiple sources when possible, and provide a comprehensive, accurate answer.',
        getApiKey: opts.getApiKey,
        signal,
        onUpdate,
      });
      return {
        content: [{ type: 'text' as const, text: result || '(research subagent produced no output)' }],
        details: undefined,
      };
    },
  } satisfies AgentTool<any>;
}

// ─────────────────────────────────────────────────────────────────────────────

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly tools: AgentTool<any>[];
  private readonly model: ReturnType<typeof resolveModel>;
  private readonly thinkingLevel: ThinkingLevel | undefined;
  private readonly additionalDirectories: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly resolvedGetApiKey: (provider: string) => string | undefined;
  private readonly beforeToolCall: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  private readonly afterToolCall: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

  constructor(options: ProviderOptions = {}) {
    const toolsConfig = options.toolsConfig;
    const cwd = '/workspace/agent'; // default; overridden per-query via QueryInput.cwd
    this.env = options.env ?? {};
    this.resolvedGetApiKey = (provider: string): string | undefined => {
      if (process.env.HTTPS_PROXY) return 'proxy-injected';
      return getEnvApiKey(provider);
    };

    const webSearch = buildWebSearchTool(this.env);
    const webFetch = buildWebFetchTool();

    const allTools: AgentTool<any>[] = [
      createReadTool(cwd),
      createWriteTool(cwd),
      createEditTool(cwd),
      createBashTool(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
      ...buildNanoClawTools(),
      webSearch,
      webFetch,
      buildCodeSubagentTool({ cwd, env: this.env, getApiKey: this.resolvedGetApiKey }),
      buildResearchSubagentTool({ cwd, env: this.env, getApiKey: this.resolvedGetApiKey, webSearch, webFetch }),
    ];

    this.tools =
      toolsConfig?.allowed
        ? allTools.filter((t) => isToolAllowed(t.name, toolsConfig.allowed))
        : allTools;

    this.model = resolveModel(options.model);
    this.thinkingLevel = effortToThinkingLevel(options.effort);
    this.additionalDirectories = options.additionalDirectories ?? [];

    // beforeToolCall: record tool-in-flight so host-sweep can widen stuck tolerance.
    // Also the AMCP mediator insertion point (Phase 3: add IEDI recording here).
    this.beforeToolCall = async (ctx) => {
      try {
        setContainerToolInFlight(ctx.toolCall.name, null);
      } catch (err) {
        log(`beforeToolCall: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    };
    this.afterToolCall = async () => {
      try {
        clearContainerToolInFlight();
      } catch (err) {
        log(`afterToolCall: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    };

    log(`PiProvider ready — ${this.tools.length} tools: ${this.tools.map((t) => t.name).join(', ')}`);
  }

  isSessionInvalid(_err: unknown): boolean {
    // Phase 1: no session persistence. Always start fresh.
    // TODO(phase2): return true when stored continuation sessionId is not found.
    return false;
  }

  query(input: QueryInput): AgentQuery {
    // Internal push queue for follow-up messages
    const pending: string[] = [];
    let waitingResolver: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    // Push-based AsyncIterable for ProviderEvent
    const eventQueue: ProviderEvent[] = [];
    let eventWaiting: (() => void) | null = null;
    let eventsDone = false;

    function pushEvent(ev: ProviderEvent): void {
      eventQueue.push(ev);
      eventWaiting?.();
    }

    function closeEvents(): void {
      eventsDone = true;
      eventWaiting?.();
    }

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (eventQueue.length > 0) {
            yield eventQueue.shift()!;
          }
          if (eventsDone) return;
          await new Promise<void>((resolve) => {
            eventWaiting = resolve;
          });
          eventWaiting = null;
        }
      },
    };

    // Build per-query tool list with correct cwd
    const cwd = input.cwd;
    const toolsConfig = { allowed: this.tools.map((t) => t.name) };
    const webSearch = buildWebSearchTool(this.env);
    const webFetch = buildWebFetchTool();
    const cwdTools: AgentTool<any>[] = [
      createReadTool(cwd),
      createWriteTool(cwd),
      createEditTool(cwd),
      createBashTool(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
      ...buildNanoClawTools(),
      webSearch,
      webFetch,
      buildCodeSubagentTool({ cwd, env: this.env, getApiKey: this.resolvedGetApiKey }),
      buildResearchSubagentTool({ cwd, env: this.env, getApiKey: this.resolvedGetApiKey, webSearch, webFetch }),
    ].filter((t) => isToolAllowed(t.name, toolsConfig.allowed));

    const workspaceInstructions = loadWorkspaceInstructions(input.cwd);
    const extraDirsNote =
      this.additionalDirectories.length > 0
        ? `## Additional directories\n${this.additionalDirectories.map((d) => `- ${d}`).join('\n')}`
        : '';
    const systemPrompt = [
      workspaceInstructions,
      extraDirsNote,
      input.systemContext?.instructions ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const sessionId = input.continuation ?? crypto.randomUUID();

    const agent = new Agent({
      sessionId,
      initialState: {
        systemPrompt,
        model: this.model,
        tools: cwdTools,
        ...(this.thinkingLevel !== undefined ? { thinkingLevel: this.thinkingLevel } : {}),
      },
      convertToLlm,
      streamFn: (model, context, options) => streamSimple(model, context, options),
      getApiKey: this.resolvedGetApiKey,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
    });

    let initEmitted = false;

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      if (aborted) return;

      // Always emit activity on any Pi event (§3 seam 2 — liveness).
      pushEvent({ type: 'activity' });

      switch (event.type) {
        case 'agent_start': {
          if (!initEmitted) {
            initEmitted = true;
            pushEvent({ type: 'init', continuation: sessionId });
          }
          break;
        }

        case 'message_end': {
          const msg = event.message;
          if (typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'assistant') {
            const assistant = msg as { role: 'assistant'; content: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string };
            if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
              pushEvent({
                type: 'error',
                message: assistant.errorMessage ?? 'Pi agent error',
                retryable: assistant.stopReason === 'error',
              });
            }
          }
          break;
        }

        case 'agent_end': {
          // Extract final text from the last assistant message
          const messages = event.messages;
          let finalText: string | null = null;
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (typeof m === 'object' && m !== null && 'role' in m && m.role === 'assistant') {
              const assistant = m as { role: 'assistant'; content: Array<{ type: string; text?: string }> };
              const textParts = assistant.content
                .filter((c): c is TextContent & { type: 'text' } => c.type === 'text')
                .map((c) => c.text);
              if (textParts.length > 0) {
                finalText = textParts.join('');
                break;
              }
            }
          }
          pushEvent({ type: 'result', text: finalText });
          break;
        }

        default:
          // All other events (turn_start/end, message_start/update, tool_execution_*)
          // are already covered by the activity above.
          break;
      }
    });

    // Run the agent prompt, then process follow-ups, then close events.
    (async () => {
      try {
        const userMsg: UserMessage = {
          role: 'user',
          content: input.prompt,
          timestamp: Date.now(),
        };
        await agent.prompt(userMsg);

        // Process follow-up messages until end() / abort().
        // agent.followUp() only works DURING an active run; waitForIdle()
        // resolves immediately when the agent is idle, so follow-ups queued
        // after prompt() resolves are silently dropped. Use prompt() instead
        // so each follow-up starts a real turn with a new agent_end event.
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const text = pending.shift()!;
            const followUp: UserMessage = { role: 'user', content: text, timestamp: Date.now() };
            await agent.prompt(followUp);
            continue;
          }
          await new Promise<void>((resolve) => {
            waitingResolver = resolve;
          });
          waitingResolver = null;
        }
      } catch (err) {
        if (!aborted) {
          pushEvent({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          });
        }
      } finally {
        unsubscribe();
        closeEvents();
      }
    })();

    return {
      push(message: string) {
        pending.push(message);
        waitingResolver?.();
      },
      end() {
        ended = true;
        waitingResolver?.();
      },
      events,
      abort() {
        aborted = true;
        agent.abort();
        waitingResolver?.();
      },
    };
  }
}

registerProvider('pi', (opts) => new PiProvider(opts));
