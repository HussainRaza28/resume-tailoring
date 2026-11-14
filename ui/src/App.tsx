import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import CollapsingSidebar, { useCollapsed } from "./blocks/CollapsingSidebar";
import CommandBar, { type Command } from "./blocks/CommandBar";
import Menu, { type MenuOption } from "./blocks/Menu";
import { useToast } from "./blocks/ToastStack";
import { IconBriefcase, IconChevron, IconFacts, IconJobs, IconPlus, IconSearch, IconSettings, IconSidebar, IconTheme, Mark } from "./components/icons";
import { type AppInfo, type RunRecord, type RunState, type Settings, api, modelLabel, providerLabel } from "./lib/api";
import { APP_NAME } from "./lib/config";
import { shortDate } from "./lib/format";
import { isCmdError } from "./lib/ipc";
import { modKey, pickTexFile } from "./lib/platform";
import FactsScreen from "./screens/FactsScreen";
import JobsScreen, { type TailorRequest } from "./screens/JobsScreen";
import SettingsScreen from "./screens/SettingsScreen";
import TailorScreen from "./screens/TailorScreen";
import TrackerScreen from "./screens/TrackerScreen";

type Screen = "tailor" | "jobs" | "tracker" | "facts" | "settings";

const MODEL_OPTIONS: MenuOption[] = [
  { value: "claude_code:sonnet", label: "Claude Code, Sonnet", detail: "Uses your Claude plan", group: "Claude" },
  { value: "claude_code:opus", label: "Claude Code, Opus", detail: "Uses your Claude plan, slower", group: "Claude" },
  { value: "claude_api:claude-sonnet-5-5", label: "Claude API, Sonnet 5.5", detail: "API key · prompt caching", group: "Claude" },
  { value: "claude_api:claude-opus-5-5", label: "Claude API, Opus 5.5", detail: "API key · costs more", group: "Claude" },
  { value: "codex:default", label: "ChatGPT (Codex)", detail: "Uses your ChatGPT plan", group: "Other providers" },
  { value: "gemini:", label: "Gemini", detail: "Free tier, uses the model set in Settings", group: "Other providers" },
  { value: "ollama:", label: "Ollama", detail: "Local, offline", group: "Other providers" },
  { value: "demo:demo", label: "Offline demo", detail: "No key, placeholder output", group: "Other providers" },
];

/** The model a provider uses when Settings has none saved. */
export const DEFAULT_MODELS: Record<string, string> = {
  claude_api: "claude-sonnet-5-5",
  claude_code: "sonnet",
  codex: "default",
  gemini: "gemini-flash-latest",
  demo: "demo",
};

