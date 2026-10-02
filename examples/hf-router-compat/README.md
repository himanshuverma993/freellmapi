# HuggingFace-router compatible `.env` (drop-in local router)

If a client is already configured for HuggingFace's Inference Providers router —
or for any gateway that speaks OpenAI Chat Completions with ids like
`org/model:provider` — you can point it at a local FreeLLMAPI and keep the
**same `.env`**: only `LLM_BASE_URL` and `LLM_API_KEY` change.

```diff
 LLM_PROVIDER=openai
-LLM_BASE_URL=https://router.huggingface.co/v1
+LLM_BASE_URL=http://127.0.0.1:8787/v1
-LLM_API_KEY=hf_xxx
+LLM_API_KEY=freellmapi-<your unified key>
 LLM_MODEL=zai-org/GLM-5.3:together
 LLM_FALLBACK_MODELS=moonshotai/Kimi-K3:cerebras,deepseek-ai/DeepSeek-V4-Pro:fireworks-ai
 LLM_ENHANCER_MODEL=zai-org/GLM-5.3-Flash:together
```

That works because FreeLLMAPI resolves those ids in two ways:

1. **Provider pins are stripped automatically.** `moonshotai/Kimi-K3:cerebras`
   falls back to the bare `moonshotai/Kimi-K3` row when the catalog knows it —
   the `:provider` suffix is the other gateway's upstream pin, not part of the
   model identity. Colon-carrying catalog ids (`qwen/qwen3-coder:free`,
   `mistral-large-3:675b`) are never touched, because the exact id resolves.
2. **Aliases** (`FREEAPI_MODEL_ALIASES`, or the `aliases` block in declarative
   config) map everything else — including ids whose model is only *equivalent*
   on your tier, like GLM-5.3 → the free catalog's `glm-5.1`.

## 1. Run the router on the port your client expects

`freellmapi.env.example` in this folder is a repo `.env` with `PORT=8787`
(the port in the example client config). Copy it to the repo root as `.env`,
generate a real `ENCRYPTION_KEY`, and start the server:

```bash
cp examples/hf-router-compat/freellmapi.env.example .env
# put a real 64-char hex key in .env:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm install
npm run dev           # server on http://127.0.0.1:8787, dashboard on the same port
```

Dashboard → **Keys** → add the free provider keys you have (NVIDIA NIM, Google
AI Studio, Groq, Cerebras, OpenRouter, Cloudflare, Zhipu, HuggingFace, …), then
copy the **unified API key** from the Keys page header. That unified key is the
`LLM_API_KEY`.

Check what your install can actually serve before choosing aliases:

```bash
curl -s http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer freellmapi-<key>" | head
# or list the repository's raw catalog:
npx tsx server/src/scripts/export-catalog.ts --stdout | head -40
```

## 2. Pick the alias set that matches your catalog tier

| Client sends | Free install (bundled snapshot) | Live/Premium catalog |
|---|---|---|
| `zai-org/GLM-5.3:together` | `glm-5.1` (NVIDIA, 40 RPM) | `glm-5.3` (UnoRouter) |
| `zai-org/GLM-5.3-Flash:together` | `glm-4.7-flash` (Cloudflare/Zhipu) | `glm-5.3-flash` |
| `moonshotai/Kimi-K3:cerebras` | `kimi-k2.6` (NVIDIA/CF/OpenRouter) | `moonshotai/Kimi-K3` |
| `deepseek-ai/DeepSeek-V4-Pro:fireworks-ai` | `deepseek-v4-pro` (NVIDIA, 40 RPM) | same |

- `aliases.free-install.json` — copy into your `.env` as a single line, or into
  declarative config (`"aliases": { ... }`).
- `aliases.live-catalog.json` — same, for installs on the live feed.

```bash
# repo root .env  (single line, JSON — no trailing commas)
FREEAPI_MODEL_ALIASES={"zai-org/GLM-5.3:together":"glm-5.1","zai-org/GLM-5.3-Flash:together":"glm-4.7-flash","moonshotai/Kimi-K3:cerebras":"kimi-k2.6","deepseek-ai/DeepSeek-V4-Pro:fireworks-ai":"deepseek-v4-pro"}
```

Unmapped ids still work when the catalog knows the bare id — the alias map is
only for the mismatches.

## 3. Client `.env.local`

`app.env.local.example` holds both variants (HuggingFace direct / local
router). Keep the model ids as they are; only the base URL and key change.

## Notes

- **Alias targets** may be a catalog `model_id`, a unified group slug
  (`glm-4.7`, `kimi-k2.6`, `deepseek-v4-pro` — see `GET /v1/models`), or
  `auto` / `auto:<profile>` to hand the choice back to the router.
- **Fallbacks happen twice**: your app retries the next entry in
  `LLM_FALLBACK_MODELS`, and the router itself fails over across providers of
  the same logical model when one is rate-limited. Both are safe.
- A pinned id whose provider has no key answers `503 no_providers_configured`
  (server-side gap) rather than pretending the model does not exist; an id that
  is genuinely unknown answers `404 model_not_found`.
- Rate limits still apply to whatever the alias points at — see the model pages
  on freellmapi.co for live numbers.
