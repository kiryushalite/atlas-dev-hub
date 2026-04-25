use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    fs::OpenOptions,
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::{Child as TokioChild, ChildStdin, Command as TokioCommand},
    sync::Mutex,
};
use uuid::Uuid;

const CODEX_UI_CHUNK_LIMIT: usize = 200 * 1024;
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const KIMI_OPENROUTER_MODEL: &str = "moonshotai/kimi-k2.6";

#[allow(dead_code)]
struct SessionHandle {
    child: Option<TokioChild>,
    stdin: Option<ChildStdin>,
    thread_id: Option<String>,
    repo: String,
    cwd: PathBuf,
    log_path: PathBuf,
    active_pid: Option<u32>,
    active: bool,
}

static SESSIONS: Lazy<Mutex<HashMap<String, SessionHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize)]
struct WorkspaceInfo {
    hub_root: String,
    atlas_root: String,
    bus_root: String,
    worktree_root: String,
    provider_config_path: String,
    user_guide_path: String,
    codex_stream_ok: bool,
    codex_cli: Option<String>,
    claude_cli: Option<String>,
}

#[derive(Serialize)]
struct ProviderStatus {
    provider: String,
    configured: bool,
    model: String,
    base_url: String,
    key_source: String,
}

#[derive(Serialize)]
struct ProviderReply {
    provider: String,
    model: String,
    route: String,
    content: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct ProviderEntry {
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct ProvidersConfig {
    kimi: ProviderEntry,
    perplexity: ProviderEntry,
}

#[derive(Serialize, Deserialize, Clone)]
struct PersistedSession {
    session_id: String,
    repo: String,
    cwd: String,
    log_path: String,
    thread_id: Option<String>,
    stopped: bool,
    updated_at_ms: u128,
}

#[derive(Serialize)]
struct RestoredCodexSession {
    session_id: String,
    repo: String,
    cwd: String,
    thread_id: Option<String>,
    log_tail: Vec<String>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
    finish_reason: Option<String>,
    text: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: Option<Value>,
    reasoning: Option<String>,
}

struct ProviderAttempt {
    base_url: String,
    model: String,
    route: String,
    api_key: String,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
    output_text: Option<Value>,
}

fn hub_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot resolve hub root.".to_string())
}

fn workspace_root() -> Result<PathBuf, String> {
    let start = hub_root()?;
    for ancestor in start.ancestors().skip(1) {
        let has_atlas = ancestor.join("atlas-v0").exists();
        let has_hub = ancestor.join("atlas-dev-hub").exists()
            || ancestor.join("atlas-dev-hub-worktrees").exists();
        if has_atlas && has_hub {
            return Ok(ancestor.to_path_buf());
        }
    }
    start
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot resolve workspace root.".to_string())
}

fn atlas_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("atlas-v0"))
}

fn primary_hub_root() -> Result<PathBuf, String> {
    let candidate = workspace_root()?.join("atlas-dev-hub");
    if candidate.join("src-tauri").exists() {
        Ok(candidate)
    } else {
        hub_root()
    }
}

fn bus_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("atlas-v0-agent-bus"))
}

fn worktree_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("atlas-v0-worktrees"))
}

fn hub_worktree_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("atlas-dev-hub-worktrees"))
}

fn provider_config_path() -> PathBuf {
    let base = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace_root()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".local")
        });
    base.join("AtlasDevHub").join("providers.json")
}