function applyTheme(theme: string) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export default function App() {
  const toast = useToast();
  // Browser-only deep links (mock mode): ?screen=settings, ?run=sample&step=done
  const params = new URLSearchParams(window.location.search);
  const [screen, setScreen] = useState<Screen>(() => (["jobs", "tracker", "facts", "settings"].includes(params.get("screen") ?? "") ? (params.get("screen") as Screen) : "tailor"));
  const [collapsed, setCollapsed] = useCollapsed();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<Settings>({});
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runId, setRunId] = useState<string | null>(() => params.get("run"));
  const [current, setCurrent] = useState<RunState | null>(null);
  const [theme, setThemeState] = useState<string>(() => {
    try {
      return localStorage.getItem("theme") ?? "dark";
    } catch {
      return "dark";
    }
  });

  const loadRuns = useCallback(() => api.listRuns().then(setRuns).catch(() => setRuns([])), []);

  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {});
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (s.theme) setThemeState(s.theme);
      })
      .catch(() => {});
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* in-memory only */
    }
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  const setSetting = useCallback((k: keyof Settings, v: string) => {
    setSettings((s) => ({ ...s, [k]: v }));
    api.setSetting(k, v).catch(() => {});
  }, []);

  const setTheme = useCallback(
    (t: string) => {
      setThemeState(t);
      setSetting("theme", t);
    },
    [setSetting],
  );

  const provider = settings.provider ?? "claude_code";
  const model = settings[`model.${provider}` as keyof Settings] ?? DEFAULT_MODELS[provider] ?? "";

  const importResume = useCallback(async () => {
    const path = await pickTexFile();
    if (!path) return;
    try {
      await api.importBaseResume(path);
      setInfo(await api.appInfo());
      toast.push({ tone: "success", title: "Base resume saved", body: "It stays in your private data folder." });
    } catch (e) {
      toast.push({ tone: "error", title: "That file could not be used", body: isCmdError(e) ? e.message : String(e) });
    }
  }, [toast]);

  /* A listing picked on the Jobs screen, waiting to be tailored. */
  const [prefill, setPrefill] = useState<TailorRequest | null>(null);

  const newRun = useCallback(() => {
    setRunId(null);
    setCurrent(null);
    setPrefill(null);
    setScreen("tailor");
  }, []);

  const tailorListing = useCallback((request: TailorRequest) => {
    setRunId(null);
    setCurrent(null);
    setPrefill(request);
    setScreen("tailor");
  }, []);

  const openRun = useCallback((id: string) => {
    setRunId(id);
    setScreen("tailor");
  }, []);

  const onRunChanged = useCallback(
    (r: RunState | null) => {
      setCurrent(r);
      if (r && r.id !== runId) setRunId(r.id);
      loadRuns();
    },
    [runId, loadRuns],
  );

  /* global shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newRun();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setScreen("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newRun, setCollapsed]);

  const emit = (cmd: string) => window.dispatchEvent(new CustomEvent("tailor:cmd", { detail: cmd }));
  const commands: Command[] = useMemo(() => {
    const base: Command[] = [
      { id: "new", group: "Tailor", label: "New tailoring run", hint: `${modKey}N`, icon: <IconPlus />, run: newRun },
      { id: "run", group: "Tailor", label: current ? "Next step" : "Tailor the pasted posting", hint: `${modKey}↵`, keywords: "run start continue", icon: <IconTheme />, run: () => emit(current ? (current.rewrites.length ? "done" : "rewrite") : "run") },
      { id: "accept-all", group: "Tailor", label: "Accept every rewrite that passed the checks", icon: <IconPlus />, keywords: "approve all", run: () => emit("accept-all") },
      { id: "done", group: "Tailor", label: "Go to Done", keywords: "pdf save export score", icon: <IconPlus />, run: () => emit("done") },
      { id: "jobs", group: "Go to", label: "Jobs", icon: <IconJobs />, keywords: "internships listings simplify speedyapply", run: () => setScreen("jobs") },
      { id: "tracker", group: "Go to", label: "Applications", icon: <IconBriefcase />, keywords: "tracker", run: () => setScreen("tracker") },
      { id: "facts", group: "Go to", label: "Facts bank", icon: <IconFacts />, run: () => setScreen("facts") },
      { id: "settings", group: "Go to", label: "Settings", hint: `${modKey},`, icon: <IconSettings />, keywords: "keys api model stopwatch baseline", run: () => setScreen("settings") },
      { id: "theme", group: "View", label: theme === "light" ? "Switch to dark theme" : "Switch to light theme", icon: <IconTheme />, run: () => setTheme(theme === "light" ? "dark" : "light") },
      { id: "sidebar", group: "View", label: collapsed ? "Expand sidebar" : "Collapse sidebar", hint: `${modKey}B`, icon: <IconSidebar />, run: () => setCollapsed((c) => !c) },
      { id: "resume", group: "Base resume", label: "Choose base resume .tex", icon: <IconFacts />, run: importResume },
    ];
    for (const m of MODEL_OPTIONS) {
      base.push({
        id: `model-${m.value}`,
        group: "Model",
        label: `Use ${m.label}`,
        keywords: "provider model switch",
        run: () => {
          const [p, mod] = m.value.split(":");
          setSetting("provider", p);
          if (mod) setSetting(`model.${p}` as keyof Settings, mod);
        },
      });
    }
    for (const r of runs.slice(0, 30)) {
      base.push({ id: `run-${r.id}`, group: "History", label: `${r.company || "Untitled"}${r.role ? `, ${r.role}` : ""}`, keywords: shortDate(r.created_at), run: () => openRun(r.id) });
    }
    return base;
  }, [current, newRun, theme, collapsed, importResume, runs, openRun, setTheme, setSetting, setCollapsed]);

  const crumb = screen === "tailor" ? (current ? current.company || "Untitled posting" : "New posting") : screen === "jobs" ? "Jobs" : screen === "tracker" ? "Applications" : screen === "facts" ? "Facts bank" : "Settings";
  const nav: { id: Screen; label: string; icon: React.ReactNode; hint?: string }[] = [
    { id: "tailor", label: "Tailor", icon: <IconPlus />, hint: `${modKey}N` },
    { id: "jobs", label: "Jobs", icon: <IconJobs /> },
    { id: "tracker", label: "Applications", icon: <IconBriefcase /> },
    { id: "facts", label: "Facts bank", icon: <IconFacts /> },
    { id: "settings", label: "Settings", icon: <IconSettings /> },
  ];

  return (
    <div className="shell">
      <CollapsingSidebar collapsed={collapsed}>
        <div className="brand">
          <button className="btn btn-icon" style={{ width: "auto", padding: 0 }} onClick={() => collapsed && setCollapsed(false)} aria-label={collapsed ? "Expand sidebar" : APP_NAME} title={collapsed ? "Expand sidebar" : undefined}>
            <Mark />
          </button>
          <span className="brand-name">{APP_NAME}</span>
          <button className="btn btn-icon collapse-btn" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" title={`Collapse (${modKey}B)`}>
            <IconSidebar />
          </button>
        </div>
        <nav className="nav" aria-label="Main">
          {nav.map((n) => (
            <button
              key={n.id}
              className="nav-item"
              aria-current={screen === n.id ? "page" : undefined}
              title={collapsed ? n.label : undefined}
              aria-label={n.label}
              onClick={() => (n.id === "tailor" ? newRun() : setScreen(n.id))}
            >
              {n.icon}
              <span className="nav-label">{n.label}</span>
              {n.hint && <span className="kbd">{n.hint}</span>}
            </button>
          ))}
        </nav>
        <div className="group-label">
          <span>History</span>
          <span className="num">{runs.length || ""}</span>
        </div>
        <div className="history">
          {runs.length === 0 && <p className="small faint" style={{ padding: "4px 10px" }}>Tailored resumes show up here.</p>}
          {runs.map((r) => (
            <button key={r.id} className="history-item" aria-current={screen === "tailor" && runId === r.id} onClick={() => openRun(r.id)}>
              <span className="history-company">{r.company || "Untitled posting"}</span>
              <span className="history-date num">{shortDate(r.created_at)}</span>
              <span className="history-role">
                {[r.role, r.status === "exported" ? "exported" : r.status === "failed" ? "stopped" : ""].filter(Boolean).join(" · ") || "–"}
              </span>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <span style={{ width: 8, height: 8, borderRadius: 99, background: info?.has_base_resume ? "var(--accent)" : "var(--negative)", flex: "none" }} />
          <span className="sidebar-foot-text">{info?.has_base_resume ? "base_resume.tex" : "No base resume"}</span>
        </div>
      </CollapsingSidebar>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            {collapsed ? null : <span className="muted">{screen === "tailor" ? "Tailor" : APP_NAME}</span>}
            {collapsed ? null : <span className="sep">/</span>}
            <span className="current">{crumb}</span>
          </div>
          <button className="cmd-hint" onClick={() => setCmdOpen(true)} aria-label="Open the command bar">
            <IconSearch />
            <span>Search history or run a command</span>
            <span className="kbd">{modKey}K</span>
          </button>
          <div className="topbar-right">
            <Menu
              label="Provider and model"
              value={`${provider}:${provider === "gemini" || provider === "ollama" ? "" : model}`}
              options={MODEL_OPTIONS}
              onChange={(v) => {
                const [p, m] = v.split(":");
                setSetting("provider", p);
                if (m) setSetting(`model.${p}` as keyof Settings, m);
              }}
              trigger={
                <>
                  <span className="muted">{providerLabel(provider)}</span>
                  <span>{model ? modelLabel(model) : "Pick a model"}</span>
                  <IconChevron />
                </>
              }
            />
          </div>
        </header>

        {screen === "tailor" && (
          <TailorScreen
            runId={runId}
            settings={settings}
            provider={provider}
            model={model}
            onRunChanged={onRunChanged}
            openSettings={() => setScreen("settings")}
            importResume={importResume}
            hasBase={!!info?.has_base_resume}
            setExportDir={(d) => setSetting("export_dir", d)}
            prefill={prefill}
          />
        )}
        {screen === "jobs" && <JobsScreen onTailor={tailorListing} />}
        {screen === "tracker" && <TrackerScreen openRun={openRun} />}
        {screen === "facts" && <FactsScreen />}
        {screen === "settings" && <SettingsScreen info={info} settings={settings} setSetting={setSetting} theme={theme} setTheme={setTheme} importResume={importResume} onInfo={setInfo} />}
      </div>

      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} commands={commands} placeholder="Search history, switch model, or run a command" />
    </div>
  );
}
