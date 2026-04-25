import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Bot, GitBranch, PauseCircle, Play, Send, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type WorkspaceInfo = {
  hub_root: string;
  atlas_root: string;
  bus_root: string;
  worktree_root: string;
  provider_config_path: string;
  user_guide_path: string;
  codex_stream_ok: boolean;
  codex_cli: string | null;
  claude_cli: string | null;
};

type ChatRole = "system" | "user" | "codex" | "stderr";

type ChatMessage = {
  role: ChatRole;
  text: string;
  ts: number;
};

type CodexChatProps = {
  workspace: WorkspaceInfo | null;
  statusSnapshot: string;
  eventsSnapshot: string;
  onNotice: (notice: string) => void;
};

const MAX_CONTEXT = 4000;
const MAX_UI_CHUNK = 200 * 1024;

function clip(value: string, max = MAX_CONTEXT) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...[truncated]`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function parseCodexLine(line: string): ChatMessage {
  const safeLine =
    line.length > MAX_UI_CHUNK
      ? `${line.slice(0, MAX_UI_CHUNK)}...[truncated; full chunk written to session log]`
      : line;

  try {
    const value = JSON.parse(safeLine);
    const type = String(value.type ?? "event");
    if (type === "item.completed" && value.item?.type === "agent_message") {
      return {
        role: "codex",
        text: String(value.item.text ?? ""),
        ts: Date.now()
      };
    }
    if (type === "item.completed" || type === "item.started") {
      const itemType = String(value.item?.type ?? "item");
      const summary =
        itemType === "tool_call" || itemType === "tool_result"
          ? `[${itemType}] ${clip(JSON.stringify(value.item), 900)}`
          : `[${itemType}] ${clip(JSON.stringify(value.item ?? value), 900)}`;
      return { role: "system", text: summary, ts: Date.now() };
    }
    if (type === "thread.started") {
      return {
        role: "system",
        text: `thread started: ${value.thread_id}`,
        ts: Date.now()
      };
    }
    if (type === "turn.started") {
      return { role: "system", text: "turn started", ts: Date.now() };
    }
    if (type === "turn.completed") {
      const usage = value.usage ? ` ${JSON.stringify(value.usage)}` : "";
      return { role: "system", text: `turn completed${usage}`, ts: Date.now() };
    }
    if (type === "process.exited") {
      return {
        role: "system",
        text: String(value.message ?? "process exited"),
        ts: Date.now()
      };
    }
    return { role: "system", text: `[${type}] ${clip(JSON.stringify(value), 900)}`, ts: Date.now() };
  } catch {
    return { role: "codex", text: safeLine, ts: Date.now() };
  }
}

export default function CodexChat({
  workspace,
  statusSnapshot,
  eventsSnapshot,
  onNotice
}: CodexChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [repoTarget, setRepoTarget] = useState<"atlas" | "hub">("atlas");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const canStart = Boolean(workspace?.codex_cli && workspace.codex_stream_ok);
  const targetPath = useMemo(() => {
    if (!workspace) {
      return "";
    }
    return repoTarget === "atlas" ? workspace.atlas_root : workspace.hub_root;
  }, [repoTarget, workspace]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let unlistenOut: UnlistenFn | null = null;
    let unlistenErr: UnlistenFn | null = null;
    let closed = false;

    async function attach() {
      unlistenOut = await listen<string>(`codex://${sessionId}/out`, (event) => {
        setMessages((current) => [...current, parseCodexLine(event.payload)]);
      });
      unlistenErr = await listen<string>(`codex://${sessionId}/err`, (event) => {
        setMessages((current) => [
          ...current,
          { role: "stderr", text: event.payload, ts: Date.now() }
        ]);
      });
    }

    void attach().catch((error) => onNotice(String(error)));

    return () => {
      closed = true;
      unlistenOut?.();
      unlistenErr?.();
      if (!closed) {
        return;
      }
      void invoke("codex_session_stop", { sessionId }).catch(() => undefined);
    };
  }, [onNotice, sessionId]);

  async function buildSystemPrompt() {
    let guideIntro = "";
    try {
      guideIntro = await invoke<string>("read_user_guide_intro");
    } catch {
      guideIntro = "Atlas Dev Hub is the local orchestration app for Atlas development.";
    }

    return [
      "You are Codex inside Atlas Dev Hub interactive chat.",
      "The user expects practical engineering help and safe branch-based work.",
      `Target repo: ${repoTarget}.`,
      repoTarget === "hub"
        ? "You are in self-edit mode for atlas-dev-hub. Work only in the created hub worktree."
        : "You are in Atlas mode. Use the Atlas repo as the working root.",
      "",
      "Atlas Dev Hub guide excerpt:",
      clip(guideIntro, 1600),
      "",
      "Current Agent Status snapshot:",
      clip(statusSnapshot, 1200),
      "",
      "Current Events snapshot:",
      clip(eventsSnapshot, 1200)
    ].join("\n");
  }

  async function startSession() {
    if (!canStart) {
      onNotice("Codex JSON stream is unavailable. Check Codex CLI setup.");
      return;
    }
    setBusy(true);
    try {
      const systemPrompt = await buildSystemPrompt();
      const id = await invoke<string>("codex_session_start", {
        repo: repoTarget,
        systemPrompt
      });
      setSessionId(id);
      setMessages([
        {
          role: "system",
          text: `session ${id} started for ${repoTarget}: ${targetPath}`,
          ts: Date.now()
        }
      ]);
      onNotice("Codex chat session started.");
    } catch (error) {
      onNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function stopSession() {
    if (!sessionId) {
      return;
    }
    setBusy(true);
    try {
      await invoke("codex_session_stop", { sessionId });
      setMessages((current) => [
        ...current,
        { role: "system", text: "session stopped", ts: Date.now() }
      ]);
      setSessionId(null);
      onNotice("Codex chat stopped.");
    } catch (error) {
      onNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    if (!sessionId || !input.trim()) {
      return;
    }
    const text = input.trim();
    setBusy(true);
    try {
      await invoke("codex_session_send", { sessionId, text });
      setMessages((current) => [...current, { role: "user", text, ts: Date.now() }]);
      setInput("");
      onNotice("Message sent to Codex.");
    } catch (error) {
      onNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="codex-chat">
      <div className="codex-chat-header">
        <div className="section-title">
          <Bot size={19} />
          <h2>Codex Chat</h2>
        </div>
        <div className="codex-chat-controls">
          <div className="segmented" aria-label="Repo target">
            <button
              className={repoTarget === "atlas" ? "active" : ""}
              onClick={() => setRepoTarget("atlas")}
              disabled={Boolean(sessionId)}
            >
              Atlas
            </button>
            <button
              className={repoTarget === "hub" ? "active" : ""}
              onClick={() => setRepoTarget("hub")}
              disabled={Boolean(sessionId)}
            >
              Dev Hub
            </button>
          </div>
          {sessionId ? (
            <button className="ghost-button" onClick={stopSession} disabled={busy}>
              <PauseCircle size={18} />
              Stop
            </button>
          ) : (
            <button className="primary-button" onClick={startSession} disabled={busy || !canStart}>
              <Play size={18} />
              Start
            </button>
          )}
        </div>
      </div>

      {!workspace?.codex_stream_ok && (
        <div className="inline-warning">
          <ShieldAlert size={16} />
          Codex CLI does not report `codex exec --json`; interactive chat is disabled.
        </div>
      )}

      <div className="codex-target">
        <GitBranch size={16} />
        <span>{sessionId ? `active session ${sessionId}` : `target: ${targetPath || "loading"}`}</span>
      </div>

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            Start a session, then send a message. Dev Hub streams Codex JSONL events here.
          </div>
        ) : (
          messages.map((message, index) => (
            <div className={`chat-message ${message.role}`} key={`${message.ts}-${index}`}>
              <div className="chat-meta">
                <span>{message.role}</span>
                <time>{formatTime(message.ts)}</time>
              </div>
              <p>{message.text}</p>
            </div>
          ))
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder="Ask Codex, or tell it what to change in the selected repo..."
          disabled={!sessionId || busy}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button className="primary-button" onClick={sendMessage} disabled={!sessionId || busy || !input.trim()}>
          <Send size={18} />
          Send
        </button>
      </div>
    </section>
  );
}