fn read_provider_config() -> ProvidersConfig {
    let path = provider_config_path();
    let Ok(raw) = fs::read_to_string(path) else {
        return ProvidersConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_provider_config(config: &ProvidersConfig) -> Result<(), String> {
    let path = provider_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    fs::write(path, raw).map_err(|err| err.to_string())
}

fn trim_output(output: &[u8]) -> String {
    String::from_utf8_lossy(output).trim().to_string()
}

fn run_command_text(mut command: Command) -> Result<String, String> {
    let output = command.output().map_err(|err| err.to_string())?;
    let stdout = trim_output(&output.stdout);
    let stderr = trim_output(&output.stderr);
    if output.status.success() {
        if stderr.is_empty() {
            Ok(stdout)
        } else if stdout.is_empty() {
            Ok(stderr)
        } else {
            Ok(format!("{stdout}\n{stderr}"))
        }
    } else {
        Err(format!(
            "Command failed with exit code {:?}.\n{}\n{}",
            output.status.code(),
            stdout,
            stderr
        ))
    }
}

fn script_path(name: &str) -> Result<PathBuf, String> {
    Ok(atlas_root()?.join("scripts").join(name))
}

fn run_script(name: &str, args: Vec<String>) -> Result<String, String> {
    let script = script_path(name)?;
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script)
        .args(args)
        .current_dir(atlas_root()?);
    run_command_text(command)
}

fn find_command(name: &str) -> Option<String> {
    let mut command = Command::new("where.exe");
    command.arg(name);
    let Ok(output) = command.output() else {
        return None;
    };
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn executable_works(path: &str) -> bool {
    Command::new(path)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn resolve_codex_cli() -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Packages")
                .join("OpenAI.Codex_2p2nqsd0c76g0")
                .join("LocalCache")
                .join("Local")
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join("codex.exe")
                .to_string_lossy()
                .to_string(),
        );
    }
    if let Some(path) = find_command("codex.exe") {
        candidates.push(path);
    }
    candidates.push("codex.exe".to_string());
    candidates
        .into_iter()
        .find(|candidate| executable_works(candidate))
}

fn codex_stream_ok() -> bool {
    let Some(codex_cli) = resolve_codex_cli() else {
        return false;
    };
    let Ok(output) = Command::new(codex_cli).args(["exec", "--help"]).output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout).contains("--json")
}

fn provider_defaults(provider: &str) -> Result<(&'static str, &'static str), String> {
    match provider {
        "kimi" => Ok(("kimi-k2.5", "https://api.moonshot.ai/v1")),
        "perplexity" => Ok(("sonar", "https://api.perplexity.ai")),
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

fn provider_entry<'a>(
    provider: &str,
    config: &'a ProvidersConfig,
) -> Result<&'a ProviderEntry, String> {
    match provider {
        "kimi" => Ok(&config.kimi),
        "perplexity" => Ok(&config.perplexity),
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

fn provider_entry_mut<'a>(
    provider: &str,
    config: &'a mut ProvidersConfig,
) -> Result<&'a mut ProviderEntry, String> {
    match provider {
        "kimi" => Ok(&mut config.kimi),
        "perplexity" => Ok(&mut config.perplexity),
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

fn configured_provider(provider: &str, config: &ProvidersConfig) -> Result<ProviderStatus, String> {
    let entry = provider_entry(provider, config)?;
    let (default_model, default_base_url) = provider_defaults(provider)?;
    let model = entry
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(default_model)
        .to_string();
    let base_url = entry
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(default_base_url)
        .to_string();

    let config_key = entry
        .api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let env_key = match provider {
        "kimi" => env::var("KIMI_API_KEY")
            .ok()
            .or_else(|| env::var("MOONSHOT_API_KEY").ok()),
        "perplexity" => env::var("PERPLEXITY_API_KEY")
            .ok()
            .or_else(|| env::var("OPENROUTER_API_KEY").ok()),
        _ => None,
    };
    let key_source = if config_key.is_some() {
        "local-config"
    } else if env_key
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        "environment"
    } else {
        "missing"
    };

    Ok(ProviderStatus {
        provider: provider.to_string(),
        configured: key_source != "missing",
        model,
        base_url,
        key_source: key_source.to_string(),
    })
}

fn provider_api_key(provider: &str, config: &ProvidersConfig) -> Result<Option<String>, String> {
    let entry = provider_entry(provider, config)?;
    if let Some(key) = entry
        .api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(Some(key.to_string()));
    }
    let env_key = match provider {
        "kimi" => env::var("KIMI_API_KEY")
            .ok()
            .or_else(|| env::var("MOONSHOT_API_KEY").ok()),
        "perplexity" => env::var("PERPLEXITY_API_KEY")
            .ok()
            .or_else(|| env::var("OPENROUTER_API_KEY").ok()),
        _ => None,
    };
    Ok(env_key.filter(|value| !value.trim().is_empty()))
}

fn openrouter_api_key(config: &ProvidersConfig) -> Option<String> {
    env::var("OPENROUTER_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            config
                .perplexity
                .api_key
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
        })
}

fn is_openrouter_url(base_url: &str) -> bool {
    base_url.to_lowercase().contains("openrouter.ai")
}

