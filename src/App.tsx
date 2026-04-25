import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Brain,
  CheckCircle2,
  ExternalLink,
  FileText,
  Gauge,
  KeyRound,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Terminal,
  Wand2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import CodexChat, { type WorkspaceInfo } from "./CodexChat";

type ProviderStatus = {
  provider: string;
  configured: boolean;
  model: string;
  base_url: string;
  key_source: string;
};

type ProviderReply = {
  provider: string;
  model: string;
  content: string;
};

type AgentId = "codex" | "claude" | "kimi" | "perplexity";

const agentCopy: Record<
  AgentId,
  {
    title: string;
    role: string;
    tone: string;
    icon: typeof Bot;
  }
> = {
  codex: {
    title: "Codex",
    role: "Lead developer",
    tone: "Owns integration, branches, checks, final decisions.",
    icon: Brain
  },
  claude: {
    title: "Claude",
    role: "Reviewer and worker",
    tone: "Strong for UI review, safety notes, scoped branch work.",
    icon: Bot
  },
  kimi: {
    title: "Kimi",
    role: "Long-context assistant",
    tone: "Useful for broad code reading, long notes, alternatives.",
    icon: Sparkles
  },
  perplexity: {
    title: "Perplexity",
    role: "Research scout",
    tone: "Useful for current docs, web research, source-backed notes.",
    icon: Search
  }
};

function providerByName(statuses: ProviderStatus[], provider: string) {
  return statuses.find((item) => item.provider === provider);
}

