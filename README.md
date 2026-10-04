# raubot

A single endless chat whose history is its memory. Every message is kept verbatim in an append-only log. A binary tree of short summaries sits over the log. Each turn, the model sees a fresh, bounded view of the whole conversation: older stretches are summarized more coarsely, recent ones are finer. The model can `zoom` into any part of that view or check its `date`.

Built on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable), which provides durable turns, tools and recovery. It runs inside a SQLite-backed Cloudflare Durable Object.

The design follows Victor Taelin's [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) spec.

## Layout

- `src/worker.ts`: the Worker and the `Raubot` Durable Object. It sets up the pi harness, the `zoom`/`date` tools and the hook that injects the view, then serves a WebSocket at `/ws` and the summary tree at `/tree`.
- `src/memory.ts`: the log, the summary tree, the compactor (8 parallel jobs, retries) and the incremental view fold (128 KB budget, "most due pair" merging).
- `src/sql.ts`: pi-durable's `SqliteDatabase` interface over `ctx.storage.sql`.
- `src/prompts.ts`: the system and compactor prompts, plus the constants.
- `src/box.ts`: the `Computer` container (Durable Object scheduling policy, needed for snapshots) behind the `bash` tool. `/workspace` is a clone of the Artifacts repo `raubot/workspace`, auto-committed and pushed after every command (files over 10 MB are git-ignored). The whole container filesystem is also saved as a Container snapshot when idle for 10 minutes (and every 15 minutes while in use), so installs and big files persist. `/workspace/raubot` is a clone of this repo. The box rules (setup.sh, /scratch, self-deploy) live in `BOX.md`, which the prompt points raubot to.
- `src/ui.html`: a minimal chat page.

## Source and deploys

The code lives in the Cloudflare Artifacts repo `raubot/raubot` (namespace `raubot`). raubot deploys itself from the box: it pushes to `main`, then runs `npx wrangler deploy` with the `CF_DEPLOY_TOKEN` secret (a token that can only deploy Workers). The box gets short-lived Artifacts git tokens from the `ARTIFACTS` binding, so there is no GitHub token.

## Run

Don't create tests unless the user asks for them.

```sh
npm install
echo "OPENAI_API_KEY=sk-..." > .dev.vars
npm run dev       # http://localhost:8787
npm run deploy    # raubot.reducto.ai, behind Cloudflare Access
```
