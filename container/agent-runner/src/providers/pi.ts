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

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool, AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult } from '@mariozechner/pi-agent-core';
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

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

// Tool module imports trigger registerTools() side effects.
// Do NOT import mcp-tools/index.ts — that starts a stdio MCP server.
import '../mcp-tools/core.js';
import '../mcp-tools/scheduling.js';
import '../mcp-tools/interactive.js';
import '../mcp-tools/agents.js';
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

/** Build the default Anthropic Sonnet model for the main agent. */
function buildDefaultModel() {
  // claude-sonnet-4-6 is the model in use (matches current NanoClaw env).
  // Fall back gracefully to a stable known ID if something changes.
  try {
    return getModel('anthropic', 'claude-sonnet-4-6' as never);
  } catch {
    return getModel('anthropic', 'claude-3-5-sonnet-20241022' as never);
  }
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
  private readonly model: ReturnType<typeof buildDefaultModel>;
  private readonly systemPromptBase: string;
  private readonly beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  private readonly afterToolCall?: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

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

    this.model = buildDefaultModel();
    this.systemPromptBase = '';

    // AMCP mediator hook points — empty pass-through in Phase 1.
    // Phase 3: wire beforeToolCall / afterToolCall for IEDI recording.
    this.beforeToolCall = undefined;
    this.afterToolCall = undefined;

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

    const systemPrompt = [
      this.systemPromptBase,
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
      },
      convertToLlm,
      streamFn: (model, context, options) => streamSimple(model, context, options),
      getApiKey: (provider) => {
        if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
        return undefined;
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
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const text = pending.shift()!;
            const followUp: UserMessage = { role: 'user', content: text, timestamp: Date.now() };
            agent.followUp(followUp);
            await agent.waitForIdle();
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
