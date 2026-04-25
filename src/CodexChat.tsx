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

type RestoredCodexSession = {
  session_id: string;
  repo: "atlas" | "hub";
  cwd: string;
  thread_id: string | null;
  log_tail: string[];
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

function roleLabel(role: ChatRole) {
  switch (role) {
    case "system":
      return "система";
    case "user":
      return "ты";
    case "codex":
      return "codex";
    case "stderr":
      return "ошибка";
    default:
      return role;
  }
}

function parseCodexLine(line: string): ChatMessage {
  const safeLine =
    line.length > MAX_UI_CHUNK
      ? `${line.slice(0, MAX_UI_CHUNK)}...[обрезано; полный фрагмент записан в лог сессии]`
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
        text: `тред запущен: ${value.thread_id}`,
        ts: Date.now()
      };
    }
    if (type === "turn.started") {
      return { role: "system", text: "ход начался", ts: Date.now() };
    }
    if (type === "turn.completed") {
      const usage = value.usage ? ` ${JSON.stringify(value.usage)}` : "";
      return { role: "system", text: `ход завершён${usage}`, ts: Date.now() };
    }
    if (type === "process.exited") {
      return {
        role: "system",
        text: String(value.message ?? "процесс завершён"),
        ts: Date.now()
      };
    }
    return { role: "system", text: `[${type}] ${clip(JSON.stringify(value), 900)}`, ts: Date.now() };
  } catch {
    return { role: "codex", text: safeLine, ts: Date.now() };
  }
}

function parseStoredLogLine(line: string): ChatMessage | null {
  if (line.startsWith("[out] ")) {
    return parseCodexLine(line.slice(6));
  }
  if (line.startsWith("[err] ")) {
    return { role: "stderr", text: normalizeStderr(line.slice(6)), ts: Date.now() };
  }
  if (line.startsWith("[meta] ")) {
    return { role: "system", text: line.slice(7), ts: Date.now() };
  }
  return null;
}

function normalizeStderr(text: string) {
  if (text.includes("detected dubious ownership") || text.includes("safe.directory")) {
    return "Git safe.directory: Codex работает в sandbox-пользователе. Dev Hub передаёт одноразовый safe.directory в окружение процесса; если это сообщение повторится, перезапусти сессию.";
  }
  return text;
}

function appendChatMessage(current: ChatMessage[], message: ChatMessage) {
  if (message.role !== "stderr") {
    return [...current, message];
  }
  const normalized = { ...message, text: normalizeStderr(message.text) };
  const duplicate = current
    .slice(-8)
    .some((item) => item.role === "stderr" && item.text === normalized.text);
  return duplicate ? current : [...current, normalized];
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
  const restoredReposRef = useRef<Set<string>>(new Set());

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

    async function attach() {
      unlistenOut = await listen<string>(`codex://${sessionId}/out`, (event) => {
        setMessages((current) => appendChatMessage(current, parseCodexLine(event.payload)));
      });
      unlistenErr = await listen<string>(`codex://${sessionId}/err`, (event) => {
        setMessages((current) =>
          appendChatMessage(current, { role: "stderr", text: event.payload, ts: Date.now() })
        );
      });
    }

    void attach().catch((error) => onNotice(String(error)));

    return () => {
      unlistenOut?.();
      unlistenErr?.();
    };
  }, [onNotice, sessionId]);

  useEffect(() => {
    if (!workspace || !canStart || sessionId || messages.length > 0) {
      return;
    }
    if (restoredReposRef.current.has(repoTarget)) {
      return;
    }
    restoredReposRef.current.add(repoTarget);

    void invoke<RestoredCodexSession | null>("codex_session_restore", { repo: repoTarget })
      .then((restored) => {
        if (!restored || sessionId) {
          return;
        }
        const restoredMessages = restored.log_tail
          .map(parseStoredLogLine)
          .filter((message): message is ChatMessage => Boolean(message));
        setSessionId(restored.session_id);
        setMessages(
          restoredMessages.length > 0
            ? restoredMessages
            : [
                {
                  role: "system",
                  text: `сессия ${restored.session_id} восстановлена для ${restored.repo}: ${restored.cwd}`,
                  ts: Date.now()
                }
              ]
        );
        onNotice(`Продолжена сессия Codex ${restored.session_id}.`);
      })
      .catch(() => undefined);
  }, [canStart, messages.length, onNotice, repoTarget, sessionId, workspace]);

  async function buildSystemPrompt() {
    let guideIntro = "";
    try {
      guideIntro = await invoke<string>("read_user_guide_intro");
    } catch {
      guideIntro = "Atlas Dev Hub — локальное приложение-оркестратор для разработки Atlas.";
    }

    return [
      "Ты Codex внутри интерактивного чата Atlas Dev Hub.",
      "Пользователь ждёт практической инженерной помощи и безопасной работы через ветки.",
      `Target repo: ${repoTarget}.`,
      repoTarget === "hub"
        ? "Ты в self-edit режиме для atlas-dev-hub. Работай только в созданном hub worktree."
        : "Ты в режиме Atlas. Используй репозиторий Atlas как рабочий root.",
      "",
      "Фрагмент инструкции Atlas Dev Hub:",
      clip(guideIntro, 1600),
      "",
      "Текущий снимок статуса агентов:",
      clip(statusSnapshot, 1200),
      "",
      "Текущий снимок событий:",
      clip(eventsSnapshot, 1200)
    ].join("\n");
  }

  async function startSession() {
    if (!canStart) {
      onNotice("JSON-поток Codex недоступен. Проверь настройку Codex CLI.");
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
          text: `сессия ${id} запущена для ${repoTarget}: ${targetPath}`,
          ts: Date.now()
        }
      ]);
      onNotice("Чат Codex запущен.");
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
        { role: "system", text: "сессия остановлена", ts: Date.now() }
      ]);
      setSessionId(null);
      onNotice("Чат Codex остановлен.");
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
      onNotice("Сообщение отправлено Codex.");
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
          <h2>Чат Codex</h2>
        </div>
        <div className="codex-chat-controls">
          <div className="segmented" aria-label="Целевой репозиторий">
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
              Стоп
            </button>
          ) : (
            <button className="primary-button" onClick={startSession} disabled={busy || !canStart}>
              <Play size={18} />
              Старт
            </button>
          )}
        </div>
      </div>

      {!workspace?.codex_stream_ok && (
        <div className="inline-warning">
          <ShieldAlert size={16} />
          Codex CLI не сообщает `codex exec --json`; интерактивный чат отключён.
        </div>
      )}

      <div className="codex-target">
        <GitBranch size={16} />
        <span>{sessionId ? `активная сессия ${sessionId}` : `цель: ${targetPath || "загрузка"}`}</span>
      </div>

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            Запусти сессию и отправь сообщение. Dev Hub будет показывать здесь JSONL-события Codex.
          </div>
        ) : (
          messages.map((message, index) => (
            <div className={`chat-message ${message.role}`} key={`${message.ts}-${index}`}>
              <div className="chat-meta">
                <span>{roleLabel(message.role)}</span>
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
          placeholder="Спроси Codex или напиши, что изменить в выбранном репозитории..."
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
          Отправить
        </button>
      </div>
    </section>
  );
}
