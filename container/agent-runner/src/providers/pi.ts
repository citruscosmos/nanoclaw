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
import type { AgentEvent, AgentMessage, AgentTool, AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult, ThinkingLevel } from '@mariozechner/pi-agent-core';
import { getModel, streamSimple } from '@mariozechner/pi-ai';
import type { Message, TextContent, UserMessage } from '@mariozechner/pi-ai';
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

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly tools: AgentTool<any>[];
  private readonly model: ReturnType<typeof resolveModel>;
  private readonly thinkingLevel: ThinkingLevel | undefined;
  private readonly additionalDirectories: string[];
  private readonly beforeToolCall: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  private readonly afterToolCall: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

  constructor(options: ProviderOptions = {}) {
    const toolsConfig = options.toolsConfig;
    const cwd = '/workspace/agent'; // default; overridden per-query via QueryInput.cwd

    const allTools: AgentTool<any>[] = [
      createReadTool(cwd),
      createWriteTool(cwd),
      createEditTool(cwd),
      createBashTool(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
      ...buildNanoClawTools(),
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
    const cwdTools: AgentTool<any>[] = [
      createReadTool(cwd),
      createWriteTool(cwd),
      createEditTool(cwd),
      createBashTool(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
      ...buildNanoClawTools(),
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
      getApiKey: (_provider) => {
        // When OneCLI proxy is active (HTTPS_PROXY), return a placeholder so
        // the Pi agent proceeds to make the request. The proxy intercepts the
        // call and injects the real credential for the matching host pattern.
        // Without a proxy, fall back to standard env vars.
        if (process.env.HTTPS_PROXY) return 'proxy-injected';
        return (
          process.env.ANTHROPIC_API_KEY ||
          process.env.ANTHROPIC_OAUTH_TOKEN ||
          process.env.DEEPSEEK_API_KEY
        );
      },
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
