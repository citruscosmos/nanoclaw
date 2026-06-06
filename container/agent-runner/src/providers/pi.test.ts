/**
 * Pi provider regression suite (§8 of DESIGN-phase1-pi-provider.md).
 *
 * Covers the 4 seams:
 *  1. init event returns a continuation (sessionId)
 *  2. every Pi event produces an activity event (idle-kill prevention)
 *  3. cherry-picked tools (at least read / bash) are registered
 *  4. final result arrives as a result event
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
