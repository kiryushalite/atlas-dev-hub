# Atlas Dev Hub

Local development orchestrator for Atlas work.

## What It Does

- Starts Codex CLI background tasks in isolated worktrees.
- Starts Claude Code background tasks in isolated worktrees.
- Reads the shared agent bus and run logs.
- Stores Kimi and Perplexity API settings in local app data, outside the repo.
- Lets Kimi and Perplexity answer research or review prompts through API keys.
- Adds a conservative usage guard so heavy work pauses around 70-80% session usage.

## Boundaries

- Atlas itself stays in `../atlas-v0`.
- Dev Hub is a separate tool in `../atlas-dev-hub`.
- This app can later edit itself by creating Dev Hub branches and worktrees, the same way it coordinates Atlas branches.
- Frontend changes can hot-reload through Vite. Tauri/Rust command changes usually need an app restart.
- Detailed worker observability comes from process status, run logs, git diffs, and file watchers. Exact internal file reads depend on what each CLI exposes.

## Start

From the workspace root, run:

```powershell
.\Start Atlas Dev Hub.cmd
```

## Russian Guide

See `USER_GUIDE_RU.md` for the full migration and connection guide.
