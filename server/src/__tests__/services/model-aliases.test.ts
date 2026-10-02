import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Unit + DB-backed tests for the model-alias resolver: foreign id spaces
// (HuggingFace `org/model:provider`), explicit aliases from the settings row
// and the FREEAPI_MODEL_ALIASES env var, and the guarantee that ids which
// legitimately contain a colon (`qwen/qwen3-coder:free`, Ollama size tags) are
// never rewritten when the exact id resolves.

import { initDb, getDb, setSetting } from '../../db/index.js';
import {
  ENV_MODEL_ALIASES,
  SETTING_MODEL_ALIASES,
  getModelAliases,
  isAutoModelId,
  parseModelAliases,
  providerPinBase,
  resolveAliasPure,
  resolveRequestedModelId,
  setModelAliases,
} from '../../services/model-aliases.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  delete process.env[ENV_MODEL_ALIASES];
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(SETTING_MODEL_ALIASES);
});

// OR IGNORE: several of these ids ship in the bundled baseline migration —
// seeding then only asserts "a row exists", which is exactly what resolution
// checks. A fresh id is inserted; an existing one is left as the catalog made it.
function seedModel(platform: string, modelId: string, enabled = 1): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
    VALUES (?, ?, ?, 5, 5, 'Large', ?)
  `).run(platform, modelId, modelId, enabled);
}

describe('parseModelAliases', () => {
  it('accepts a JSON object of string pairs and trims entries', () => {
    expect(parseModelAliases('{" a ":" b ", "c":"d"}')).toEqual({ a: 'b', c: 'd' });
  });

  it('degrades malformed or non-object input to an empty map', () => {
    expect(parseModelAliases(undefined)).toEqual({});
    expect(parseModelAliases('not json')).toEqual({});
    expect(parseModelAliases('[1,2]')).toEqual({});
    expect(parseModelAliases('{"a":1,"b":""}')).toEqual({});
  });
});

describe('providerPinBase', () => {
  it('strips a bare provider pin', () => {
    expect(providerPinBase('zai-org/GLM-5.3:together')).toBe('zai-org/GLM-5.3');
    expect(providerPinBase('moonshotai/Kimi-K3:cerebras')).toBe('moonshotai/Kimi-K3');
    expect(providerPinBase('deepseek-ai/DeepSeek-V4-Pro:fireworks-ai')).toBe('deepseek-ai/DeepSeek-V4-Pro');
  });

  it('refuses pins that look like real id segments', () => {
    // Ollama size tags are part of the id, not a provider pin.
    expect(providerPinBase('mistral-large-3:675b')).toBeNull();
    expect(providerPinBase('qwen3-coder:480b')).toBeNull();
    expect(providerPinBase('no-colon-here')).toBeNull();
    expect(providerPinBase(':together')).toBeNull();
    expect(providerPinBase('model:')).toBeNull();
    expect(providerPinBase('org/model:with/slash')).toBeNull();
  });
});

describe('resolveAliasPure', () => {
  const known = (id: string) => ['org/model', 'glm-5.3'].includes(id);

  it('maps an exact alias before anything else', () => {
    expect(resolveAliasPure('anything', { anything: 'glm-5.3' }, known)).toBe('glm-5.3');
  });

  it('passes auto ids through untouched', () => {
    expect(resolveAliasPure('auto', {}, known)).toBe('auto');
    expect(resolveAliasPure('auto:smart', { 'auto:smart': 'glm-5.3' }, known)).toBe('glm-5.3');
    expect(resolveAliasPure('auto:smart', {}, known)).toBe('auto:smart');
    expect(isAutoModelId('AUTO:fast')).toBe(true);
  });

  it('falls back to the pin-stripped id when the catalog knows it', () => {
    expect(resolveAliasPure('org/model:together', {}, known)).toBe('org/model');
  });

  it('uses an alias registered on the pin-stripped id', () => {
    expect(resolveAliasPure('org/model:together', { 'org/model': 'glm-5.3' }, () => false)).toBe('glm-5.3');
  });

  it('keeps the original id when nothing matches', () => {
    expect(resolveAliasPure('org/unknown:pin', {}, known)).toBe('org/unknown:pin');
    expect(resolveAliasPure('qwen/qwen3-coder:free', {}, () => false)).toBe('qwen/qwen3-coder:free');
  });

  it('never rewrites an id that resolves exactly, colon and all', () => {
    const exact = (id: string) => id === 'qwen/qwen3-coder:free';
    expect(resolveAliasPure('qwen/qwen3-coder:free', {}, exact)).toBe('qwen/qwen3-coder:free');
  });

  it('is single-hop (no alias recursion)', () => {
    expect(resolveAliasPure('a', { a: 'b', b: 'c' }, () => false)).toBe('b');
  });
});

describe('resolveRequestedModelId (DB-backed)', () => {
  it('resolves HF-style ids against real catalog rows', () => {
    seedModel('huggingface', 'moonshotai/Kimi-K3');
    expect(resolveRequestedModelId('moonshotai/Kimi-K3:cerebras')).toBe('moonshotai/Kimi-K3');
  });

  it('keeps the exact id when the row exists', () => {
    // Ships in the baseline migration: a colon-carrying id that must NOT be
    // mistaken for a provider pin.
    seedModel('openrouter', 'qwen/qwen3-coder:free');
    expect(resolveRequestedModelId('qwen/qwen3-coder:free')).toBe('qwen/qwen3-coder:free');
  });

  it('reads aliases from the settings row', () => {
    seedModel('unorouter', 'glm-5.3:free');
    setModelAliases({ 'zai-org/GLM-5.3:together': 'glm-5.3:free' });
    expect(getModelAliases()).toEqual({ 'zai-org/GLM-5.3:together': 'glm-5.3:free' });
    expect(resolveRequestedModelId('zai-org/GLM-5.3:together')).toBe('glm-5.3:free');
  });

  it('lets the env var override the stored setting', () => {
    setModelAliases({ 'zai-org/GLM-5.3:together': 'glm-5.3:free' });
    process.env[ENV_MODEL_ALIASES] = JSON.stringify({ 'zai-org/GLM-5.3:together': 'auto' });
    expect(resolveRequestedModelId('zai-org/GLM-5.3:together')).toBe('auto');
  });

  it('aliases can point at auto / auto:<profile>', () => {
    setSetting(SETTING_MODEL_ALIASES, JSON.stringify({
      'zai-org/GLM-5.3-Flash:together': 'auto:fast',
      'deepseek-ai/DeepSeek-V4-Pro:fireworks-ai': 'auto',
    }));
    expect(resolveRequestedModelId('zai-org/GLM-5.3-Flash:together')).toBe('auto:fast');
    expect(resolveRequestedModelId('deepseek-ai/DeepSeek-V4-Pro:fireworks-ai')).toBe('auto');
  });

  it('leaves unknown ids alone so the caller keeps its 404 path', () => {
    expect(resolveRequestedModelId('nobody/knows:this')).toBe('nobody/knows:this');
  });

  it('survives a disabled row (resolution happens, routing reports disabled)', () => {
    seedModel('huggingface', 'deepseek-ai/DeepSeek-V4-Pro', 0);
    expect(resolveRequestedModelId('deepseek-ai/DeepSeek-V4-Pro:fireworks-ai'))
      .toBe('deepseek-ai/DeepSeek-V4-Pro');
  });
});
