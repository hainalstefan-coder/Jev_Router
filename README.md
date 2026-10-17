# Jev Task Router

Jev Task Router chooses an eligible coding model for each task, then sends the task to your local Codex or GitHub Copilot session. Jev makes the choice through the AI SDK and Vercel AI Gateway; model execution stays with the provider CLI and its signed-in subscription.

## Requirements

- Node.js 22.14 or newer
- Codex CLI signed in to a ChatGPT plan, and/or Copilot CLI signed in to a Copilot account
- A Vercel AI Gateway key for Jev decisions

Install the package:

```sh
npm install --global jev-task-router
```

If your npm version blocks dependency install scripts by default, allow Koffi's native installer:

```sh
npm install --global --allow-scripts=koffi jev-task-router
```

Or run it without a global install:

```sh
npx --yes --package=jev-task-router jev doctor
```

For npm versions that block install scripts, use:

```sh
npm exec --yes --package=jev-task-router --allow-scripts=koffi -- jev doctor
```

## Configure credentials

Set `AI_GATEWAY_API_KEY` in your environment or in `.env.local` in the directory where you run `jev`:

```dotenv
AI_GATEWAY_API_KEY=your-local-vercel-gateway-key
```

The project `.gitignore` excludes `.env.local` and other local environment files. `.env.example` contains placeholders only. Never commit a real key or pass it as a command-line argument.

Artificial Analysis enrichment is optional. Add your own key as `ARTIFICIAL_ANALYSIS_API_KEY` in the environment or `.env.local` if you want its coding and agentic indices. The API key is used only to fetch data locally. Its data stays in your local cache and is never bundled with the package. The free API is intended for internal use with attribution; follow [Artificial Analysis' current API terms](https://artificialanalysis.ai/data-api).

Provider sign-in is handled by the provider's own CLI and account setup. `jev doctor` checks the current local model catalogs and reports setup guidance without printing credential values.

## Commands

```sh
jev doctor
jev models refresh
jev route "Add pagination to the users endpoint"
jev run "Add pagination to the users endpoint"
jev run --provider codex --model gpt-6-sol "Explain this test failure and fix it"
jev run --yes "Update the README examples"
```

`route` previews a recommendation without starting a provider. `run` displays its provider, model, data freshness, subscription information, and rationale, then asks before dispatch. `--yes` skips only this router confirmation. Codex sandbox settings and Copilot permission requests still apply. A provider or model override must match the currently discovered eligible catalog. If Jev or the selected provider fails, the command stops; it does not switch models or providers.

Tasks containing option-like text can be separated from CLI options with `--`, for example:

```sh
jev run --provider codex -- "Handle arguments such as --dry-run in the parser"
```

## Model selection and costs

Jev receives the task text and a small allowlist of candidate metadata: provider and model IDs, display names, context and reasoning capabilities, available benchmark scores, and subscription quota information where reported. It does not receive repository files. The selected local provider receives the task and repository context needed to do the work.

Codex model availability comes from `codex debug models`. Copilot models and quota are read through the authenticated Copilot SDK. Disabled or unconfigured Copilot models and hidden or unsupported Codex models are excluded. The local catalogs are queried for each route; if discovery fails, Jev does not guess.

Codex's plan usage is task- and model-dependent, so the CLI labels per-task cost as unknown. Copilot quota remaining and a reported model usage multiplier are shown when available. Token prices from model data are not treated as subscription costs.

The router refreshes Arena Code (`webdev`) and Agent benchmark data on demand or after 24 hours. Benchmark records are matched to local catalog names exactly after removing common effort labels. Missing matches do not remove a model from the eligible list. Stale or unavailable benchmark data is labeled in the preview.

## Data handling

- The AI Gateway key and optional Artificial Analysis key are read locally and removed from provider subprocess environments.
- The task prompt is sent to Jev for the routing choice and to the selected provider for execution. Jev does not receive repository files.
- The router does not save task prompts. Codex runs with `--ephemeral`; Copilot's temporary session is deleted after normal completion.
- Public model and benchmark metadata are cached under `~/Library/Caches/jev-task-router` on macOS, or the platform cache directory. Cache files are created with owner-only permissions where supported. Copilot quota is kept in memory and not written to the cache.
- Arena benchmark data is sourced from the [Arena leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), licensed CC BY 4.0. Its attribution is also included in [`NOTICE`](NOTICE).
- Optional Artificial Analysis data is fetched with your own key and cached locally only. It is not redistributed or packaged.

The selected provider's own account, retention, and usage policies apply when it executes a task.

## Development and release

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

Tagging a release as `v*` runs the GitHub Actions release workflow. Configure npm Trusted Publishing for this repository and `.github/workflows/release.yml`; the workflow uses GitHub OIDC and does not store an npm publish token.
