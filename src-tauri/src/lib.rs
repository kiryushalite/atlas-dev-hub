use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Serialize)]
struct WorkspaceInfo {
    hub_root: String,
    atlas_root: String,
    bus_root: String,
    worktree_root: String,
    provider_config_path: String,
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

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

fn hub_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot resolve hub root.".to_string())
}

fn workspace_root() -> Result<PathBuf, String> {
    hub_root()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot resolve workspace root.".to_string())
}

fn atlas_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("atlas-v0"))
}

fn bus_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("atlas-v0-agent-bus"))
}

fn worktree_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("atlas-v0-worktrees"))
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
        "perplexity" => env::var("PERPLEXITY_API_KEY").ok(),
        _ => None,
    };
    let key_source = if config_key.is_some() {
        "local-config"
    } else if env_key.as_deref().is_some_and(|value| !value.trim().is_empty()) {
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
        "perplexity" => env::var("PERPLEXITY_API_KEY").ok(),
        _ => None,
    };
    Ok(env_key.filter(|value| !value.trim().is_empty()))
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
        format!("{}...", &text[..LIMIT])
    }
}

#[tauri::command]
fn workspace_info() -> Result<WorkspaceInfo, String> {
    Ok(WorkspaceInfo {
        hub_root: hub_root()?.to_string_lossy().to_string(),
        atlas_root: atlas_root()?.to_string_lossy().to_string(),
        bus_root: bus_root()?.to_string_lossy().to_string(),
        worktree_root: worktree_root()?.to_string_lossy().to_string(),
        provider_config_path: provider_config_path().to_string_lossy().to_string(),
        codex_cli: resolve_codex_cli(),
        claude_cli: find_command("claude"),
    })
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
    entry.api_key = Some(api_key.trim().to_string()).filter(|value| !value.is_empty());
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

    let body = serde_json::json!({
        "model": status.model,
        "messages": [
            {
                "role": "system",
                "content": "You support Atlas Dev Hub. Give concise, actionable engineering advice. Do not claim you changed files unless a tool did it."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0.2
    });

    let client = reqwest::Client::new();
    let response = client
        .post(chat_url(&status.base_url))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let http_status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    if !http_status.is_success() {
        return Err(format!(
            "{} API returned {}: {}",
            provider,
            http_status,
            truncate_error(&text)
        ));
    }

    let parsed: ChatCompletionResponse = serde_json::from_str(&text)
        .map_err(|err| format!("Could not parse provider response: {err}\n{}", truncate_error(&text)))?;
    let content = parsed
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
        .unwrap_or_else(|| "No answer returned.".to_string());

    Ok(ProviderReply {
        provider,
        model: status.model,
        content,
    })
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
