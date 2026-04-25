# Task: Codex Embed v1

Goal: add a Codex chat surface to Atlas Dev Hub, plus a self-edit path that targets the `atlas-dev-hub` repository through a separate worktree.

Branch: `agent/codex-embed-v1`

Worktree:

```text
C:\Users\yu9lite\Documents\Codex\2026-04-25\files-mentioned-by-the-user-2\atlas-dev-hub-worktrees\codex-embed-v1
```

Do not touch `atlas-v0`.

## Required Pre-Code Codex CLI Probe

### Command Resolution

`Get-Command codex` resolves to the WindowsApps alias:

```text
C:\Program Files\WindowsApps\OpenAI.Codex_26.422.2437.0_x64__2p2nqsd0c76g0\app\resources\codex.exe
```

Running `codex --help` through that alias fails on this machine with:

```text
Access is denied
```

The callable Codex CLI is:

```text
C:\Users\yu9lite\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OpenAI\Codex\bin\codex.exe
```

It reports:

```text
codex-cli 0.124.0-alpha.2
```

### `codex --help`

The local CLI supports these relevant commands:

```text
exec         Run Codex non-interactively
resume       Resume a previous interactive session
app-server   [experimental] Run the app server or related tooling
exec-server  [EXPERIMENTAL] Run the standalone exec-server service
```

### `codex exec --help`

The non-TTY stream flag is:

```text
--json
```

Help text:

```text
--json
    Print events to stdout as JSONL
```

Prompt input:

```text
[PROMPT]
    Initial instructions for the agent. If not provided as an argument (or if `-` is used),
    instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin
    is appended as a `<stdin>` block.
```

Important implementation note: `codex exec --json` is a JSONL event stream for one non-interactive turn. The help text describes stdin as initial instructions, not as a persistent bidirectional protocol. Continued chat turns are supported by:

```text
codex exec resume --json <THREAD_ID> -
```

Therefore the implementation will use `codex exec --json` for the first turn and `codex exec resume --json` for subsequent sends, while keeping a Dev Hub session registry with the Codex `thread_id`.

### Observed JSONL Format

A successful first turn produced stdout like:

```jsonl
{"type":"thread.started","thread_id":"019dc32e-d6ae-7951-9868-31cc1a8774a0"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CODEX_AUTH_OK"}}
{"type":"turn.completed","usage":{"input_tokens":14806,"cached_input_tokens":2432,"output_tokens":30}}
```

A successful resumed turn produced stdout like:

```jsonl
{"type":"thread.started","thread_id":"019dc32e-d6ae-7951-9868-31cc1a8774a0"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"RESUME_OK"}}
{"type":"turn.completed","usage":{"input_tokens":29660,"cached_input_tokens":17152,"output_tokens":46}}
```

### Auth Probe

`codex exec --json` worked without TUI login. `auth.json` is sufficient on this system.

Probe prompt:

```text
Reply with exactly CODEX_AUTH_OK. Do not modify files.
```

Observed final message:

```text
CODEX_AUTH_OK
```

Resume probe prompt:

```text
Reply with exactly RESUME_OK. Do not modify files.
```

Observed final message:

```text
RESUME_OK
```

Warnings observed on stderr:

- PowerShell shell snapshots are not supported yet.
- Plugin/analytics warmup requests to `chatgpt.com` return 403/Cloudflare HTML, but the Codex turn still completes successfully.

## Implementation Adjustment

The requested persistent `ChildStdin` chat model is not supported by the observed `codex exec --help` contract. To avoid building a UI that hangs waiting for EOF, this implementation will:

- create a logical session in Dev Hub;
- run `codex exec --json` for the initial system prompt;
- capture `thread_id`;
- run `codex exec resume --json <thread_id> -` for each user message;
- stream stdout/stderr lines to Tauri events named `codex://<session_id>/out` and `codex://<session_id>/err`;
- store full per-session chunks in `.agent-runs/codex-chat-<session_id>.log`.
