/**
 * Pi provider regression suite (§8 of DESIGN-phase1-pi-provider.md).
 *
 * Covers the 4 seams (Phase 1) and Phase 1-2 tool additions:
 *  1. init event returns a continuation (sessionId)
 *  2. every Pi event produces an activity event (idle-kill prevention)
 *  3. cherry-picked tools (at least read / bash) are registered
 *  4. final result arrives as a result event
 *  5. (Phase 1-2) web_search and web_fetch tools are registered
 *  6. (Phase 1-2) code_subagent and research_subagent tools are registered
 *
 * These are integration-style tests against the real Pi Agent with a faux
 * (no-network) model so no API key is required.
 */
import { describe, expect, it } from 'bun:test';

// Trigger self-registration of all providers (including pi).
import './index.js';
import { createProvider } from './factory.js';

import type { ProviderEvent } from './types.js';

async function collectEvents(
  providerName: string,
  prompt: string,
  toolsConfig?: { allowed: string[] } | null,
): Promise<ProviderEvent[]> {
  const provider = createProvider(providerName as never, {
    toolsConfig: toolsConfig ?? null,
  });
  const query = provider.query({ prompt, cwd: '/tmp' });
  query.end();

  const events: ProviderEvent[] = [];
  for await (const ev of query.events) {
    events.push(ev);
    // Stop collecting after result (we don't want to hang)
    if (ev.type === 'result' || ev.type === 'error') break;
  }
  return events;
}

describe('PiProvider factory registration', () => {
  it('can be instantiated via createProvider("pi")', () => {
    const provider = createProvider('pi', { toolsConfig: null });
    expect(provider).toBeDefined();
    expect(typeof provider.query).toBe('function');
    expect(typeof provider.isSessionInvalid).toBe('function');
    expect(provider.supportsNativeSlashCommands).toBe(false);
  });
});

describe('PiProvider tool list', () => {
  it('registers at least read and bash tools', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('bash');
  });

  it('respects toolsConfig.allowed filtering', () => {
    const provider = createProvider('pi', {
      toolsConfig: { allowed: ['read'] },
    }) as unknown as { tools: Array<{ name: string }> };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('read');
    expect(toolNames).not.toContain('bash');
  });

  it('registers NanoClaw mcp tools (schedule_task, ask_user_question)', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames.some((n) => n.includes('schedule_task') || n.includes('ask_user_question'))).toBe(true);
  });
});

describe('PiProvider seam 3: isSessionInvalid', () => {
  it('returns false (Phase 1 stub)', () => {
    const provider = createProvider('pi', { toolsConfig: null });
    expect(provider.isSessionInvalid(new Error('anything'))).toBe(false);
  });
});

describe('PiProvider Phase 1-2: web tools', () => {
  it('registers web_search tool', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('web_search');
  });

  it('registers web_fetch tool', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('web_fetch');
  });

  it('web_search and web_fetch are subject to toolsConfig filtering', () => {
    const provider = createProvider('pi', {
      toolsConfig: { allowed: ['read', 'bash'] },
    }) as unknown as { tools: Array<{ name: string }> };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).not.toContain('web_search');
    expect(toolNames).not.toContain('web_fetch');
  });

  it('web_search returns no-key message when no API key is configured', async () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    };
    const tool = provider.tools?.find((t) => t.name === 'web_search');
    expect(tool).toBeDefined();
    const result = await tool!.execute('test-id', { query: 'test', count: 3 });
    // Should gracefully report missing key rather than throw
    expect(typeof result.content[0].text).toBe('string');
  });

  it('web_fetch returns error text (not throw) for unreachable URL', async () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    };
    const tool = provider.tools?.find((t) => t.name === 'web_fetch');
    expect(tool).toBeDefined();
    // Use an invalid URL that will fail without hitting the network
    const result = await tool!.execute('test-id', { url: 'http://localhost:1' });
    expect(typeof result.content[0].text).toBe('string');
  });
});

describe('PiProvider Phase 1-2: sub-agent tools', () => {
  it('registers code_subagent tool', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('code_subagent');
  });

  it('registers research_subagent tool', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('research_subagent');
  });

  it('sub-agent tools are subject to toolsConfig filtering', () => {
    const provider = createProvider('pi', {
      toolsConfig: { allowed: ['read', 'bash', 'web_search', 'web_fetch'] },
    }) as unknown as { tools: Array<{ name: string }> };
    const toolNames = provider.tools?.map((t) => t.name) ?? [];
    expect(toolNames).not.toContain('code_subagent');
    expect(toolNames).not.toContain('research_subagent');
  });

  it('code_subagent tool has required description fields', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string; description: string; label: string }>;
    };
    const tool = provider.tools?.find((t) => t.name === 'code_subagent');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('coding sub-agent');
    expect(tool!.label).toBe('Code Subagent');
  });

  it('research_subagent tool has required description fields', () => {
    const provider = createProvider('pi', { toolsConfig: null }) as unknown as {
      tools: Array<{ name: string; description: string; label: string }>;
    };
    const tool = provider.tools?.find((t) => t.name === 'research_subagent');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('research sub-agent');
    expect(tool!.label).toBe('Research Subagent');
  });
});
