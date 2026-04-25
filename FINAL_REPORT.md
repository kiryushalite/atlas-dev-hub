# Final Report: Codex Embed v1

## 1. Codex CLI Stream Flag

The usable CLI is:

```text
C:\Users\yu9lite\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OpenAI\Codex\bin\codex.exe
```

The WindowsApps `codex` alias is blocked with `Access is denied`.

The stream flag is:

```text
codex exec --json
```

Stdout format is JSONL. Observed event examples:

```jsonl
{"type":"thread.started","thread_id":"019dc32e-d6ae-7951-9868-31cc1a8774a0"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CODEX_AUTH_OK"}}
{"type":"turn.completed","usage":{"input_tokens":14806,"cached_input_tokens":2432,"output_tokens":30}}
```

Important adjustment: `codex exec --help` describes stdin as initial instructions for one turn, not a persistent bidirectional protocol. The implementation therefore uses `codex exec --json` for the first turn and `codex exec resume --json <thread_id> -` for subsequent chat sends.

Auth probe passed without TUI login. `auth.json` is sufficient on this system.

## 2. New Tauri Commands

```rust
codex_session_start(app: AppHandle, repo: String, system_prompt: String) -> Result<String, String>
codex_session_send(app: AppHandle, session_id: String, text: String) -> Result<(), String>
codex_session_stop(session_id: String) -> Result<(), String>
read_user_guide_intro() -> Result<String, String>
```

`WorkspaceInfo` now includes:

```rust
codex_stream_ok: bool
```

Existing background commands remain in place:

```rust
start_codex_task(...)
start_claude_task(...)
```

## 3. User Flow

1. Open Atlas Dev Hub.
2. Find the new `Codex Chat` section above `Agent Status`.
3. Choose target:
   - `Atlas` for the Atlas repo.
   - `Dev Hub` for self-edit mode.
4. Press `Start`.
5. Wait for the thread/session messages.
6. Type a message and press `Send`.
7. Press `Stop` when done.

For `Dev Hub`, the backend creates a separate git worktree and runs Codex there.

## 4. Hub Worktree Collision Handling

For `repo="hub"`, the backend creates:

```text
..\atlas-dev-hub-worktrees\codex-chat-<session_short_id>
```

with branch:

```text
agent/codex-hub-<session_short_id>
```

If the worktree path already exists, session start returns an error and does not overwrite it. If the branch already exists, `git worktree add -b ...` fails and the error is returned to the UI.

## 5. Checks

Passed:

```text
npm run build
```

Passed:

```text
cargo check --manifest-path src-tauri/Cargo.toml
```

## Notes

- Full stdout/stderr chunks are written to `.agent-runs/codex-chat-<session_id>.log`.
- UI chunks over 200 KB are truncated in the chat but preserved in the per-session log.
- No changes were made to `atlas-v0`.
- Kimi/Perplexity provider config format was not changed.