fn openrouter_model(provider: &str, model: &str) -> String {
    match provider {
        "perplexity" if !model.contains('/') => format!("perplexity/{model}"),
        "kimi" if !model.contains('/') => KIMI_OPENROUTER_MODEL.to_string(),
        _ => model.to_string(),
    }
}

fn uses_kimi_k2_5_request_rules(provider: &str, model: &str) -> bool {
    provider == "kimi" && model.trim().to_lowercase().starts_with("kimi-k2.5")
}

fn should_try_kimi_openrouter_fallback(status: reqwest::StatusCode, body: &str) -> bool {
    let body_lower = body.to_lowercase();
    status.as_u16() == 429
        && (body_lower.contains("insufficient balance")
            || body_lower.contains("quota")
            || body_lower.contains("exceeded_current_quota_error"))
}

fn chat_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn truncate_error(text: &str) -> String {
    const LIMIT: usize = 1200;
    if text.len() <= LIMIT {
        text.to_string()
    } else {
        let mut end = LIMIT;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &text[..end])
    }
}

fn non_empty_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn content_value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_text(text),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.as_str()
                        .and_then(non_empty_text)
                        .or_else(|| {
                            part.get("text")
                                .and_then(Value::as_str)
                                .and_then(non_empty_text)
                        })
                        .or_else(|| {
                            part.get("content")
                                .and_then(Value::as_str)
                                .and_then(non_empty_text)
                        })
                })
                .collect::<Vec<_>>()
                .join("\n");
            non_empty_text(&text)
        }
        _ => None,
    }
}

fn provider_user_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
    let body_lower = body.to_lowercase();
    match status.as_u16() {
        401 | 403 => format!(
            "{provider}: API вернул {status}. Ключ найден, но маршрут или тип ключа не подходит для этого API."
        ),
        429 if body_lower.contains("insufficient balance")
            || body_lower.contains("exceeded_current_quota_error") =>
        {
            format!(
                "{provider}: API вернул 429. Ключ принят, но у API-аккаунта провайдера нет баланса или доступной квоты. Проверь баланс API или сохрани другой ключ."
            )
        }
        429 => format!(
            "{provider}: API вернул 429. Ключ найден, backend дошёл до провайдера, но сейчас лимит/квота."
        ),
        _ => format!(
            "{provider}: API вернул {status}: {}",
            truncate_error(body)
        ),
    }
}

fn truncate_utf8(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}...[truncated; full chunk written to session log]",
        &text[..end]
    )
}

fn short_session_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn session_meta_path(session_id: &str) -> Result<PathBuf, String> {
    let run_root = hub_root()?.join(".agent-runs");
    fs::create_dir_all(&run_root).map_err(|err| err.to_string())?;
    Ok(run_root.join(format!("codex-chat-{session_id}.json")))
}

fn persist_session_state(
    session_id: &str,
    session: &SessionHandle,
    stopped: bool,
) -> Result<(), String> {
    let snapshot = PersistedSession {
        session_id: session_id.to_string(),
        repo: session.repo.clone(),
        cwd: session.cwd.to_string_lossy().to_string(),
        log_path: session.log_path.to_string_lossy().to_string(),
        thread_id: session.thread_id.clone(),
        stopped,
        updated_at_ms: now_millis(),
    };
    let path = session_meta_path(session_id)?;
    let raw = serde_json::to_string_pretty(&snapshot).map_err(|err| err.to_string())?;
    fs::write(path, raw).map_err(|err| err.to_string())
}

fn read_log_tail(path: &Path, max_lines: usize) -> Result<Vec<String>, String> {
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut lines = raw
        .lines()
        .rev()
        .take(max_lines)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    Ok(lines)
}

