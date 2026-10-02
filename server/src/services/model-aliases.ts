/**
 * model-aliases — accept the model ids your clients already send.
 *
 * Two problems this solves, both about the string in the request's `model`
 * field rather than about routing itself:
 *
 *   1. **Foreign id spaces.** Apps wired for HuggingFace's Inference Providers
 *      router (or any other gateway) send ids like
 *      `zai-org/GLM-5.3:together` or `moonshotai/Kimi-K3:cerebras`. The
 *      `:provider` suffix is that gateway's way of pinning an upstream, not
 *      part of the model identity. FreeLLMAPI's catalog stores the bare id, so
 *      the request 404s even though the model is right there. When the exact
 *      string does not exist we retry without the trailing `:pin` — but only
 *      when the shorter id actually resolves, so ids that legitimately carry a
 *      colon (`qwen/qwen3-coder:free`, `mistral-large-3:675b`) are untouched.
 *
 *   2. **Deliberate aliases.** An operator can map any id to any other id — or
 *      to `auto` / `auto:<profile>` — without touching the client. Sources, in
 *      increasing precedence: the `model_aliases` setting (dashboard /
 *      declarative config `aliases`), then the `FREEAPI_MODEL_ALIASES` env var.
 *
 * Resolution is a single hop and never recursive: `a → b` maps a request for
 * `a` to `b`, and a request for `b` is resolved exactly as `b` always was.
 * Targets may be a catalog `model_id`, a unified group slug (`glm-4.7`), or
 * `auto` / `auto:<profile>`.
 *
 * Everything here is best-effort by design: an unreadable setting, malformed
 * env JSON, or a DB that is not up yet degrades to "no aliases" and the request
 * keeps its original id, so this module can never break routing on its own.
 */
import { getDb, getSetting, setSetting } from '../db/index.js';
import {
  getModelGroups,
  isUnifyEnabled,
  resolveRequestedIdForDispatch,
} from './model-groups.js';

export const SETTING_MODEL_ALIASES = 'model_aliases';
export const ENV_MODEL_ALIASES = 'FREEAPI_MODEL_ALIASES';

/** `auto`, `auto:smart`, `auto:<profile>` — the router's own pseudo-models. */
export function isAutoModelId(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower === 'auto' || lower.startsWith('auto:');
}

/**
 * Parse an alias map tolerantly. Accepts a JSON object of string → string and
 * drops everything else (non-objects, blank keys/values, non-string values),
 * so a typo in one entry cannot take the whole map — or boot — down.
 */
export function parseModelAliases(raw: string | undefined | null): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const k = key.trim();
      const v = value.trim();
      if (k && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Aliases persisted in settings (declarative config `aliases` writes here). */
export function getModelAliasesFromSettings(): Record<string, string> {
  try {
    return parseModelAliases(getSetting(SETTING_MODEL_ALIASES));
  } catch {
    return {};
  }
}

/**
 * Effective alias map. The env var wins over the stored setting so an operator
 * can override a deployment without editing the dashboard, matching how every
 * other FREEAPI_* env override in this codebase behaves.
 */
export function getModelAliases(): Record<string, string> {
  return {
    ...getModelAliasesFromSettings(),
    ...parseModelAliases(process.env[ENV_MODEL_ALIASES]),
  };
}

export function setModelAliases(aliases: Record<string, string>): void {
  setSetting(SETTING_MODEL_ALIASES, JSON.stringify(aliases));
}

/**
 * The id without a trailing `:provider` pin, or null when the id has no
 * strippable pin.
 *
 * A pin is a bare token: no path separator, no whitespace, and not a leading
 * number. That keeps Ollama-style size tags (`mistral-large-3:675b`,
 * `qwen3-coder:480b`) intact — they are real catalog ids, not provider pins.
 */
export function providerPinBase(modelId: string): string | null {
  const id = modelId.trim();
  const idx = id.lastIndexOf(':');
  if (idx <= 0 || idx === id.length - 1) return null;
  const base = id.slice(0, idx).trim();
  const pin = id.slice(idx + 1).trim();
  if (!base) return null;
  if (pin.includes('/') || /\s/.test(pin) || /^\d/.test(pin)) return null;
  return base;
}

/**
 * Does this catalog know the id — as an enabled-or-disabled row, or as a
 * unified group slug? Read-only and defensive: any DB problem means "unknown",
 * which leaves the caller's original 404 behavior in place.
 */
function modelKnownInCatalog(modelId: string): boolean {
  try {
    const row = getDb().prepare('SELECT 1 FROM models WHERE model_id = ? LIMIT 1').get(modelId);
    if (row) return true;
    if (isUnifyEnabled()) {
      const hit = resolveRequestedIdForDispatch(modelId, getModelGroups());
      if (hit && hit.memberDbIds.length > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Pure core of {@link resolveRequestedModelId}, so tests need no DB. */
export function resolveAliasPure(
  requested: string,
  aliases: Record<string, string>,
  known: (modelId: string) => boolean,
): string {
  const id = requested.trim();
  if (!id) return requested;

  const direct = aliases[id];
  if (direct) return direct;
  if (isAutoModelId(id)) return id;

  const base = providerPinBase(id);
  if (base) {
    const viaAlias = aliases[base];
    if (viaAlias) return viaAlias;
    if (known(base)) return base;
  }
  return id;
}

/**
 * Map a requested model id to the id routing should use. Returns the input
 * unchanged when nothing matches, so callers keep their existing error paths.
 */
export function resolveRequestedModelId(requested: string): string {
  try {
    return resolveAliasPure(requested, getModelAliases(), modelKnownInCatalog);
  } catch {
    return requested;
  }
}
