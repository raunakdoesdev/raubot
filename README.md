# raubot

## 1. What it is

raubot is a single-user personal agent with a Svelte web app and an optional iMessage channel.
Its conversation is an append-only log. A binary tree of summaries gives the model a bounded view of the whole conversation. The agent can zoom into older messages when it needs more detail.

It uses [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) for durable turns, tools, and recovery. The memory design follows [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).

## 2. Architecture

```text
Web app / iMessage webhook / signed Devin callback
                       |
                 Cloudflare Worker
                       |
              Raubot Durable Object
               SQLite log + summaries
               durable tool execution
                    /        \
           model APIs       Computer Durable Object
           Executor MCP       Linux container
                              browser + Bitwarden
                              Artifacts git workspace
```

- `src/worker.ts` routes requests. `src/app/` serves pages, files, and the WebSocket stream.
- `src/core/raubot.ts` connects the model, memory, tools, and channels. `api.ts` defines the client interface.
- `memory.ts` stores the log and summary tree. `codemode.ts` runs QuickJS scripts. `freezer.ts` saves and restores waiting scripts.
- `agents.ts`, `jobs.ts`, and `cron.ts` run subagents, background jobs, and scheduled prompts. `devin.ts` tracks signed session callbacks.
- `mcp.ts` and `oauth.ts` connect Executor through OAuth with PKCE.
- `box.ts` runs the Linux container. The Artifacts namespace contains two repositories: `workspace` for persistent files and `raubot` for source. Workspace changes are committed after commands. Container snapshots retain installs and large files. See `BOX.md` for the box rules.
- `browser/` contains the browser and vault helpers. `imessage/` contains the Spectrum adapter.
- `web/` contains the Svelte UI. Vite builds it into `web/dist`.

## 3. Local setup

Use Node.js 22.12 or later, npm, and OpenSSL. Cloudflare deployment needs Durable Objects, Workers AI, Artifacts, and Containers with the Durable Object scheduling and snapshot APIs used by this project. Docker is needed for local container work.

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`. Replace the key placeholders with your own values. Generate `SECRETS_KEY` with `openssl rand -base64 32`. Keep this key stable: changing it makes stored secrets unreadable.

```sh
npm run dev
```

Open `http://localhost:8787`. Local chat requires the configured model credentials. Box, Artifacts, Workers AI, and iMessage features also need their Cloudflare or external services. They are not all offline emulators.

## 4. Deployment configuration

`wrangler.jsonc` is a template, not a ready-to-deploy personal configuration. Before deployment:

1. Replace the example domains in `routes` and `PUBLIC_URL`. Use separate domains for the default and staging environments.
2. Set `CLOUDFLARE_ACCOUNT_ID` and `BOX_GIT_EMAIL` in each environment's `vars`.
3. Build and publish your own container image from `box/Dockerfile`. Replace the placeholder image URI in both `containers` entries. Keep the `box` image name. An existing container snapshot needs its original image; do not change a running instance's image without planning for snapshot loss.
4. Create the Artifacts namespaces `raubot` and `raubot-staging`. Seed each with a `workspace` repository with an initial `main` commit, and a `raubot` repository containing this source and its `main` branch. The box clones those repositories, not GitHub.
5. Set the Worker secrets below with `npx wrangler secret put NAME`. Repeat with `--env staging` for staging. `.dev.vars` only supplies local secrets.
6. Protect the deployment with Cloudflare Access before it can receive traffic. The source does not create Access policies.

Non-secret model settings are `PROVIDER`, `MODEL`, and `COMPACT_MODEL`. Supported main-model providers are `openai`, `anthropic`, and `openrouter`. The default uses OpenRouter. Compaction always uses OpenRouter; computer subagents use OpenAI. `EXECUTOR_URL` is the MCP endpoint. `PUBLIC_URL` is the external origin used for secret forms, file links, and callbacks. OAuth uses the request origin. Wrangler environment vars and bindings are not inherited by staging; keep both entries complete.

After configuration and Access are ready, the deployment commands are:

```sh
npm run deploy:staging
npm run deploy
```

Test on your own staging instance, not a live personal instance. If you enable self-deployment, the agent can push its Artifacts source and deploy it from the box with `CF_DEPLOY_TOKEN`.

## 5. Required secrets and connections

| Name | Used for | Required when |
| --- | --- | --- |
| `SECRETS_KEY` | Base64-encoded 32-byte AES-GCM key for user-provided secrets | Always |
| `OPENROUTER_API_KEY` | Default main model and compactor | Always: compaction uses OpenRouter with every main-model provider |
| `OPENAI_API_KEY` | OpenAI models, computer subagents, and voice transcription | `PROVIDER=openai`, computer use, or voice memos |
| `ANTHROPIC_API_KEY` | Anthropic models | `PROVIDER=anthropic` |
| `CF_DEPLOY_TOKEN` | Worker deployment from the box | Agent self-deployment; use a scoped token |
| `SPECTRUM_PROJECT_ID` | Spectrum project selection | iMessage |
| `SPECTRUM_PROJECT_SECRET` | Spectrum SDK authentication | iMessage |
| `SPECTRUM_WEBHOOK_SECRET` | Inbound webhook HMAC verification | iMessage |

Configure Spectrum to send webhooks to `PUBLIC_URL/imessage`. Executor is optional: visit `/oauth/start` to connect your own account. Its OAuth tokens live in Durable Object storage; they are not source configuration.

For Bitwarden, use the agent's secret forms to supply `BW_CLIENTID`, `BW_CLIENTSECRET`, and `BW_PASSWORD`. These go into the encrypted user-secret store and reach box commands through their environment. They are not Worker vars. Browser packages are installed by box setup; install `browser/` and `imessage/` dependencies separately only when working on those helpers outside the box.

Do not commit `.dev.vars`, `.env` files, credentials, vault exports, logs, or conversation data. `.dev.vars.example` contains placeholders only.

## 6. Access and data

This is not a multi-user service. All requests use the same personal Durable Object. Without Access, chat history, files, traces, settings, and agent controls are exposed.

Protect all routes by default, including `/ws`, `/files.json`, `/file/*`, `/agent/*`, `/box`, and OAuth routes. Only exempt the specific integration paths you need: `/imessage` verifies Spectrum signatures; `/s/devin/*` verifies per-run HMAC signatures; `/s/*` uses secret-form capability tokens and serves their assets and preview image. Do not exempt other routes. Keep `workers_dev` disabled to avoid an alternate unprotected hostname.

Conversation data, traces, OAuth tokens, workspace history, browser profiles, and container snapshots persist in your Cloudflare account. The file viewer's allowlist is not a substitute for authentication. Review data retention and the agent's broad shell, browser, and vault permissions before connecting personal accounts.

## 7. Checks

```sh
npm run check   # Worker TypeScript
npm test        # Existing cron and signed-callback tests
npm run build   # Svelte production assets
```

There is no separate lint script. These checks do not deploy the Worker or exercise live integrations. Do not add tests unless requested.

## 8. License

No `LICENSE` file is present. The package metadata says `ISC`, but the owner must confirm the intended license before public release. This cleanup does not select a license.
