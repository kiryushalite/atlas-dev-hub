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
  route: string;
  fallback_used: boolean;
  content: string;
};

type OrchestrationContext = {
  summary: string;
  sources: string[];
};

type AgentId = "codex" | "claude" | "kimi" | "perplexity";
type AgentRunStatus = "queued" | "running" | "success" | "error" | "skipped";

type AgentRun = {
  agent: AgentId;
  status: AgentRunStatus;
  provider: string;
  model: string;
  route: string;
  profile: string;
  fallbackUsed: boolean;
  contextLabel: string;
  contextWarning: string;
  result: string;
  error: string;
  updatedAt: number;
};

type AgentMeta = Omit<
  AgentRun,
  "agent" | "status" | "result" | "error" | "updatedAt" | "contextLabel" | "contextWarning"
>;

const agentOrder: AgentId[] = ["codex", "claude", "kimi", "perplexity"];

const defaultSelectedAgents: Record<AgentId, boolean> = {
  codex: false,
  claude: false,
  kimi: false,
  perplexity: false
};

const agentModelDefaults: Record<
  AgentId,
  {
    provider: string;
    current: string;
    target: string;
    fallback: string;
    route: string;
    profile: string;
  }
> = {
  codex: {
    provider: "OpenAI Codex CLI",
    current: "gpt-5.5",
    target: "gpt-5.5",
    fallback: "gpt-5.4",
    route: "background worktree",
    profile: "work / review / plan"
  },
  claude: {
    provider: "Claude Code CLI",
    current: "sonnet",
    target: "Sonnet 4.6 Adaptive: id не подтверждён CLI",
    fallback: "Haiku 4.5 или текущий alias",
    route: "background worktree",
    profile: "permission mode by task mode"
  },
  kimi: {
    provider: "OpenRouter + Moonshot",
    current: "moonshotai/kimi-k2.6",
    target: "moonshotai/kimi-k2.6",
    fallback: "moonshotai/kimi-k2.5",
    route: "OpenRouter fallback",
    profile: "research / summary"
  },
  perplexity: {
    provider: "OpenRouter + Perplexity",
    current: "perplexity/sonar",
    target: "perplexity/sonar",
    fallback: "perplexity/sonar-pro-search",
    route: "OpenRouter fallback",
    profile: "web research"
  }
};

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
    role: "Ведущий разработчик",
    tone: "Ведёт интеграцию, ветки, проверки и финальные решения.",
    icon: Brain
  },
  claude: {
    title: "Claude",
    role: "Ревьюер и исполнитель",
    tone: "Хорош для UI-ревью, замечаний по безопасности и узких веток.",
    icon: Bot
  },
  kimi: {
    title: "Kimi",
    role: "Помощник для длинного контекста",
    tone: "Полезен для больших разборов кода, длинных заметок и альтернатив.",
    icon: Sparkles
  },
  perplexity: {
    title: "Perplexity",
    role: "Исследователь",
    tone: "Полезен для свежей документации, web research и заметок с источниками.",
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

function statusLabel(value?: string) {
  switch (value) {
    case "local-config":
      return "локально";
    case "environment":
      return "env";
    case "missing":
      return "нет";
    case "checking":
      return "проверка";
    default:
      return value ?? "проверка";
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function storedSelectedAgents() {
  if (typeof window === "undefined") {
    return defaultSelectedAgents;
  }
  try {
    const raw = window.localStorage.getItem("adg.selectedAgents");
    if (!raw) {
      return defaultSelectedAgents;
    }
    const parsed = JSON.parse(raw) as Partial<Record<AgentId, boolean>>;
    return {
      codex: Boolean(parsed.codex),
      claude: Boolean(parsed.claude),
      kimi: Boolean(parsed.kimi),
      perplexity: Boolean(parsed.perplexity)
    };
  } catch {
    return defaultSelectedAgents;
  }
}

function storedText(key: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }
  return window.localStorage.getItem(key) || fallback;
}

function initialAgentRuns(): Record<AgentId, AgentRun> {
  return Object.fromEntries(
    agentOrder.map((agent) => [
      agent,
      {
        agent,
        status: "skipped",
        provider: agentModelDefaults[agent].provider,
        model: agentModelDefaults[agent].current,
        route: agentModelDefaults[agent].route,
        profile: agentModelDefaults[agent].profile,
        fallbackUsed: false,
        contextLabel: "no local context",
        contextWarning: "Результат ещё не запускался.",
        result: "Не выбран.",
        error: "",
        updatedAt: Date.now()
      }
    ])
  ) as Record<AgentId, AgentRun>;
}

function runStatusLabel(status: AgentRunStatus) {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "success":
      return "success";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
  }
}

function recommendationForTask(task: string) {
  const text = task.toLowerCase();
  const recommendations: AgentId[] = [];
  const hasAny = (words: string[]) => words.some((word) => text.includes(word));
  if (
    hasAny([
      "сейчас",
      "актуально",
      "сегодня",
      "новости",
      "цена",
      "курс",
      "последняя версия",
      "документация",
      "найди в интернете"
    ])
  ) {
    recommendations.push("perplexity");
  }
  if (hasAny(["объясни", "инструкция", "суммар", "документ", "структур", "переведи"])) {
    recommendations.push("kimi");
  }
  if (hasAny(["код", "сборк", "ошибк", "diff", "тест", "build", "fix"])) {
    recommendations.push("codex");
  }
  if (hasAny(["архитект", "ревью", "trade-off", "tradeoff", "риски", "подход"])) {
    recommendations.push("claude");
  }
  const unique = Array.from(new Set(recommendations));
  if (unique.length === 0) {
    return "Маршрут: выбери агентов вручную по роли задачи.";
  }
  return `Рекомендация: ${unique.map((agent) => agentCopy[agent].title).join(" + ")}.`;
}

function trimForPrompt(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `...[tail]\n${value.slice(Math.max(0, value.length - limit))}`;
}

function safeTail(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `...[tail]\n${value.slice(Math.max(0, value.length - limit))}`;
}

function contextLabel(sources: string[]) {
  if (sources.length === 0) {
    return "task only";
  }
  const hasNotes = sources.some((source) => source.includes("/notes/"));
  const hasEvents = sources.some((source) => source.includes("events.log"));
  if (hasNotes && hasEvents) {
    return "task + notes/events";
  }
  if (sources.length > 0) {
    return "task + local summary";
  }
  return "task only";
}

function contextWarning(sources: string[]) {
  if (sources.length === 0) {
    return "Ответ может быть неполным: агент не получил локальный план/документы проекта.";
  }
  return "";
}

function selectedAgentNames(selection: Record<AgentId, boolean>) {
  return agentOrder
    .filter((agent) => selection[agent])
    .map((agent) => agentCopy[agent].title)
    .join(", ");
}

function sameSelection(a: Record<AgentId, boolean> | null, b: Record<AgentId, boolean>) {
  return Boolean(a && agentOrder.every((agent) => a[agent] === b[agent]));
}

function buildContextEnvelope(
  provider: "kimi" | "perplexity",
  task: string,
  selection: Record<AgentId, boolean>,
  localContext: OrchestrationContext,
  statusOutput: string,
  eventsOutput: string
) {
  const sources = localContext.sources.length > 0 ? localContext.sources : ["status/events snapshot"];
  const localSummary =
    localContext.summary.trim() ||
    [
      "## agent_status snapshot",
      safeTail(statusOutput || "No status snapshot.", 2500),
      "## events snapshot",
      safeTail(eventsOutput || "No events snapshot.", 2500)
    ].join("\n");
  const groundingRules =
    provider === "kimi"
      ? [
          "Ты Kimi в Atlas Dev Hub. Работай как summarization/planning agent только на переданном контексте.",
          "Используй только предоставленный контекст. Если данных недостаточно, скажи, какой файл/план/лог нужен.",
          "Не выдумывай issue numbers, PR numbers, agent names, roadmap items, merge numbers или внешние факты."
        ]
      : [
          "Ты Perplexity/OpenRouter в Atlas Dev Hub. ADG / Atlas Dev Hub здесь — локальный пользовательский проект, не публичный термин.",
          "Если вопрос про внутренний план ADG, используй только локальный контекст ниже и скажи, если его недостаточно.",
          "Для внешнего web research ищи только конкретные технологии/документацию, а не случайные публичные проекты с названием Atlas."
        ];

  return {
    label: contextLabel(localContext.sources),
    warning: contextWarning(localContext.sources),
    sources,
    prompt: [
      "# Context Envelope",
      "Project: Atlas Dev Hub / ADG.",
      `User task: ${task}`,
      `Selected agents: ${selectedAgentNames(selection) || "none"}`,
      "",
      "## Current known status",
      "- P0 закрыт.",
      "- Provider-block P1 закрыт: Kimi и Perplexity работают через OpenRouter fallback.",
      "- Kimi route: moonshotai/kimi-k2.6 / OpenRouter fallback.",
      "- Perplexity route: perplexity/sonar / OpenRouter fallback.",
      "- Текущая цель: ADG как orchestration cockpit.",
      "",
      "## Grounding rules",
      ...groundingRules.map((rule) => `- ${rule}`),
      "",
      "## Local context sources",
      ...sources.map((source) => `- ${source}`),
      "",
      "## Recent local context",
      trimForPrompt(localSummary, 9000),
      "",
      "## Required answer",
      "Ответь по-русски. Отдели факты из контекста от предположений. Если контекста мало, начни с того, чего не хватает."
    ].join("\n")
  };
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<Record<AgentId, boolean>>(
    storedSelectedAgents
  );
  const [taskName, setTaskName] = useState("atlas-next-step");
  const [taskText, setTaskText] = useState(
    "Продолжи план разработки Atlas. Держи изменения узкими, координируйся через agent bus и докладывай риски перед merge."
  );
  const [mode, setMode] = useState<"work" | "review" | "plan">("work");
  const [fullPcAccess, setFullPcAccess] = useState(false);
  const [sessionUsage, setSessionUsage] = useState(65);
  const [guardLevel, setGuardLevel] = useState(75);
  const [codexModel, setCodexModel] = useState(() =>
    storedText("adg.codexModel", agentModelDefaults.codex.current)
  );
  const [claudeModel, setClaudeModel] = useState(() =>
    storedText("adg.claudeModel", agentModelDefaults.claude.current)
  );
  const [claudeBudget, setClaudeBudget] = useState(5);
  const [statusOutput, setStatusOutput] = useState("");
  const [eventsOutput, setEventsOutput] = useState("");
  const [runId, setRunId] = useState("");
  const [runOutput, setRunOutput] = useState("");
  const [agentRuns, setAgentRuns] = useState<Record<AgentId, AgentRun>>(initialAgentRuns);
  const [lastRunStartedAt, setLastRunStartedAt] = useState("");
  const [lastRunSelection, setLastRunSelection] = useState<Record<AgentId, boolean> | null>(null);
  const [lastRunContextSources, setLastRunContextSources] = useState<string[]>([]);
  const [providerPrompt, setProviderPrompt] = useState(
    "Проверь текущий план Atlas Dev Hub. Назови риски и один конкретный следующий шаг."
  );
  const [providerReplies, setProviderReplies] = useState<Record<string, string>>({});
  const [providerBusy, setProviderBusy] = useState<Record<"kimi" | "perplexity", boolean>>({
    kimi: false,
    perplexity: false
  });
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
  const [notice, setNotice] = useState("Готово.");

  const selectedCount = useMemo(
    () => Object.values(selectedAgents).filter(Boolean).length,
    [selectedAgents]
  );
  const routeRecommendation = useMemo(() => recommendationForTask(taskText), [taskText]);
  const selectionChangedSinceLastRun = useMemo(
    () => Boolean(lastRunStartedAt && !sameSelection(lastRunSelection, selectedAgents)),
    [lastRunSelection, lastRunStartedAt, selectedAgents]
  );

  useEffect(() => {
    window.localStorage.setItem("adg.selectedAgents", JSON.stringify(selectedAgents));
  }, [selectedAgents]);

  useEffect(() => {
    window.localStorage.setItem("adg.codexModel", codexModel);
  }, [codexModel]);

  useEffect(() => {
    window.localStorage.setItem("adg.claudeModel", claudeModel);
  }, [claudeModel]);

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
    setStatusOutput(status || "Статус не вернулся.");
    setEventsOutput(events || "Событий пока нет.");
  }

  async function boot(markManualRefresh = false) {
    try {
      await Promise.all([refreshWorkspace(), refreshProviders(), refreshStatus()]);
      setNotice(
        markManualRefresh && lastRunStartedAt
          ? "Обновлено. Карточки ниже относятся к последнему запуску, не к текущему выбору."
          : "Рабочая среда подключена."
      );
    } catch (error) {
      setNotice(errorText(error));
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

  function agentMeta(agent: AgentId): AgentMeta {
    const kimiStatus = providerByName(providerStatuses, "kimi");
    const perplexityStatus = providerByName(providerStatuses, "perplexity");
    if (agent === "codex") {
      return {
        provider: agentModelDefaults.codex.provider,
        model: codexModel || agentModelDefaults.codex.current,
        route: agentModelDefaults.codex.route,
        profile: mode,
        fallbackUsed: false
      };
    }
    if (agent === "claude") {
      return {
        provider: agentModelDefaults.claude.provider,
        model: claudeModel || agentModelDefaults.claude.current,
        route: agentModelDefaults.claude.route,
        profile: `${mode}, budget $${claudeBudget}`,
        fallbackUsed: false
      };
    }
    if (agent === "kimi") {
      return {
        provider: agentModelDefaults.kimi.provider,
        model: kimiStatus?.model || agentModelDefaults.kimi.current,
        route: "Moonshot direct -> OpenRouter fallback",
        profile: agentModelDefaults.kimi.profile,
        fallbackUsed: true
      };
    }
    return {
      provider: agentModelDefaults.perplexity.provider,
      model: perplexityStatus?.model || agentModelDefaults.perplexity.current,
      route: "Perplexity direct -> OpenRouter fallback",
      profile: agentModelDefaults.perplexity.profile,
      fallbackUsed: true
    };
  }

  function makeRun(agent: AgentId, status: AgentRunStatus, message: string): AgentRun {
    return {
      agent,
      status,
      ...agentMeta(agent),
      contextLabel: "no local context",
      contextWarning: "",
      result: status === "error" ? "" : message,
      error: status === "error" ? message : "",
      updatedAt: Date.now()
    };
  }

  function updateAgentRun(agent: AgentId, patch: Partial<AgentRun>) {
    setAgentRuns((current) => ({
      ...current,
      [agent]: {
        ...(current[agent] ?? makeRun(agent, "skipped", "Не выбран.")),
        ...patch,
        updatedAt: Date.now()
      }
    }));
  }

  function runIdFromOutput(output: string) {
    return output.match(/RUN_ID=([^\s]+)/)?.[1] ?? "";
  }

  async function loadOrchestrationContext(): Promise<OrchestrationContext> {
    try {
      return await invoke<OrchestrationContext>("orchestration_context");
    } catch {
      return { summary: "", sources: [] };
    }
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
    await refreshStatus();
    return output;
  }

  async function startCodex() {
    const output = await invoke<string>("start_codex_task", {
      name: trimName(taskName) || "codex-task",
      task: taskText,
      mode,
      fullPcAccess,
      model: codexModel
    });
    await refreshStatus();
    return output;
  }

  async function ask(provider: "kimi" | "perplexity", prompt = providerPrompt) {
    setProviderBusy((current) => ({ ...current, [provider]: true }));
    setProviderReplies((current) => ({
      ...current,
      [provider]: `[${provider}]\nЗапрос отправлен...`
    }));
    try {
      const reply = await invoke<ProviderReply>("ask_provider", {
        provider,
        prompt
      });
      setProviderReplies((current) => ({
        ...current,
        [provider]: `[${reply.provider} / ${reply.model} / ${reply.route} / fallback: ${
          reply.fallback_used ? "yes" : "no"
        }]\n${reply.content}`
      }));
      setNotice(`${provider} ответил.`);
      return reply;
    } catch (error) {
      const message = errorText(error);
      setProviderReplies((current) => ({
        ...current,
        [provider]: `[${provider}]\nОшибка: ${message}`
      }));
      setNotice(`${provider}: ${message}`);
      throw error;
    } finally {
      setProviderBusy((current) => ({ ...current, [provider]: false }));
    }
  }

  async function startSelected() {
    if (!taskText.trim()) {
      setNotice("Сначала напиши задачу.");
      return;
    }
    if (selectedCount === 0) {
      setNotice("Выбери хотя бы одного агента.");
      setAgentRuns(initialAgentRuns());
      return;
    }
    if (guardedHeavyWork()) {
      setNotice(
        `Ограничитель сработал на ${sessionUsage}%. Перейди в plan/review или снизь оценку usage после сохранения контекста.`
      );
      return;
    }

    setBusy(true);
    const selected = agentOrder.filter((agent) => selectedAgents[agent]);
    const startedAt = new Date().toLocaleString("ru-RU");
    setLastRunStartedAt(startedAt);
    setLastRunSelection({ ...selectedAgents });
    const localContext = await loadOrchestrationContext();
    setLastRunContextSources(localContext.sources);
    const cycleRuns: Record<AgentId, AgentRun> = Object.fromEntries(
      agentOrder.map((agent) => [
        agent,
        selectedAgents[agent]
          ? makeRun(agent, "queued", "Ожидает запуска.")
          : makeRun(agent, "skipped", "Не выбран.")
      ])
    ) as Record<AgentId, AgentRun>;
    setAgentRuns(cycleRuns);
    const results: AgentRun[] = [];
    try {
      for (const agent of selected) {
        updateAgentRun(agent, {
          status: "running",
          result: "В работе...",
          error: "",
          ...agentMeta(agent)
        });
        try {
          if (agent === "codex") {
            const output = await startCodex();
            const runId = runIdFromOutput(output);
            const successRun: AgentRun = {
              ...makeRun(agent, "success", runId ? `Фоновая задача запущена: ${runId}` : output),
              route: "Codex background worktree",
              model: codexModel || agentModelDefaults.codex.current
            };
            results.push(successRun);
            updateAgentRun(agent, successRun);
            continue;
          }
          if (agent === "claude") {
            const output = await startClaude();
            const runId = runIdFromOutput(output);
            const successRun: AgentRun = {
              ...makeRun(agent, "success", runId ? `Фоновая задача запущена: ${runId}` : output),
              route: "Claude Code background worktree",
              model: claudeModel || agentModelDefaults.claude.current
            };
            results.push(successRun);
            updateAgentRun(agent, successRun);
            continue;
          }
          if (agent === "kimi" || agent === "perplexity") {
            const envelope = buildContextEnvelope(
              agent,
              taskText,
              selectedAgents,
              localContext,
              statusOutput,
              eventsOutput
            );
            updateAgentRun(agent, {
              contextLabel: envelope.label,
              contextWarning: envelope.warning
            });
            const reply = await ask(agent, envelope.prompt);
            const successRun: AgentRun = {
              ...makeRun(agent, "success", reply.content),
              provider: reply.provider,
              model: reply.model,
              route: reply.route,
              fallbackUsed: reply.fallback_used,
              contextLabel: envelope.label,
              contextWarning: envelope.warning
            };
            results.push(successRun);
            updateAgentRun(agent, successRun);
          }
        } catch (error) {
          const failedRun = makeRun(agent, "error", errorText(error));
          results.push(failedRun);
          updateAgentRun(agent, failedRun);
        }
      }
      const failed = results.filter((item) => item.status === "error");
      const succeeded = results.filter((item) => item.status === "success");
      const skipped = agentOrder.filter((agent) => !selectedAgents[agent]);
      setRunOutput((current) =>
        [
          `Цикл выбранных агентов (${startedAt}):
success: ${succeeded.map((item) => agentCopy[item.agent].title).join(", ") || "нет"}
error: ${failed.map((item) => agentCopy[item.agent].title).join(", ") || "нет"}
skipped: ${skipped.map((agent) => agentCopy[agent].title).join(", ") || "нет"}
context: ${localContext.sources.join(", ") || "status/events snapshot only"}
Дальше: смотри отдельные карточки результатов и route/model по каждому агенту.`,
          current
        ]
          .filter(Boolean)
          .join("\n\n")
      );
      setNotice(
        failed.length > 0
          ? `Цикл завершён с частичными ошибками: ${failed.length}.`
          : "Выбранные агенты прошли цикл запуска."
      );
    } catch (error) {
      setNotice(errorText(error));
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
      setNotice(`Подключение ${provider} сохранено локально.`);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadRunLog() {
    if (!runId.trim()) {
      setNotice("Сначала вставь RUN_ID.");
      return;
    }
    setBusy(true);
    try {
      const output = await invoke<string>("watch_agent_run", {
        runId: runId.trim(),
        tail: 160
      });
      setRunOutput(output);
      setNotice("Лог запуска загружен.");
    } catch (error) {
      setNotice(errorText(error));
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
          <p className="eyebrow">Локальный центр разработки</p>
          <h1>Atlas Dev Hub</h1>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" onClick={() => void boot(true)} disabled={busy}>
            <RefreshCw size={18} />
            Обновить
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
            Запустить выбранных
          </button>
        </div>
      </header>

      <section className="status-strip">
        <div>
          <span>Codex CLI</span>
          <strong>{workspace?.codex_cli ? "готов" : "нет"}</strong>
        </div>
        <div>
          <span>Поток Codex</span>
          <strong>{workspace?.codex_stream_ok ? "jsonl" : "нет"}</strong>
        </div>
        <div>
          <span>Claude CLI</span>
          <strong>{workspace?.claude_cli ? "готов" : "нет"}</strong>
        </div>
        <div>
          <span>Kimi</span>
          <strong>{statusLabel(providerByName(providerStatuses, "kimi")?.key_source)}</strong>
        </div>
        <div>
          <span>Perplexity</span>
          <strong>
            {statusLabel(providerByName(providerStatuses, "perplexity")?.key_source)}
          </strong>
        </div>
        <div className={guardedHeavyWork() ? "guard is-hot" : "guard"}>
          <Gauge size={18} />
          <strong>{sessionUsage}%</strong>
          <span>порог {guardLevel}%</span>
        </div>
      </section>

      <section className="agent-grid" aria-label="Панели агентов">
        {agentOrder.map((agent) => {
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
              <div className="agent-model">
                <span>{agent === "codex" ? codexModel : agent === "claude" ? claudeModel : agentModelDefaults[agent].current}</span>
                <small>{agentModelDefaults[agent].route}</small>
                <small>fallback: {agentModelDefaults[agent].fallback}</small>
              </div>
              <div className={ready ? "pill ok" : "pill warn"}>
                {ready ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
                {ready ? "подключён" : "нужна настройка"}
              </div>
            </article>
          );
        })}
      </section>

      <section className="workbench">
        <div className="task-pane">
          <div className="section-title">
            <Wand2 size={19} />
            <h2>Очередь задач</h2>
          </div>
          <div className="field-row">
            <label>
              Имя задачи
              <input value={taskName} onChange={(event) => setTaskName(event.target.value)} />
            </label>
            <label>
              Режим
              <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                <option value="work">работа</option>
                <option value="review">ревью</option>
                <option value="plan">план</option>
              </select>
            </label>
          </div>
          <label>
            Задача
            <textarea
              value={taskText}
              onChange={(event) => setTaskText(event.target.value)}
              rows={8}
            />
          </label>
          <p className="route-hint">{routeRecommendation}</p>
          <div className="control-grid">
            <label>
              Модель Codex
              <input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} />
            </label>
            <label>
              Модель Claude
              <input
                value={claudeModel}
                onChange={(event) => setClaudeModel(event.target.value)}
              />
            </label>
            <label>
              Бюджет Claude
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
              Полный доступ к ПК для воркера
            </label>
          </div>
          <div className="usage-panel">
            <div className="section-title compact">
              <Gauge size={18} />
              <h3>Ограничитель usage</h3>
            </div>
            <label>
              Текущая оценка сессии: {sessionUsage}%
              <input
                type="range"
                min="0"
                max="100"
                value={sessionUsage}
                onChange={(event) => setSessionUsage(Number(event.target.value))}
              />
            </label>
            <label>
              Останавливать тяжёлую работу при: {guardLevel}%
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
                ? "Тяжёлая работа остановлена. Используй план/ревью или сохрани контекст перед продолжением."
                : "Тяжёлую работу можно запускать. Ограничитель пока локальный и осторожный."}
            </p>
          </div>
          <div className="orchestration-panel">
            <div className="section-title compact">
              <Terminal size={18} />
              <h3>Запуск выбранных</h3>
            </div>
            <p className="run-note">
              {lastRunStartedAt
                ? `Результаты последнего запуска: ${lastRunStartedAt}.`
                : "Результатов запуска пока нет."}
              {selectionChangedSinceLastRun ? " Текущий выбор агентов изменён после запуска." : ""}
            </p>
            <p className="context-note">
              Контекст: {lastRunContextSources.join(", ") || "пока не передавался"}.
            </p>
            <div className="run-grid">
              {agentOrder.map((agent) => {
                const run = agentRuns[agent] ?? makeRun(agent, "skipped", "Не выбран.");
                const isCurrentlyOff = !selectedAgents[agent] && run.status !== "skipped";
                return (
                  <article className={`run-card ${run.status}`} key={agent}>
                    <div className="run-card-head">
                      <strong>{agentCopy[agent].title}</strong>
                      <span className={`run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
                    </div>
                    <div className="run-meta">
                      <span>{run.provider}</span>
                      <span>{run.model}</span>
                      <span>{run.route}</span>
                      <span>fallback: {run.fallbackUsed ? "yes" : "no"}</span>
                    </div>
                    <div className="context-chip">
                      {run.contextLabel}
                      {isCurrentlyOff ? " / сейчас выключен" : ""}
                    </div>
                    {run.contextWarning && <div className="inline-warning small">{run.contextWarning}</div>}
                    <p>{run.error || run.result}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </div>

        <div className="side-pane">
          <div className="section-title">
            <KeyRound size={19} />
            <h2>Подключения</h2>
          </div>
          {(["kimi", "perplexity"] as const).map((provider) => {
            const status = providerByName(providerStatuses, provider);
            return (
              <div className="provider-row" key={provider}>
                <div className="provider-head">
                  <strong>{provider}</strong>
                  <span className={status?.configured ? "pill ok" : "pill warn"}>
                    {statusLabel(status?.key_source)}
                  </span>
                </div>
                <input
                  type="password"
                  placeholder="API-ключ"
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
                    Сохранить
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
            Ключи хранятся вне репозитория в локальных данных приложения. В v0 они пока не шифруются.
          </p>

          <div className="section-title">
            <FileText size={19} />
            <h2>Research-запрос</h2>
          </div>
          <textarea
            value={providerPrompt}
            onChange={(event) => setProviderPrompt(event.target.value)}
            rows={5}
          />
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => void ask("kimi").catch(() => undefined)}
              disabled={busy || providerBusy.kimi}
            >
              {providerBusy.kimi ? "Kimi думает..." : "Спросить Kimi"}
            </button>
            <button
              className="ghost-button"
              onClick={() => void ask("perplexity").catch(() => undefined)}
              disabled={busy || providerBusy.perplexity}
            >
              {providerBusy.perplexity ? "Perplexity ищет..." : "Спросить Perplexity"}
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
            <h2>Статус агентов</h2>
          </div>
          <pre>{statusOutput || "Загрузка..."}</pre>
        </article>
        <article>
          <div className="section-title">
            <FileText size={19} />
            <h2>События</h2>
          </div>
          <pre>{eventsOutput || "Загрузка..."}</pre>
        </article>
      </section>

      <section className="console-grid">
        <article>
          <div className="section-title">
            <Terminal size={19} />
            <h2>Лог запуска</h2>
          </div>
          <div className="field-row">
            <input
              placeholder="RUN_ID из вывода запуска"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            />
            <button className="ghost-button" onClick={loadRunLog} disabled={busy}>
              Загрузить
            </button>
          </div>
          <pre>{runOutput || "Здесь появятся вывод запуска и логи."}</pre>
        </article>
        <article>
          <div className="section-title">
            <Search size={19} />
            <h2>Заметки провайдеров</h2>
          </div>
          <pre>
            {providerReplies.kimi || providerReplies.perplexity
              ? [providerReplies.kimi, providerReplies.perplexity].filter(Boolean).join("\n\n")
              : "Заметки Kimi и Perplexity появятся здесь после подключения API-ключей."}
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
          инструкция
        </button>
        <button
          className="link-button"
          onClick={() => openWorkspacePath(workspace?.provider_config_path)}
          disabled={!workspace}
        >
          config провайдеров
        </button>
        <button className="link-button" onClick={() => openWorkspacePath(workspace?.bus_root)} disabled={!workspace}>
          agent bus
        </button>
      </footer>
    </main>
  );
}
