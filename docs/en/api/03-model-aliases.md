# Model Aliases & Foreign Model-ID Spaces

> **Sources:** `server/src/services/model-aliases.ts`, [`examples/hf-router-compat/`](../../../examples/hf-router-compat/) (runnable setup), env `FREEAPI_MODEL_ALIASES` (documented in [`.env.example`](../../../.env.example)), declarative config key `aliases` (`server/src/services/declarative-config.ts`), resolution call sites in `server/src/routes/proxy.ts` (chat + legacy completions), `server/src/routes/responses.ts`, `server/src/services/anthropic-map.ts`, `server/src/lib/inbound-chat.ts`.

A request's `model` field is normally a catalog id, a unified group slug, or `auto`. Two compatibility paths widen what a client may send **without any catalog change**:

1. **Provider-pin tolerance** — ids of the form `org/model:provider` (HuggingFace Inference Providers style, e.g. `moonshotai/Kimi-K3:cerebras`) fall back to the bare `org/model` when the catalog knows it. The suffix is another gateway's upstream pin, not part of the model identity.
2. **Explicit aliases** — an operator-defined map from any requested id to a catalog `model_id`, a group slug, or `auto` / `auto:<profile>`.

Both are resolved at the top of every routing entry point (OpenAI chat, OpenAI Responses, Anthropic Messages, and the Gemini/Ollama inbound funnel), before any routing decision or 404.

## 1. Provider-pin tolerance

Resolution order for a requested id that is **not** an `auto` id:

```
1. exact alias key            → alias target
2. (if a `:pin` can be stripped)
     a. alias on the stripped id → alias target
     b. stripped id exists in the catalog (any enabled state, or a group) → stripped id
3. otherwise the id is left untouched
```

`providerPinBase()` only strips a trailing `:` segment that looks like a provider pin: no `/`, no whitespace, not starting with a digit. That preserves ids where the colon is meaningful:

| Requested id | Resolves to | Why |
|---|---|---|
| `moonshotai/Kimi-K3:cerebras` | `moonshotai/Kimi-K3` | provider pin, bare id in catalog |
| `deepseek-ai/DeepSeek-V4-Pro:fireworks-ai` | `deepseek-ai/DeepSeek-V4-Pro` | provider pin |
| `qwen/qwen3-coder:free` | unchanged | the exact id is a real catalog row |
| `mistral-large-3:675b` | unchanged | size tag, not a provider pin (leading digit) |

A disabled row counts as "known": resolution succeeds and the request renders the honest statuses the other surfaces already use — `503 no_providers_configured` when the row exists but has no usable key, `404 model_not_found` when nothing matches at all.

## 2. Aliases

| Source | Where | Precedence |
|---|---|---|
| `FREEAPI_MODEL_ALIASES` | repo `.env` — one line of JSON | **wins** |
| `model_aliases` setting | dashboard / `setModelAliases()` | base |
| `aliases` in declarative config (`FREEAPI_CONFIG_JSON` / `FREEAPI_CONFIG_PATH`) | merged into the setting on every boot | base |

```bash
FREEAPI_MODEL_ALIASES={"zai-org/GLM-5.3:together":"glm-5.1","moonshotai/Kimi-K3:cerebras":"kimi-k2.6"}
```

```jsonc
// declarative config
{
  "aliases": {
    "zai-org/GLM-5.3:together": "glm-5.1",
    "zai-org/GLM-5.3-Flash:together": "glm-4.7-flash",
    "moonshotai/Kimi-K3:cerebras": "kimi-k2.6",
    "deepseek-ai/DeepSeek-V4-Pro:fireworks-ai": "deepseek-v4-pro"
  }
}
```

Semantics:

- **Single hop, never recursive.** `a → b` maps a request for `a` to `b`; a request for `b` resolves as `b` always did, so a typo cannot create a loop.
- **Targets**: a catalog `model_id`, a unified slug whose group exists (`glm-4.7`, `kimi-k2.6`, `deepseek-v4-pro` — `GET /v1/models` lists them), `auto`, or `auto:<profile>`.
- **Fail-open.** Unreadable settings, malformed env JSON, a DB that is not up yet, or a target that no longer exists all degrade to "no alias"; the request keeps its original id and the usual 404/503 path.
- Entries are trimmed; blank keys/values and non-string values are dropped individually rather than failing the whole map.

Because resolution happens before routing, aliases work identically for pinned requests and in the Claude-family map (`/v1/messages`): an operator can pin `zai-org/GLM-5.3:together` for the `sonnet` family and it routes like any catalog id.

## 3. Verifying

```bash
# Which slugs exist in this install?
curl -s http://127.0.0.1:3001/v1/models -H "Authorization: Bearer freellmapi-<key>" | head

# A resolved alias reaches routing (503 = resolved, missing key; 404 = unknown id)
curl -s -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-<key>" -H 'Content-Type: application/json' \
  -d '{"model":"zai-org/GLM-5.3:together","messages":[{"role":"user","content":"hi"}]}'
```

Response headers still name what actually served the request (`X-Routed-Via`), so an alias never hides which provider answered.

## Related

- [01-rest-api.md](01-rest-api.md) — the endpoints this affects.
- [../clients/01-agent-clients.md](../clients/01-agent-clients.md) — wiring agents that ship with their own id space.
- [`examples/hf-router-compat/`](../../../examples/hf-router-compat/) — the HuggingFace-router drop-in setup, with ready-made alias files.