fn modified_millis(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn infer_repo_from_cwd(cwd: &str) -> Option<String> {
    let normalized = cwd.replace('\\', "/").to_lowercase();
    if normalized.contains("atlas-dev-hub") && !normalized.contains("atlas-v0") {
        Some("hub".to_string())
    } else if normalized.contains("atlas-v0") {
        Some("atlas".to_string())
    } else {
        None
    }
}

fn legacy_session_from_log(path: &Path) -> Option<PersistedSession> {
    let name = path.file_name()?.to_str()?;
    let session_id = name.strip_prefix("codex-chat-")?.strip_suffix(".log")?;
    let raw = fs::read_to_string(path).ok()?;
    if raw.contains("[meta] session stopped") {
        return None;
    }
    let cwd = raw
        .lines()
        .find_map(|line| line.strip_prefix("[meta] session created cwd="))?
        .to_string();
    let repo = infer_repo_from_cwd(&cwd)?;
    let thread_id = raw.lines().find_map(|line| {
        let json = line.strip_prefix("[out] ")?;
        let value = serde_json::from_str::<Value>(json).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("thread.started") {
            return None;
        }
        value
            .get("thread_id")
            .and_then(Value::as_str)
            .map(str::to_string)
    })?;

    Some(PersistedSession {
        session_id: session_id.to_string(),
        repo,
        cwd,
        log_path: path.to_string_lossy().to_string(),
        thread_id: Some(thread_id),
        stopped: false,
        updated_at_ms: modified_millis(path),
    })
}

fn configure_git_safe_directory_env(command: &mut TokioCommand, cwd: &Path) {
    let existing_count = env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let safe_directory = cwd.to_string_lossy().replace('\\', "/");
    command.env("GIT_CONFIG_COUNT", (existing_count + 1).to_string());
    command.env(format!("GIT_CONFIG_KEY_{existing_count}"), "safe.directory");
    command.env(format!("GIT_CONFIG_VALUE_{existing_count}"), safe_directory);
}

fn create_hub_chat_worktree(session_id: &str) -> Result<PathBuf, String> {
    let run_id = format!("codex-chat-{}", short_session_id(session_id));
    let branch = format!("agent/codex-hub-{}", short_session_id(session_id));
    let root = hub_worktree_root()?;
    let worktree = root.join(&run_id);
    if worktree.exists() {
        return Err(format!(
            "Hub self-edit worktree already exists: {}. Stop or remove that worktree before retrying.",
            worktree.to_string_lossy()
        ));
    }
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(primary_hub_root()?)
        .args(["worktree", "add", "-b"])
        .arg(&branch)
        .arg(&worktree)
        .arg("main");
    run_command_text(command)?;
    Ok(worktree)
}

fn session_log_path(session_id: &str) -> Result<PathBuf, String> {
    let run_root = hub_root()?.join(".agent-runs");
    fs::create_dir_all(&run_root).map_err(|err| err.to_string())?;
    Ok(run_root.join(format!("codex-chat-{session_id}.log")))
}

async fn append_session_log(path: &Path, kind: &str, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    {
        let _ = file
            .write_all(format!("[{kind}] {line}\n").as_bytes())
            .await;
    }
}

fn update_session_thread(session_id: &str, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("thread.started") {
        return;
    }
    let Some(thread_id) = value.get("thread_id").and_then(Value::as_str) else {
        return;
    };
    let session_id = session_id.to_string();
    let thread_id = thread_id.to_string();
    tauri::async_runtime::spawn(async move {
        let mut sessions = SESSIONS.lock().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            session.thread_id = Some(thread_id);
            let _ = persist_session_state(&session_id, session, false);
        }
    });
}

async fn read_codex_stream<R>(
    app: AppHandle,
    session_id: String,
    log_path: PathBuf,
    stream: R,
    kind: &'static str,
) where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stream).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                append_session_log(&log_path, kind, &line).await;
                if kind == "out" {
                    update_session_thread(&session_id, &line);
                }
                let payload = if line.len() > CODEX_UI_CHUNK_LIMIT {
                    truncate_utf8(&line, CODEX_UI_CHUNK_LIMIT)
                } else {
                    line
                };
                let _ = app.emit(&format!("codex://{session_id}/{kind}"), payload);
            }
            Ok(None) => break,
            Err(err) => {
                let line = format!("stream read failed: {err}");
                append_session_log(&log_path, kind, &line).await;
                let _ = app.emit(&format!("codex://{session_id}/err"), line);
                break;
            }
        }
    }
}

