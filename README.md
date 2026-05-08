# pi-retry-fallback-model

A [pi](https://pi.dev) extension that adds configurable request timeouts and automatic model fallback. When a model request hangs or times out, the extension cancels it, switches to the next model in a user-defined fallback chain, and pi automatically retries with the new model.

## Features

- ⏱ **Configurable timeout** — set per-request timeout (5s, 10s, 20s, 30s, 60s, 90s, or custom ms)
- 🔁 **Automatic fallback chain** — walk through a prioritized list of models on timeout
- 🧠 **Smart model matching** — handles cross-provider model IDs (e.g. `nvidia-nim/qwen/...` vs `qwen/...`)
- 🔌 **No redundant retries** — relies on pi's built-in `setModel()` retry mechanism; no duplicate follow-ups
- 🛑 **Graceful exhaustion** — when all fallbacks are tried, the timeout mechanism disables itself and lets the last request complete naturally
- ⌨️ **Interactive commands** — `/timeout`, `/fallback`, `/fallback-add`, `/timeout-status`

## Installation

```bash
pi install git:github.com/99degree/pi-retry-fallback-model
```

Or clone and install locally:

```bash
git clone https://github.com/99degree/pi-retry-fallback-model.git
pi install ./pi-retry-fallback-model
```

## Configuration

Create `.pi/model-timeout.json` in your project or home directory:

```json
{
  "timeoutMs": 30000,
  "fallbackChain": [
    "minimaxai/minimax-m2.7",
    "z-ai/glm4.7",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "mistralai/mistral-large-3-675b-instruct-2512",
    "google/gemma-3n-e2b-it"
  ]
}
```

Entries in `fallbackChain` use the format `provider/modelId`. They are matched against your available models (from built-in providers, `models.json`, or other extensions). Cross-provider search means `qwen/qwen3-coder-480b-a35b-instruct` matches `nvidia-nim/qwen/qwen3-coder-480b-a35b-instruct` automatically.

### Environment variables

| Variable | Description |
|----------|-------------|
| `PI_MODEL_TIMEOUT_MS` | Override timeout (ms). Overrides config file. |
| `PI_MODEL_TIMEOUT_DISABLE` | Set to `true` to disable the extension entirely. |

## Commands

| Command | Description |
|---------|-------------|
| `/timeout [ms\|off]` | Set timeout in ms, `off` to disable, or run without args for interactive selector |
| `/fallback [model...]` | Set fallback chain (space-separated `provider/modelId` list) |
| `/fallback-add [model]` | Add a model to the end of the fallback chain (interactive selector if no arg) |
| `/timeout-status` | Show current timeout and fallback configuration |

### Examples

```bash
/timeout 15000          # 15 second timeout
/timeout                # interactive selector
/fallback openai/gpt-4 anthropic/claude-sonnet-4
/fallback-add openai/gpt-4o
/timeout-status
```

## How it works

1. **Interceptor** — `before_provider_request` attaches an `AbortController` signal and sets a timeout
2. **Timeout fires** — the request is aborted, `getNextFallback()` finds the next model in the chain
3. **Model switch** — `pi.setModel(model)` switches to the fallback model; pi automatically retries the pending request
4. **Fresh timeout** — a new timeout is set up for the retry, so the chain continues walking even if `before_provider_request` doesn't fire for the retry
5. **Exhaustion** — when no more fallbacks remain, the extension disables itself and lets the last request complete naturally

## Development

```bash
git clone https://github.com/99degree/pi-retry-fallback-model.git
cd pi-retry-fallback-model
# Edit extensions/index.ts
# Test with:
pi -e ./extensions/index.ts
```

The extension uses imports from `@earendil-works/pi-coding-agent` (bundled with pi) and `@earendil-works/pi-tui` (also bundled). No additional npm dependencies required.

## License

MIT