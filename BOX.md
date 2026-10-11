# Your box

`tools.bash` runs in your own Linux box. It is a Boat VM (Ubuntu 24.04, Node 24, Chrome, a desktop, sudo) or a Cloudflare container (Debian, Node 22). The Cloudflare container is the default, and it is also the fallback when Boat is down. `[box: ...]` notes tell you when the box changed.

## What persists
- `/workspace` is a git repo (Artifacts repo `workspace`). Every change is committed and pushed after each bash call, so any version can be restored with git. Files over 10 MB are git-ignored automatically.
- Boat: the disk persists across stops (`/home/user`, `/workspace`, and installs under `/usr`, `/etc` and `/opt`). There is no replay. `~/.cache` and `/scratch` are not kept.
- Cloudflare: the whole box is snapshotted when idle and restored on the next call. Snapshots can be lost (they expire after 30 days unused). Then the box starts fresh from git and runs `/workspace/setup.sh`.

## Rules
- When you install something you want to keep, also append the command to `/workspace/setup.sh`. The Cloudflare fallback needs it.
- Never write secrets to disk. They come in each command's env.
- Put big throwaway files (downloads, intermediate data) in `/scratch`. It is never committed and is emptied when the box stops.
- Never change `box/Dockerfile`: a new image can't restore old snapshots. Install in the box instead.

## Improving yourself
Your source is a git clone at `/workspace/raubot` (Artifacts repo `raubot`, branch `main`). It is not auto-saved: commit and push it yourself.
- `src/core/raubot.ts`: Durable Object, tools and model wiring. `src/core/box.ts`: this box. `src/core/prompts.ts`: the system prompt. `src/core/memory.ts`: memory tree and VIEW. `src/core/channels/`: channel adapters (iMessage). `src/app/`: web UI. `BOX.md`: this file.
- To change yourself: `git pull`, edit, run `npm run check`, and only if it passes commit with a clear message, `git push`, then `npx wrangler deploy`.
- Deploying restarts you. The conversation and memory survive, and your turn resumes after the restart. Make small, reversible changes and tell the user what you changed and why.
