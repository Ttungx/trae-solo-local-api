import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseToolcallContent } = require('../../src/anthropic-format');
const { createOpenAIToolcallStreamFilter } = require('../../src/openai-format');
const { resolveFallbackConfig } = require('../../src/trae-client');
const { addTokenUsage } = require('../../src/token-usage');

describe('issue #1 follow-ups', () => {
  it('preserves an explicit saved autoFallback false over model-config defaults', () => {
    const config = resolveFallbackConfig(
      { autoFallback: false, queueThreshold: 42, mappings: { primary: ['backup'] } },
      { autoFallback: true, queueThreshold: 500, mappings: {}, tieredFallback: true, fallbackModel: 'configured-model' }
    );

    expect(config).toEqual({
      autoFallback: false,
      queueThreshold: 42,
      mappings: { primary: ['backup'] },
      tieredFallback: true,
      fallbackModel: 'configured-model'
    });
  });

  it('uses model-config fallback values only when no saved fallback config exists', () => {
    expect(resolveFallbackConfig(null, { autoFallback: false, queueThreshold: 42, mappings: {} }))
      .toEqual({ autoFallback: false, queueThreshold: 42, mappings: {} });
  });

  it('accumulates usage across auto-continue turns', () => {
    const usage = addTokenUsage(
      addTokenUsage(null, { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 }),
      { prompt_tokens: 30, completion_tokens: 100, total_tokens: 130 }
    );

    expect(usage).toEqual({ prompt_tokens: 50, completion_tokens: 200, total_tokens: 250 });
  });

  it('uses prompt plus completion when an upstream total is absent', () => {
    expect(addTokenUsage(null, { prompt_tokens: 20, completion_tokens: 100 }))
      .toEqual({ prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 });
  });

  it('does not reinterpret malformed JSON-like tool input as a tool call', () => {
    const malformed = '{"name":"bash","params":{"command":"echo \'{"a":"1", "b":"2"}\'"}}';
    expect(() => parseToolcallContent(malformed)).toThrow('Could not parse toolcall content');

    const filter = createOpenAIToolcallStreamFilter(parseToolcallContent);
    expect(filter.feed(`<toolcall>${malformed}</toolcall>`)).toEqual({
      emitText: '',
      finishedToolCalls: []
    });
  });

  it('still parses valid tool-call JSON', () => {
    expect(parseToolcallContent('{"name":"bash","params":{"command":"echo hello"}}'))
      .toEqual({ name: 'bash', params: { command: 'echo hello' } });
  });
});
