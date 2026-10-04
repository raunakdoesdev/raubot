# raubot

A single endless chat whose history is its memory. Every message is kept verbatim in an append-only log. A binary tree of short summaries sits over the log. Each turn, the model sees a fresh, bounded view of the whole conversation: older stretches are summarized more coarsely, recent ones are finer. The model can `zoom` into any part of that view or check its `date`.

Built on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable), which provides durable turns, tools and recovery. It runs inside a SQLite-backed Cloudflare Durable Object.

The design follows Victor Taelin's [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) spec.

## Layout

- `src/worker.ts`: the Worker and the `Raubot` Durable Object. It sets up the pi harness, the `zoom`/`date` tools and the hook that injects the view, then serves a WebSocket at `/ws` and the summary tree at `/tree`.
- `src/memory.ts`: the log, the summary tree, the compactor (8 parallel jobs, retries) and the incremental view fold (128 KB budget, "most due pair" merging).
- `src/sql.ts`: pi-durable's `SqliteDatabase` interface over `ctx.storage.sql`.
- `src/prompts.ts`: the system and compactor prompts, plus the constants.
- `src/ui.html`: a minimal chat page.

## Run

```sh
npm install
echo "OPENAI_API_KEY=sk-..." > .dev.vars
npm run dev       # http://localhost:8787
npm test
npm run deploy    # raubot.reducto.ai, behind Cloudflare Access
```