async fn spawn_codex_turn(
    app: AppHandle,
    session_id: String,
    prompt: String,
    resume: bool,
) -> Result<(), String> {
    let codex_cli =
        resolve_codex_cli().ok_or_else(|| "No callable Codex CLI found.".to_string())?;
    if !codex_stream_ok() {
        return Err(
            "Codex CLI does not expose `codex exec --json`; interactive stream is unavailable."
                .to_string(),
        );
    }

    let (cwd, log_path, thread_id) = {
        let mut sessions = SESSIONS.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("Unknown Codex session: {session_id}"))?;
        if session.active {
            return Err("Codex session already has an active turn.".to_string());
        }
        if resume && session.thread_id.is_none() {
            return Err(
                "Codex session is not ready yet; wait for the first thread.started event."
                    .to_string(),
            );
        }
        session.active = true;
        (
            session.cwd.clone(),
            session.log_path.clone(),
            session.thread_id.clone(),
        )
    };

    let last_message_path = log_path.with_extension("last.txt");
    let mut command = TokioCommand::new(codex_cli);
    if resume {
        command
            .args(["exec", "resume", "--json", "--all", "-m", "gpt-5.5"])
            .arg("-o")
            .arg(&last_message_path)
            .arg(thread_id.unwrap())
            .arg("-");
    } else {
        command
            .args(["exec", "--json", "-C"])
            .arg(&cwd)
            .args(["-s", "workspace-write", "-m", "gpt-5.5"])
            .arg("-o")
            .arg(&last_message_path)
            .arg("-");
    }
    command
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    configure_git_safe_directory_env(&mut command, &cwd);

    let mut child = command.spawn().map_err(|err| err.to_string())?;
    let pid = child.id();
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open Codex stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not open Codex stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not open Codex stderr.".to_string())?;

    {
        let mut sessions = SESSIONS.lock().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            session.active_pid = pid;
        }
    }

    let stdin_prompt = if prompt.ends_with('\n') {
        prompt
    } else {
        format!("{prompt}\n")
    };
    stdin
        .write_all(stdin_prompt.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    stdin.shutdown().await.map_err(|err| err.to_string())?;
    drop(stdin);

    append_session_log(
        &log_path,
        "meta",
        &format!("turn started resume={resume} cwd={}", cwd.to_string_lossy()),
    )
    .await;
    let out_task = tauri::async_runtime::spawn(read_codex_stream(
        app.clone(),
        session_id.clone(),
        log_path.clone(),
        stdout,
        "out",
    ));
    let err_task = tauri::async_runtime::spawn(read_codex_stream(
        app.clone(),
        session_id.clone(),
        log_path.clone(),
        stderr,
        "err",
    ));
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        let _ = out_task.await;
        let _ = err_task.await;
        let exit_line = match status {
            Ok(status) => format!("turn exited with status {status}"),
            Err(err) => format!("turn wait failed: {err}"),
        };
        append_session_log(&log_path, "meta", &exit_line).await;
        let payload = serde_json::json!({
            "type": "process.exited",
            "message": exit_line
        })
        .to_string();
        let _ = app.emit(&format!("codex://{session_id}/out"), payload);
        let mut sessions = SESSIONS.lock().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            session.active = false;
            session.active_pid = None;
            let _ = persist_session_state(&session_id, session, false);
        }
    });

    Ok(())
}

#[tauri::command]
fn workspace_info() -> Result<WorkspaceInfo, String> {
    Ok(WorkspaceInfo {
        hub_root: hub_root()?.to_string_lossy().to_string(),
        atlas_root: atlas_root()?.to_string_lossy().to_string(),
        bus_root: bus_root()?.to_string_lossy().to_string(),
        worktree_root: worktree_root()?.to_string_lossy().to_string(),
        provider_config_path: provider_config_path().to_string_lossy().to_string(),
        user_guide_path: hub_root()?
            .join("USER_GUIDE_RU.md")
            .to_string_lossy()
            .to_string(),
        codex_stream_ok: codex_stream_ok(),
        codex_cli: resolve_codex_cli(),
        claude_cli: find_command("claude"),
    })
}

#[tauri::command]
fn read_user_guide_intro() -> Result<String, String> {
    let path = hub_root()?.join("USER_GUIDE_RU.md");
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    Ok(raw
        .split("\n## 2.")
        .next()
        .unwrap_or(&raw)
        .trim()
        .to_string())
}

