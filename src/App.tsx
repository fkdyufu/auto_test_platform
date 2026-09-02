import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Bot,
  ChevronRight,
  CircleStop,
  Cpu,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  LoaderCircle,
  ClipboardList,
  Network,
  Package,
  Play,
  Save,
  Server,
  Settings2,
  TerminalSquare,
  TestTubeDiagonal,
} from "lucide-react";
import { api, type ModelSettings, type RunEvent, type RunStatus } from "./api";
import { RunMonitor } from "./components/RunMonitor";
import { InlineNotice, PageHeader, type Notice } from "./components/ui";
import { ProductsPage } from "./pages/ProductsPage";
import { ResourcesPage } from "./pages/ResourcesPage";
import { TestOrdersPage } from "./pages/TestOrdersPage";

type PageName = "products" | "resources" | "orders" | "run" | "settings";

interface ProviderPreset {
  id: string;
  name: string;
  apiType: ModelSettings["apiType"];
  baseUrl: string;
  modelPlaceholder: string;
}

const PROVIDERS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    apiType: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    modelPlaceholder: "例如 gpt-5.4",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    apiType: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    modelPlaceholder: "例如 deepseek-chat",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    apiType: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    modelPlaceholder: "例如 openai/gpt-5.4",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    apiType: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelPlaceholder: "例如 claude-sonnet-4-6",
  },
  {
    id: "google",
    name: "Google Gemini",
    apiType: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelPlaceholder: "例如 gemini-3-flash",
  },
  {
    id: "custom",
    name: "自定义兼容接口",
    apiType: "openai-completions",
    baseUrl: "http://127.0.0.1:8000/v1",
    modelPlaceholder: "输入接口支持的模型 ID",
  },
];

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

function readPage(): PageName {
  const page = window.location.hash.replace(/^#/, "");
  return page === "resources" || page === "orders" || page === "run" || page === "settings" ? page : "products";
}

function App() {
  const [page, setPage] = useState<PageName>(readPage);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    const onHashChange = () => setPage(readPage());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const refreshSettings = async () => {
    try {
      setSettingsError("");
      setSettings(await api.getSettings());
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "读取配置失败");
    }
  };

  useEffect(() => {
    void refreshSettings();
  }, []);

  const navigate = (target: PageName) => {
    window.location.hash = target;
    setPage(target);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <TestTubeDiagonal size={20} strokeWidth={2} />
          </span>
          <span className="brand-name">AI Test Runner</span>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <button className={`nav-item ${page === "products" ? "active" : ""}`} onClick={() => navigate("products")} title="产品管理">
            <Package size={18} />
            <span>产品管理</span>
            {page === "products" && <ChevronRight className="nav-chevron" size={16} />}
          </button>
          <button className={`nav-item ${page === "resources" ? "active" : ""}`} onClick={() => navigate("resources")} title="资源与环境">
            <Network size={18} />
            <span>资源与环境</span>
            {page === "resources" && <ChevronRight className="nav-chevron" size={16} />}
          </button>
          <button className={`nav-item ${page === "orders" ? "active" : ""}`} onClick={() => navigate("orders")} title="测试单">
            <ClipboardList size={18} />
            <span>测试单</span>
            {page === "orders" && <ChevronRight className="nav-chevron" size={16} />}
          </button>
          <button className={`nav-item ${page === "run" ? "active" : ""}`} onClick={() => navigate("run")} title="自由执行">
            <Play size={18} />
            <span>自由执行</span>
            {page === "run" && <ChevronRight className="nav-chevron" size={16} />}
          </button>
          <button className={`nav-item ${page === "settings" ? "active" : ""}`} onClick={() => navigate("settings")} title="模型设置">
            <Settings2 size={18} />
            <span>模型设置</span>
            {page === "settings" && <ChevronRight className="nav-chevron" size={16} />}
          </button>
        </nav>

        <div className="sidebar-status">
          <div className={`connection-dot ${settings?.configured ? "ready" : ""}`} />
          <div>
            <span className="sidebar-status-label">模型连接</span>
            <strong>{settings?.configured ? settings.model : settingsError ? "服务异常" : "未配置"}</strong>
          </div>
        </div>
      </aside>

      <main className="main-content">
        {page === "products" ? (
          <ProductsPage />
        ) : page === "resources" ? (
          <ResourcesPage />
        ) : page === "orders" ? (
          <TestOrdersPage />
        ) : page === "run" ? (
          <RunPage settings={settings} onOpenSettings={() => navigate("settings")} />
        ) : (
          <SettingsPage initialSettings={settings} onSaved={refreshSettings} />
        )}
      </main>
    </div>
  );
}