function trimName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<Record<AgentId, boolean>>({
    codex: true,
    claude: false,
    kimi: false,
    perplexity: false
  });
  const [taskName, setTaskName] = useState("atlas-next-step");
  const [taskText, setTaskText] = useState(
    "Continue the Atlas restoration plan. Keep changes scoped, coordinate through the agent bus, and report risks before merging."
  );
  const [mode, setMode] = useState<"work" | "review" | "plan">("work");
  const [fullPcAccess, setFullPcAccess] = useState(false);
  const [sessionUsage, setSessionUsage] = useState(65);
  const [guardLevel, setGuardLevel] = useState(75);
  const [codexModel, setCodexModel] = useState("gpt-5.5");
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [claudeBudget, setClaudeBudget] = useState(5);
  const [statusOutput, setStatusOutput] = useState("");
  const [eventsOutput, setEventsOutput] = useState("");
  const [runId, setRunId] = useState("");
  const [runOutput, setRunOutput] = useState("");
  const [providerPrompt, setProviderPrompt] = useState(
    "Review the current Atlas Dev Hub plan. Point out risks and one concrete next step."
  );
  const [providerReplies, setProviderReplies] = useState<Record<string, string>>({});
  const [providerForms, setProviderForms] = useState({
    kimi: {
      apiKey: "",
      model: "kimi-k2.5",
      baseUrl: "https://api.moonshot.ai/v1"
    },
    perplexity: {
      apiKey: "",
      model: "sonar",
      baseUrl: "https://api.perplexity.ai"
    }
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready.");

  const selectedCount = useMemo(
    () => Object.values(selectedAgents).filter(Boolean).length,
    [selectedAgents]
  );

  async function refreshWorkspace() {
    const info = await invoke<WorkspaceInfo>("workspace_info");
    setWorkspace(info);
  }

  async function refreshProviders() {
    const statuses = await invoke<ProviderStatus[]>("provider_status");
    setProviderStatuses(statuses);
    setProviderForms((forms) => ({
      kimi: {
        ...forms.kimi,
        model: providerByName(statuses, "kimi")?.model ?? forms.kimi.model,
        baseUrl: providerByName(statuses, "kimi")?.base_url ?? forms.kimi.baseUrl
      },
      perplexity: {
        ...forms.perplexity,
        model: providerByName(statuses, "perplexity")?.model ?? forms.perplexity.model,
        baseUrl:
          providerByName(statuses, "perplexity")?.base_url ?? forms.perplexity.baseUrl
      }
    }));
  }

  async function refreshStatus() {
    const [status, events] = await Promise.all([
      invoke<string>("agent_status"),
      invoke<string>("read_agent_events")
    ]);
    setStatusOutput(status || "No status returned.");
    setEventsOutput(events || "No events yet.");
  }

  async function boot() {
    try {
      await Promise.all([refreshWorkspace(), refreshProviders(), refreshStatus()]);
      setNotice("Workspace connected.");
    } catch (error) {
      setNotice(String(error));
    }
  }

  useEffect(() => {
    void boot();
    const id = window.setInterval(() => {
      void refreshStatus().catch(() => undefined);
    }, 12000);
    return () => window.clearInterval(id);
  }, []);

  function toggleAgent(agent: AgentId) {
    setSelectedAgents((current) => ({ ...current, [agent]: !current[agent] }));
  }

  function guardedHeavyWork() {
    return mode === "work" && sessionUsage >= guardLevel;
  }

  async function startClaude() {
    const output = await invoke<string>("start_claude_task", {
      name: trimName(taskName) || "claude-task",
      task: taskText,
      mode,
      fullPcAccess,
      model: claudeModel,
      maxBudgetUsd: claudeBudget
    });
    setRunOutput(output);
    setNotice("Claude task started.");
    await refreshStatus();
  }

  async function startCodex() {
    const output = await invoke<string>("start_codex_task", {
      name: trimName(taskName) || "codex-task",
      task: taskText,
      mode,
      fullPcAccess,
      model: codexModel
    });
    setRunOutput(output);
    setNotice("Codex task started.");
    await refreshStatus();
  }

  async function ask(provider: "kimi" | "perplexity") {
    const reply = await invoke<ProviderReply>("ask_provider", {
      provider,
      prompt: providerPrompt
    });
    setProviderReplies((current) => ({
      ...current,
      [provider]: `[${reply.provider} / ${reply.model}]\n${reply.content}`
    }));
    setNotice(`${provider} answered.`);
  }

  async function startSelected() {
    if (!taskText.trim()) {
      setNotice("Write a task first.");
      return;
    }
    if (selectedCount === 0) {
      setNotice("Select at least one agent.");
      return;
    }
    if (guardedHeavyWork()) {
      setNotice(
        `Usage guard active at ${sessionUsage}%. Switch to plan/review or lower current usage after saving context.`
      );
      return;
    }

    setBusy(true);
    try {
      if (selectedAgents.codex) {
        await startCodex();
      }
      if (selectedAgents.claude) {
        await startClaude();
      }
      if (selectedAgents.kimi) {
        await ask("kimi");
      }
      if (selectedAgents.perplexity) {
        await ask("perplexity");
      }
      setNotice("Selected agents completed launch cycle.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveProvider(provider: "kimi" | "perplexity") {
    setBusy(true);
    try {
      const form = providerForms[provider];
      const statuses = await invoke<ProviderStatus[]>("save_provider_config", {
        provider,
        apiKey: form.apiKey,
        model: form.model,
        baseUrl: form.baseUrl
      });
      setProviderStatuses(statuses);
      setProviderForms((current) => ({
        ...current,
        [provider]: { ...current[provider], apiKey: "" }
      }));
      setNotice(`${provider} connection saved locally.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadRunLog() {
    if (!runId.trim()) {
      setNotice("Paste a run id first.");
      return;
    }
    setBusy(true);
    try {
      const output = await invoke<string>("watch_agent_run", {
        runId: runId.trim(),
        tail: 160
      });
      setRunOutput(output);
      setNotice("Run log loaded.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openWorkspacePath(path?: string) {
    if (!path) {
      return;
    }
    await invoke("open_path", { path });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local orchestration app</p>
          <h1>Atlas Dev Hub</h1>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" onClick={boot} disabled={busy}>
            <RefreshCw size={18} />
            Refresh
          </button>
          <button
            className="ghost-button"
            onClick={() => openWorkspacePath(workspace?.atlas_root)}
            disabled={!workspace}
          >
            <ExternalLink size={18} />
            Atlas
          </button>
          <button
            className="primary-button"
            onClick={startSelected}
            disabled={busy || guardedHeavyWork()}
          >
            <Play size={18} />
            Start Selected
          </button>
        </div>
      </header>

      <section className="status-strip">
        <div>
          <span>Codex CLI</span>
          <strong>{workspace?.codex_cli ? "ready" : "missing"}</strong>
        </div>
        <div>
          <span>Codex stream</span>
          <strong>{workspace?.codex_stream_ok ? "jsonl" : "missing"}</strong>
        </div>
        <div>
          <span>Claude CLI</span>
          <strong>{workspace?.claude_cli ? "ready" : "missing"}</strong>
        </div>
        <div>
          <span>Kimi</span>
          <strong>{providerByName(providerStatuses, "kimi")?.key_source ?? "checking"}</strong>
        </div>
        <div>
          <span>Perplexity</span>
          <strong>
            {providerByName(providerStatuses, "perplexity")?.key_source ?? "checking"}
          </strong>
        </div>
        <div className={guardedHeavyWork() ? "guard is-hot" : "guard"}>
          <Gauge size={18} />
          <strong>{sessionUsage}%</strong>
          <span>guard {guardLevel}%</span>
        </div>
      </section>

      <section className="agent-grid" aria-label="Agent lanes">
        {(Object.keys(agentCopy) as AgentId[]).map((agent) => {
          const Icon = agentCopy[agent].icon;
          const provider =
            agent === "kimi" || agent === "perplexity"
              ? providerByName(providerStatuses, agent)
              : null;
          const ready =
            agent === "codex"
              ? Boolean(workspace?.codex_cli)
              : agent === "claude"
                ? Boolean(workspace?.claude_cli)
                : Boolean(provider?.configured);
          return (
            <article className={`agent-card ${selectedAgents[agent] ? "selected" : ""}`} key={agent}>
              <div className="agent-card-head">
                <div className="agent-icon">
                  <Icon size={20} />
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={selectedAgents[agent]}
                    onChange={() => toggleAgent(agent)}
                  />
                  <span />
                </label>
              </div>
              <h2>{agentCopy[agent].title}</h2>
              <p className="agent-role">{agentCopy[agent].role}</p>
              <p>{agentCopy[agent].tone}</p>
              <div className={ready ? "pill ok" : "pill warn"}>
                {ready ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
                {ready ? "connected" : "needs setup"}
              </div>
            </article>
          );
        })}
      </section>

      <section className="workbench">
        <div className="task-pane">
          <div className="section-title">
            <Wand2 size={19} />
            <h2>Task Inbox</h2>
          </div>
          <div className="field-row">
            <label>
              Task name
              <input value={taskName} onChange={(event) => setTaskName(event.target.value)} />
            </label>
            <label>
              Mode
              <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                <option value="work">work</option>
                <option value="review">review</option>
                <option value="plan">plan</option>
              </select>
            </label>
          </div>
          <label>
            Task
            <textarea
              value={taskText}
              onChange={(event) => setTaskText(event.target.value)}
              rows={8}
            />
          </label>
          <div className="control-grid">
            <label>
              Codex model
              <input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} />
            </label>
            <label>
              Claude model
              <input
                value={claudeModel}
                onChange={(event) => setClaudeModel(event.target.value)}
              />
            </label>
            <label>
              Claude budget
              <input
                type="number"
                min="1"
                step="1"
                value={claudeBudget}
                onChange={(event) => setClaudeBudget(Number(event.target.value))}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={fullPcAccess}
                onChange={(event) => setFullPcAccess(event.target.checked)}
              />
              Full PC access for worker
            </label>
          </div>
          <div className="usage-panel">
            <div className="section-title compact">
              <Gauge size={18} />
              <h3>Usage Guard</h3>
            </div>
            <label>
              Current session estimate: {sessionUsage}%
              <input
                type="range"
                min="0"
                max="100"
                value={sessionUsage}
                onChange={(event) => setSessionUsage(Number(event.target.value))}
              />
            </label>
            <label>
              Stop heavy work at: {guardLevel}%
              <input
                type="range"
                min="70"
                max="80"
                value={guardLevel}
                onChange={(event) => setGuardLevel(Number(event.target.value))}
              />
            </label>
            <p className={guardedHeavyWork() ? "warning-text" : "muted"}>
              {guardedHeavyWork()
                ? "Heavy work is paused. Use plan/review or save context before continuing."
                : "Heavy work may start. The guard is local and conservative for now."}
            </p>
          </div>
        </div>

        <div className="side-pane">
          <div className="section-title">
            <KeyRound size={19} />
            <h2>Connections</h2>
          </div>
          {(["kimi", "perplexity"] as const).map((provider) => {
            const status = providerByName(providerStatuses, provider);
            return (
              <div className="provider-row" key={provider}>
                <div className="provider-head">
                  <strong>{provider}</strong>
                  <span className={status?.configured ? "pill ok" : "pill warn"}>
                    {status?.key_source ?? "missing"}
                  </span>
                </div>
                <input
                  type="password"
                  placeholder="API key"
                  value={providerForms[provider].apiKey}
                  onChange={(event) =>
                    setProviderForms((current) => ({
                      ...current,
                      [provider]: { ...current[provider], apiKey: event.target.value }
                    }))
                  }
                />
                <div className="field-row">
                  <input
                    value={providerForms[provider].model}
                    onChange={(event) =>
                      setProviderForms((current) => ({
                        ...current,
                        [provider]: { ...current[provider], model: event.target.value }
                      }))
                    }
                  />
                  <button className="ghost-button" onClick={() => saveProvider(provider)} disabled={busy}>
                    Save
                  </button>
                </div>
                <input
                  value={providerForms[provider].baseUrl}
                  onChange={(event) =>
                    setProviderForms((current) => ({
                      ...current,
                      [provider]: { ...current[provider], baseUrl: event.target.value }
                    }))
                  }
                />
              </div>
            );
          })}
          <p className="small-note">
            Keys are stored outside the repo in local app data. This v0 does not encrypt them yet.
          </p>

          <div className="section-title">
            <FileText size={19} />
            <h2>Research Prompt</h2>
          </div>
          <textarea
            value={providerPrompt}
            onChange={(event) => setProviderPrompt(event.target.value)}
            rows={5}
          />
          <div className="button-row">
            <button className="ghost-button" onClick={() => ask("kimi")} disabled={busy}>
              Ask Kimi
            </button>
            <button className="ghost-button" onClick={() => ask("perplexity")} disabled={busy}>
              Ask Perplexity
            </button>
          </div>
        </div>
      </section>

      <CodexChat
        workspace={workspace}
        statusSnapshot={statusOutput}
        eventsSnapshot={eventsOutput}
        onNotice={setNotice}
      />

      <section className="console-grid">
        <article>
          <div className="section-title">
            <Terminal size={19} />
            <h2>Agent Status</h2>
          </div>
          <pre>{statusOutput || "Loading..."}</pre>
        </article>
        <article>
          <div className="section-title">
            <FileText size={19} />
            <h2>Events</h2>
          </div>
          <pre>{eventsOutput || "Loading..."}</pre>
        </article>
      </section>

      <section className="console-grid">
        <article>
          <div className="section-title">
            <Terminal size={19} />
            <h2>Run Log</h2>
          </div>
          <div className="field-row">
            <input
              placeholder="RUN_ID from launch output"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            />
            <button className="ghost-button" onClick={loadRunLog} disabled={busy}>
              Load
            </button>
          </div>
          <pre>{runOutput || "Launch output and run logs will appear here."}</pre>
        </article>
        <article>
          <div className="section-title">
            <Search size={19} />
            <h2>Provider Notes</h2>
          </div>
          <pre>
            {providerReplies.kimi || providerReplies.perplexity
              ? [providerReplies.kimi, providerReplies.perplexity].filter(Boolean).join("\n\n")
              : "Kimi and Perplexity notes will appear here after you connect API keys."}
          </pre>
        </article>
      </section>

      <footer>
        <span>{notice}</span>
        <button
          className="link-button"
          onClick={() => openWorkspacePath(workspace?.user_guide_path)}
          disabled={!workspace}
        >
          guide
        </button>
        <button
          className="link-button"
          onClick={() => openWorkspacePath(workspace?.provider_config_path)}
          disabled={!workspace}
        >
          provider config
        </button>
        <button className="link-button" onClick={() => openWorkspacePath(workspace?.bus_root)} disabled={!workspace}>
          agent bus
        </button>
      </footer>
    </main>
  );
}