#[tauri::command]
async fn codex_session_start(
    app: AppHandle,
    repo: String,
    system_prompt: String,
) -> Result<String, String> {
    let repo = repo.to_lowercase();
    let session_id = Uuid::new_v4().to_string();
    let cwd = match repo.as_str() {
        "atlas" => atlas_root()?,
        "hub" => create_hub_chat_worktree(&session_id)?,
        _ => return Err("repo must be `atlas` or `hub`.".to_string()),
    };
    let log_path = session_log_path(&session_id)?;
    let mut prompt = system_prompt;
    if repo == "hub" {
        prompt.push_str(
            "\n\nSelf-edit constraints for repo=hub:\n\
             - You are working inside an atlas-dev-hub git worktree.\n\
             - Do not touch atlas-v0.\n\
             - Required checks before reporting ready: npm run build; cargo check --manifest-path src-tauri/Cargo.toml.\n\
             - Commit only in this hub worktree branch when the change is ready.\n",
        );
    }

    {
        let mut sessions = SESSIONS.lock().await;
        sessions.insert(
            session_id.clone(),
            SessionHandle {
                child: None,
                stdin: None,
                thread_id: None,
                repo,
                cwd: cwd.clone(),
                log_path: log_path.clone(),
                active_pid: None,
                active: false,
            },
        );
        if let Some(session) = sessions.get(&session_id) {
            persist_session_state(&session_id, session, false)?;
        }
    }

    append_session_log(
        &log_path,
        "meta",
        &format!("session created cwd={}", cwd.to_string_lossy()),
    )
    .await;
    let app_for_turn = app.clone();
    let session_for_turn = session_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        if let Err(err) = spawn_codex_turn(
            app_for_turn.clone(),
            session_for_turn.clone(),
            prompt,
            false,
        )
        .await
        {
            let _ = app_for_turn.emit(&format!("codex://{session_for_turn}/err"), err);
        }
    });

    Ok(session_id)
}

#[tauri::command]
async fn codex_session_restore(repo: String) -> Result<Option<RestoredCodexSession>, String> {
    let repo = repo.to_lowercase();
    if repo != "atlas" && repo != "hub" {
        return Err("repo must be `atlas` or `hub`.".to_string());
    }
    let run_root = hub_root()?.join(".agent-runs");
    if !run_root.exists() {
        return Ok(None);
    }

    let mut best: Option<PersistedSession> = None;
    for entry in fs::read_dir(&run_root).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with("codex-chat-") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(snapshot) = serde_json::from_str::<PersistedSession>(&raw) else {
            continue;
        };
        if snapshot.repo != repo
            || snapshot.stopped
            || snapshot.thread_id.is_none()
            || !PathBuf::from(&snapshot.cwd).exists()
            || !PathBuf::from(&snapshot.log_path).exists()
        {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|current| snapshot.updated_at_ms > current.updated_at_ms)
        {
            best = Some(snapshot);
        }
    }
    for entry in fs::read_dir(&run_root).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }
        let Some(snapshot) = legacy_session_from_log(&path) else {
            continue;
        };
        if snapshot.repo != repo
            || snapshot.thread_id.is_none()
            || !PathBuf::from(&snapshot.cwd).exists()
            || !PathBuf::from(&snapshot.log_path).exists()
        {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|current| snapshot.updated_at_ms > current.updated_at_ms)
        {
            best = Some(snapshot);
        }
    }

    let Some(snapshot) = best else {
        return Ok(None);
    };
    let log_tail = read_log_tail(Path::new(&snapshot.log_path), 240).unwrap_or_default();
    {
        let mut sessions = SESSIONS.lock().await;
        sessions
            .entry(snapshot.session_id.clone())
            .or_insert_with(|| SessionHandle {
                child: None,
                stdin: None,
                thread_id: snapshot.thread_id.clone(),
                repo: snapshot.repo.clone(),
                cwd: PathBuf::from(&snapshot.cwd),
                log_path: PathBuf::from(&snapshot.log_path),
                active_pid: None,
                active: false,
            });
    }

    Ok(Some(RestoredCodexSession {
        session_id: snapshot.session_id,
        repo: snapshot.repo,
        cwd: snapshot.cwd,
        thread_id: snapshot.thread_id,
        log_tail,
    }))
}

#[tauri::command]
async fn codex_session_send(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Message is empty.".to_string());
    }
    spawn_codex_turn(app, session_id, text, true).await
}