function RunPage({ settings, onOpenSettings }: { settings: ModelSettings | null; onOpenSettings: () => void }) {
  const [requirement, setRequirement] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => eventSourceRef.current?.close();
  }, []);

  const isActive = runStatus === "queued" || runStatus === "running";

  const connectEvents = (id: string) => {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/runs/${id}/events`);
    eventSourceRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => (current.some((item) => item.id === event.id) ? current : [...current, event]));
      if (event.type === "run_state" && event.status) {
        setRunStatus(event.status);
        if (["completed", "failed", "cancelled"].includes(event.status)) source.close();
      }
    };
    source.onerror = () => {
      if (runStatus === "running" || runStatus === "queued") {
        setNotice({ kind: "error", message: "执行事件连接已中断" });
      }
    };
  };

  const execute = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings?.configured) {
      setNotice({ kind: "error", message: "请先完成模型配置" });
      return;
    }
    if (!requirement.trim()) {
      setNotice({ kind: "error", message: "请输入测试需求" });
      return;
    }

    try {
      setNotice(null);
      setEvents([]);
      setRunStatus("queued");
      const run = await api.createRun(requirement);
      setRunId(run.id);
      connectEvents(run.id);
    } catch (error) {
      setRunStatus(null);
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "创建任务失败" });
    }
  };

  const cancel = async () => {
    if (!runId) return;
    try {
      await api.cancelRun(runId);
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "取消失败" });
    }
  };

  return (
    <div className="page run-page">
      <PageHeader
        icon={<TerminalSquare size={19} />}
        title="执行用例"
        status={
          <div className={`run-status ${runStatus || "idle"}`}>
            {runStatus === "running" && <LoaderCircle className="spin" size={15} />}
            {!runStatus && <span className="status-dot" />}
            <span>{runStatus ? STATUS_LABELS[runStatus] : "就绪"}</span>
          </div>
        }
      />

      {!settings?.configured && (
        <div className="configuration-alert">
          <AlertCircle size={18} />
          <span>模型尚未配置</span>
          <button onClick={onOpenSettings}>前往设置</button>
        </div>
      )}

      {notice && <InlineNotice notice={notice} onClose={() => setNotice(null)} />}

      <div className="run-workspace">
        <section className="request-pane" aria-labelledby="request-heading">
          <div className="section-heading">
            <div>
              <span className="section-index">01</span>
              <h2 id="request-heading">测试需求</h2>
            </div>
            <span className="model-indicator">
              <Cpu size={14} />
              {settings?.configured ? settings.model : "未配置模型"}
            </span>
          </div>

          <form className="request-form" onSubmit={execute}>
            <textarea
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              disabled={isActive}
              placeholder="访问 http://192.168.1.1，登录设备管理页面，进入系统状态并检查软件版本是否为 1.2.3。"
              aria-label="测试需求"
            />
            <div className="request-actions">
              <span className="character-count">{requirement.length} 字</span>
              {isActive ? (
                <button type="button" className="button secondary danger" onClick={cancel}>
                  <CircleStop size={17} />
                  取消执行
                </button>
              ) : (
                <button type="submit" className="button primary" disabled={!settings?.configured}>
                  <Play size={17} fill="currentColor" />
                  开始执行
                </button>
              )}
            </div>
          </form>
        </section>

        <section className="execution-pane" aria-labelledby="execution-heading">
          <div className="section-heading">
            <div>
              <span className="section-index">02</span>
              <h2 id="execution-heading">执行过程</h2>
            </div>
            {runId && <span className="run-id">{runId.slice(0, 8)}</span>}
          </div>

          <RunMonitor events={events} status={runStatus} />
        </section>
      </div>
    </div>
  );
}

function SettingsPage({
  initialSettings,
  onSaved,
}: {
  initialSettings: ModelSettings | null;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    providerPreset: "openai",
    apiType: "openai-responses" as ModelSettings["apiType"],
    model: "",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    userAgent: "codex-tui/0.151.0",
    reasoningLevel: "medium" as ModelSettings["reasoningLevel"],
  });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    if (!initialSettings) return;
    setForm({
      providerPreset: initialSettings.providerPreset,
      apiType: initialSettings.apiType,
      model: initialSettings.model,
      baseUrl: initialSettings.baseUrl,
      apiKey: "",
      userAgent: initialSettings.userAgent,
      reasoningLevel: initialSettings.reasoningLevel,
    });
  }, [initialSettings]);

  const selectedProvider = PROVIDERS.find((provider) => provider.id === form.providerPreset) || PROVIDERS[5];

  const selectProvider = (providerId: string) => {
    const provider = PROVIDERS.find((item) => item.id === providerId) || PROVIDERS[5];
    setForm((current) => ({
      ...current,
      providerPreset: provider.id,
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      model: "",
    }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true);
      setNotice(null);
      await api.saveSettings(form);
      await onSaved();
      setForm((current) => ({ ...current, apiKey: "" }));
      setNotice({ kind: "success", message: "模型配置已保存" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    try {
      setTesting(true);
      setNotice(null);
      const result = await api.testSettings();
      setNotice({ kind: "success", message: result.message || "模型连接成功" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "连接失败" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page settings-page">
      <PageHeader
        icon={<Settings2 size={19} />}
        title="模型设置"
        status={
          <div className={`run-status ${initialSettings?.configured ? "completed" : "idle"}`}>
            <span className="status-dot" />
            <span>{initialSettings?.configured ? "已配置" : "未配置"}</span>
          </div>
        }
      />

      {notice && <InlineNotice notice={notice} onClose={() => setNotice(null)} />}

      <form className="settings-form" onSubmit={save}>
        <section className="settings-section">
          <div className="settings-section-title">
            <Server size={18} />
            <div>
              <span className="section-index">01</span>
              <h2>模型接口</h2>
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>服务商</span>
              <select value={form.providerPreset} onChange={(event) => selectProvider(event.target.value)}>
                {PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>API 类型</span>
              <select
                value={form.apiType}
                onChange={(event) => setForm((current) => ({ ...current, apiType: event.target.value as ModelSettings["apiType"] }))}
                disabled={form.providerPreset !== "custom"}
              >
                <option value="openai-responses">OpenAI Responses</option>
                <option value="openai-completions">OpenAI Chat Completions</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generative-ai">Google Generative AI</option>
              </select>
            </label>

            <label className="field">
              <span>模型 ID</span>
              <div className="input-with-icon">
                <Cpu size={17} />
                <input
                  value={form.model}
                  onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                  placeholder={selectedProvider.modelPlaceholder}
                  autoComplete="off"
                />
              </div>
            </label>

            <label className="field">
              <span>推理强度</span>
              <select
                value={form.reasoningLevel}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    reasoningLevel: event.target.value as ModelSettings["reasoningLevel"],
                  }))
                }
              >
                <option value="off">关闭</option>
                <option value="minimal">最低</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="xhigh">极高</option>
                <option value="max">最大</option>
              </select>
            </label>

            <label className="field full-width">
              <span>API 地址</span>
              <div className="input-with-icon">
                <Globe2 size={17} />
                <input
                  value={form.baseUrl}
                  onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
              </div>
            </label>

            <label className="field full-width">
              <span>User-Agent</span>
              <div className="input-with-icon">
                <Bot size={17} />
                <input
                  value={form.userAgent}
                  onChange={(event) => setForm((current) => ({ ...current, userAgent: event.target.value }))}
                  placeholder="留空则使用 SDK 默认值"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </label>
          </div>
        </section>

        <section className="settings-section credentials-section">
          <div className="settings-section-title">
            <KeyRound size={18} />
            <div>
              <span className="section-index">02</span>
              <h2>访问凭据</h2>
            </div>
          </div>

          <label className="field full-width">
            <span>API Key</span>
            <div className="input-with-icon key-input">
              <KeyRound size={17} />
              <input
                type={showKey ? "text" : "password"}
                value={form.apiKey}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={initialSettings?.hasApiKey ? `${initialSettings.maskedApiKey}（留空保持不变）` : "输入 API Key"}
                autoComplete="new-password"
              />
              <button type="button" className="icon-button" onClick={() => setShowKey((current) => !current)} title={showKey ? "隐藏 API Key" : "显示 API Key"}>
                {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </label>
        </section>

        <footer className="settings-actions">
          <button type="button" className="button secondary" onClick={testConnection} disabled={testing || saving || !initialSettings?.configured}>
            {testing ? <LoaderCircle className="spin" size={17} /> : <Server size={17} />}
            测试连接
          </button>
          <button type="submit" className="button primary" disabled={saving || testing}>
            {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
            保存配置
          </button>
        </footer>
      </form>
    </div>
  );
}

export default App;
