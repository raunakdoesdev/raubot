# Your box

`tools.bash` runs in your own Linux box (Debian, Node 22, git).

## What persists
- `/workspace` is a git repo (Artifacts repo `workspace`). Every change is committed and pushed after each bash call, so any version can be restored with git. Files over 10 MB are git-ignored automatically.
- The whole box (installed packages, caches, big files) is snapshotted when idle and restored on the next call.
- Snapshots can be lost (they expire after 30 days unused). Then the box starts fresh from git and runs `/workspace/setup.sh`.

## Rules
- When you install something you want to keep, also append the command to `/workspace/setup.sh`.
- Put big throwaway files (downloads, intermediate data) in `/scratch`. It is never committed and is emptied when the box stops.
- Never change `box/Dockerfile`: a new image can't restore old snapshots. Install in the box instead.

## Improving yourself
Your source is a git clone at `/workspace/raubot` (Artifacts repo `raubot`, branch `main`). It is not auto-saved: commit and push it yourself.
- `src/worker.ts`: Durable Object, tools and model wiring. `src/box.ts`: this box. `src/prompts.ts`: the system prompt. `src/memory.ts`: memory tree and VIEW. `src/ui.html`, `src/tree.html`: web UI. `BOX.md`: this file.
- To change yourself: `git pull`, edit, run `npm run check`, and only if it passes commit with a clear message, `git push`, then `npx wrangler deploy`.
- Deploying restarts you. The conversation and memory survive, and your turn resumes after the restart. Make small, reversible changes and tell the user what you changed and why.