#[tauri::command]
async fn codex_session_stop(session_id: String) -> Result<(), String> {
    let session = {
        let mut sessions = SESSIONS.lock().await;
        sessions.remove(&session_id)
    };
    if let Some(session) = session {
        if let Some(pid) = session.active_pid {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
        let _ = persist_session_state(&session_id, &session, true);
        append_session_log(&session.log_path, "meta", "session stopped").await;
    }
    Ok(())
}

#[tauri::command]
fn agent_status() -> Result<String, String> {
    run_script("Get-AgentStatus.ps1", Vec::new())
}

#[tauri::command]
fn read_agent_events() -> Result<String, String> {
    let path = bus_root()?.join("events.log");
    if !path.exists() {
        return Ok("No events yet.".to_string());
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    if raw.len() > 60000 {
        Ok(raw[raw.len() - 60000..].to_string())
    } else {
        Ok(raw)
    }
}

#[tauri::command]
fn watch_agent_run(run_id: String, tail: Option<u32>) -> Result<String, String> {
    let tail = tail.unwrap_or(120).to_string();
    run_script(
        "Watch-AgentRun.ps1",
        vec!["-RunId".to_string(), run_id, "-Tail".to_string(), tail],
    )
}

#[tauri::command]
fn start_claude_task(
    name: String,
    task: String,
    mode: String,
    full_pc_access: bool,
    model: String,
    max_budget_usd: Option<f64>,
) -> Result<String, String> {
    let mut args = vec![
        "-Name".to_string(),
        name,
        "-Task".to_string(),
        task,
        "-Mode".to_string(),
        mode,
        "-Model".to_string(),
        if model.trim().is_empty() {
            "sonnet".to_string()
        } else {
            model
        },
    ];
    if let Some(budget) = max_budget_usd {
        args.push("-MaxBudgetUsd".to_string());
        args.push(format!("{budget:.2}"));
    }
    if full_pc_access {
        args.push("-FullPcAccess".to_string());
    }
    run_script("Start-ClaudeBackgroundTask.ps1", args)
}

#[tauri::command]
fn start_codex_task(
    name: String,
    task: String,
    mode: String,
    full_pc_access: bool,
    model: String,
) -> Result<String, String> {
    let mut args = vec![
        "-Name".to_string(),
        name,
        "-Task".to_string(),
        task,
        "-Mode".to_string(),
        mode,
        "-Model".to_string(),
        if model.trim().is_empty() {
            "gpt-5.5".to_string()
        } else {
            model
        },
    ];
    if full_pc_access {
        args.push("-FullPcAccess".to_string());
    }
    run_script("Start-CodexBackgroundTask.ps1", args)
}

#[tauri::command]
fn provider_status() -> Result<Vec<ProviderStatus>, String> {
    let config = read_provider_config();
    Ok(vec![
        configured_provider("kimi", &config)?,
        configured_provider("perplexity", &config)?,
    ])
}

#[tauri::command]
fn save_provider_config(
    provider: String,
    api_key: String,
    model: String,
    base_url: String,
) -> Result<Vec<ProviderStatus>, String> {
    let provider = provider.to_lowercase();
    let mut config = read_provider_config();
    let entry = provider_entry_mut(&provider, &mut config)?;
    if !api_key.trim().is_empty() {
        entry.api_key = Some(api_key.trim().to_string());
    }
    entry.model = Some(model.trim().to_string()).filter(|value| !value.is_empty());
    entry.base_url = Some(base_url.trim().to_string()).filter(|value| !value.is_empty());
    write_provider_config(&config)?;
    provider_status()
}

#[tauri::command]
async fn ask_provider(provider: String, prompt: String) -> Result<ProviderReply, String> {
    let provider = provider.to_lowercase();
    let config = read_provider_config();
    let status = configured_provider(&provider, &config)?;
    let Some(api_key) = provider_api_key(&provider, &config)? else {
        return Err(format!(
            "{} is not configured. Add an API key in Connections first.",
            status.provider
        ));
    };

    let client = reqwest::Client::new();
    let direct_route = if provider == "kimi" && !is_openrouter_url(&status.base_url) {
        "Moonshot direct".to_string()
    } else {
        status.base_url.clone()
    };
    let mut attempts = vec![ProviderAttempt {
        base_url: status.base_url.clone(),
        model: if is_openrouter_url(&status.base_url) {
            openrouter_model(&provider, &status.model)
        } else {
            status.model.clone()
        },
        route: direct_route,
        api_key,
    }];
    if provider == "perplexity" && !is_openrouter_url(&status.base_url) {
        attempts.push(ProviderAttempt {
            base_url: OPENROUTER_BASE_URL.to_string(),
            model: openrouter_model(&provider, &status.model),
            route: "OpenRouter fallback".to_string(),
            api_key: attempts[0].api_key.clone(),
        });
    }
    if provider == "kimi" && !is_openrouter_url(&status.base_url) {
        if let Some(openrouter_key) = openrouter_api_key(&config) {
            attempts.push(ProviderAttempt {
                base_url: OPENROUTER_BASE_URL.to_string(),
                model: openrouter_model(&provider, &status.model),
                route: "OpenRouter fallback".to_string(),
                api_key: openrouter_key,
            });
        }
    }

    let mut failures = Vec::new();
    let attempts_len = attempts.len();
    for (index, attempt) in attempts.into_iter().enumerate() {
        let mut body = serde_json::json!({
            "model": attempt.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You support Atlas Dev Hub. Give concise, actionable engineering advice. Do not claim you changed files unless a tool did it."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        });
        if provider == "kimi" {
            body["max_tokens"] = serde_json::json!(1024);
            if is_openrouter_url(&attempt.base_url) {
                body["reasoning"] = serde_json::json!({ "effort": "none" });
            } else if uses_kimi_k2_5_request_rules(&provider, &attempt.model) {
                body["thinking"] = serde_json::json!({ "type": "disabled" });
            }
        } else {
            body["temperature"] = serde_json::json!(0.2);
        }

        let mut request = client
            .post(chat_url(&attempt.base_url))
            .bearer_auth(&attempt.api_key)
            .json(&body);
        if is_openrouter_url(&attempt.base_url) {
            request = request
                .header("HTTP-Referer", "http://localhost")
                .header("X-Title", "Atlas Dev Hub");
        }
        let response = request.send().await.map_err(|err| err.to_string())?;
        let http_status = response.status();
        let text = response.text().await.map_err(|err| err.to_string())?;
        if !http_status.is_success() {
            failures.push(format!(
                "{}: {}",
                attempt.route,
                provider_user_error(&provider, http_status, &text)
            ));
            if provider == "perplexity"
                && index == 0
                && !is_openrouter_url(&attempt.base_url)
                && matches!(http_status.as_u16(), 401 | 403)
            {
                continue;
            }
            if provider == "kimi"
                && index == 0
                && attempts_len > 1
                && !is_openrouter_url(&attempt.base_url)
                && should_try_kimi_openrouter_fallback(http_status, &text)
            {
                continue;
            }
            return Err(failures.join("\n"));
        }

        let parsed: ChatCompletionResponse = serde_json::from_str(&text).map_err(|err| {
            format!(
                "Could not parse provider response: {err}\n{}",
                truncate_error(&text)
            )
        })?;
        let response_output_text = parsed.output_text.as_ref().and_then(content_value_text);
        let first_choice = parsed.choices.into_iter().next();
        let finish_reason = first_choice
            .as_ref()
            .and_then(|choice| choice.finish_reason.as_deref())
            .unwrap_or("unknown")
            .to_string();
        let reasoning_len = first_choice
            .as_ref()
            .and_then(|choice| choice.message.reasoning.as_deref())
            .map(str::len)
            .unwrap_or(0);
        let content = first_choice
            .as_ref()
            .and_then(|choice| choice.message.content.as_ref())
            .and_then(content_value_text)
            .or_else(|| {
                first_choice
                    .as_ref()
                    .and_then(|choice| choice.text.as_deref())
                    .and_then(non_empty_text)
            })
            .or(response_output_text)
            .ok_or_else(|| {
                format!(
                    "{}: provider returned HTTP {} but no answer text (model: {}, finish_reason: {}, reasoning_len: {}).",
                    attempt.route,
                    http_status.as_u16(),
                    attempt.model,
                    finish_reason,
                    reasoning_len
                )
            })?;

        return Ok(ProviderReply {
            provider,
            model: attempt.model,
            route: attempt.route,
            content,
        });
    }

    Err(failures.join("\n"))
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            workspace_info,
            read_user_guide_intro,
            codex_session_start,
            codex_session_restore,
            codex_session_send,
            codex_session_stop,
            agent_status,
            read_agent_events,
            watch_agent_run,
            start_claude_task,
            start_codex_task,
            provider_status,
            save_provider_config,
            ask_provider,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Atlas Dev Hub");
}
