import { useEffect, useRef, useState } from "react";
import { useToast } from "../blocks/ToastStack";
import { IconTimer, IconTrash } from "../components/icons";
import { type AppInfo, type BaselineEntry, type ClaudeCodeStatus, type KeyStatus, type OllamaModel, type Settings, api } from "../lib/api";
import { clock, duration, median, shortDate } from "../lib/format";
import { isCmdError } from "../lib/ipc";

type Props = {
  info: AppInfo | null;
  settings: Settings;
  setSetting: (k: keyof Settings, v: string) => void;
  theme: string;
  setTheme: (t: string) => void;
  importResume: () => void;
};

function KeyField({ provider, label, hint }: { provider: "claude_api" | "gemini"; label: string; hint: string }) {
  const toast = useToast();
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    api.keyStatus(provider).then(setStatus).catch(() => setStatus(null));
  }, [provider]);
  return (
    <div className="field">
      <span>{label}</span>
      {status?.saved ? (
        <div className="row">
          <span className="input mono grow" style={{ display: "flex", alignItems: "center" }} aria-label={`${label} saved`}>
            {status.masked}
          </span>
          <span className="pill pill-positive">In keychain</span>
          <button
            className="btn btn-sm"
            onClick={async () => {
              await api.deleteKey(provider);
              setStatus({ provider, saved: false, masked: null });
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setStatus(await api.saveKey(provider, value));
              setValue("");
              toast.push({ tone: "success", title: `${label} saved to the keychain` });
            } catch (err) {
              toast.push({ tone: "error", title: "Could not save the key", body: isCmdError(err) ? err.message : String(err) });
            }
          }}
        >
          <input className="input grow mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={hint} aria-label={label} autoComplete="off" spellCheck={false} />
          <button className="btn btn-sm" type="submit" disabled={!value.trim()}>
            Save
          </button>
        </form>
      )}
    </div>
  );
}

function Stopwatch() {
  const toast = useToast();
  const [entries, setEntries] = useState<BaselineEntry[]>([]);
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState("");
  const timer = useRef<number>(0);

  useEffect(() => {
    api.listBaseline().then(setEntries).catch(() => setEntries([]));
  }, []);
  useEffect(() => {
    if (start == null) return;
    timer.current = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer.current);
  }, [start]);

  const stop = async () => {
    if (start == null) return;
    const ms = Date.now() - start;
    setStart(null);
    try {
      setEntries(await api.addBaseline(ms, note));
      setNote("");
      toast.push({ tone: "success", title: `Recorded ${duration(ms)}` });
    } catch (e) {
      toast.push({ tone: "error", title: "Could not save the time", body: isCmdError(e) ? e.message : String(e) });
    }
  };
  const med = median(entries.map((e) => e.duration_ms));
  return (
    <div className="panel">
      <div className="row">
        <span className="stopwatch grow" aria-live="off">
          {clock(start == null ? 0 : now - start)}
        </span>
        {start == null ? (
          <button
            className="btn btn-primary"
            onClick={() => {
              setStart(Date.now());
              setNow(Date.now());
            }}
          >
            <IconTimer /> Start
          </button>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={() => setStart(null)}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={stop}>
              Stop and save
            </button>
          </>
        )}
      </div>
      <input className="input" placeholder="Note (optional), e.g. the company" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note for this timing" />
      <div className="row small">
        <span className="muted grow">
          {entries.length} timing{entries.length === 1 ? "" : "s"} recorded{entries.length < 3 ? `, ${3 - entries.length} more for a fair median` : ""}
        </span>
        <span className="num">Median {med == null ? "–" : duration(med)}</span>
      </div>
      {entries.length > 0 && (
        <table className="table">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="faint num" style={{ width: 90 }}>
                  {shortDate(e.started_at)}
                </td>
                <td className="muted">{e.note || "–"}</td>
                <td className="num">{duration(e.duration_ms)}</td>
                <td style={{ width: 44 }}>
                  <button className="btn btn-icon" aria-label="Delete timing" onClick={async () => setEntries(await api.deleteBaseline(e.id))}>
                    <IconTrash />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SettingsScreen({ info, settings, setSetting, theme, setTheme, importResume }: Props) {
  const provider = settings.provider ?? "claude_code";
  const [claudeCode, setClaudeCode] = useState<ClaudeCodeStatus | null>(null);
  const [ollama, setOllama] = useState<OllamaModel[] | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [gemini, setGemini] = useState<string[] | null>(null);

  useEffect(() => {
    if (provider !== "claude_code") return;
    api.claudeCodeStatus().then(setClaudeCode).catch(() => setClaudeCode(null));
  }, [provider]);

  useEffect(() => {
    if (provider !== "gemini") return;
    api.geminiModels().then(setGemini).catch(() => setGemini(null));
  }, [provider]);

  useEffect(() => {
    if (provider !== "ollama") return;
    api
      .ollamaModels()
      .then((m) => {
        setOllama(m);
        setOllamaError(null);
      })
      .catch((e) => setOllamaError(isCmdError(e) ? e.message : String(e)));
  }, [provider]);

  return (
    <div className="screen">
      <div className="screen-inner" style={{ maxWidth: 1080 }}>
        <div className="title-row">
          <div className="grow">
            <h1>Settings</h1>
            <p className="sub">Saved on this computer. API keys live in the system keychain, never in files.</p>
          </div>
        </div>

        <section className="settings-section">
          <div>
            <h2>Model</h2>
            <p className="desc">The default for new runs. You can switch per run from the top bar.</p>
          </div>
          <div className="panel">
            <div className="segmented" role="group" aria-label="Provider">
              {[
                ["claude_code", "Claude Code (Pro plan)"],
                ["claude_api", "Claude API"],
                ["gemini", "Gemini"],
                ["ollama", "Ollama"],
                ["demo", "Offline demo"],
              ].map(([id, label]) => (
                <button key={id} aria-pressed={provider === id} onClick={() => setSetting("provider", id)}>
                  {label}
                </button>
              ))}
            </div>
            {provider === "claude_code" && (
              <>
                <div className="row">
                  <span className="grow small muted">Claude Code</span>
                  {claudeCode === null ? (
                    <span className="pill">Checking…</span>
                  ) : !claudeCode.installed ? (
                    <span className="pill pill-negative">Not installed</span>
                  ) : claudeCode.signed_in ? (
                    <span className="pill pill-positive">Installed · signed in</span>
                  ) : (
                    <span className="pill pill-negative">Installed · not signed in</span>
                  )}
                </div>
                {claudeCode?.installed && !claudeCode.signed_in && (
                  <span className="small faint">
                    Run <span className="mono">claude auth login</span> in a terminal, then come back.
                  </span>
                )}
                {claudeCode?.path && (
                  <span className="small faint mono selectable">
                    {claudeCode.path}
                    {claudeCode.version ? ` · ${claudeCode.version}` : ""}
                  </span>
                )}
                <label className="field">
                  <span>Claude Code model</span>
                  <select className="select" value={settings["model.claude_code"] ?? "sonnet"} onChange={(e) => setSetting("model.claude_code", e.target.value)}>
                    <option value="sonnet">Sonnet, latest (default)</option>
                    <option value="opus">Opus, latest</option>
                  </select>
                  <span className="small faint">Each step runs through the claude command on this computer and counts toward your Claude plan, not API credits.</span>
                </label>
              </>
            )}
            {provider === "claude_api" && (
              <label className="field">
                <span>Claude model</span>
                <select className="select" value={settings["model.claude_api"] ?? "claude-sonnet-5-5"} onChange={(e) => setSetting("model.claude_api", e.target.value)}>
                  <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (default)</option>
                  <option value="claude-opus-5-5">Claude Opus 5.5</option>
                </select>
              </label>
            )}
            {provider === "gemini" && (
              <label className="field">
                <span>Gemini model</span>
                <select className="select" value={settings["model.gemini"] ?? "gemini-flash-latest"} onChange={(e) => setSetting("model.gemini", e.target.value)}>
                  <option value="gemini-flash-latest">Gemini Flash, latest (default, free tier)</option>
                  {(gemini ?? []).filter((m) => m !== "gemini-flash-latest").map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <span className="small faint">{gemini ? `${gemini.length} models available to your key.` : "Save a Gemini key to list every model your key can use."}</span>
              </label>
            )}
            {provider === "ollama" && (
              <label className="field">
                <span>Installed Ollama model</span>
                {ollamaError ? (
                  <span className="small" style={{ color: "var(--negative)" }}>
                    {ollamaError}
                  </span>
                ) : (
                  <select className="select" value={settings["model.ollama"] ?? ""} onChange={(e) => setSetting("model.ollama", e.target.value)}>
                    <option value="">Choose a model</option>
                    {(ollama ?? []).map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}
            {provider === "demo" && <p className="small muted">The offline demo runs the whole flow without a key. Its red flags and scores are placeholders, not a real review.</p>}
            {(provider === "claude_api" || provider === "claude_code") && (
              <label className="field">
                <span>Effort</span>
                <select className="select" value={settings.effort ?? ""} onChange={(e) => setSetting("effort", e.target.value)}>
                  <option value="">Model default</option>
                  <option value="low">Low, fastest</option>
                  <option value="medium">Medium</option>
                  <option value="high">High, slower</option>
                </select>
              </label>
            )}
          </div>
        </section>

        <section className="settings-section">
          <div>
            <h2>API keys</h2>
            <p className="desc">Stored in the macOS Keychain or Windows Credential Manager. The app only ever shows the first and last characters.</p>
          </div>
          <div className="panel">
            <KeyField provider="claude_api" label="Anthropic API key" hint="sk-ant-…" />
            <KeyField provider="gemini" label="Gemini API key" hint="AIza…" />
          </div>
        </section>

        <section className="settings-section">
          <div>
            <h2>Base resume</h2>
            <p className="desc">The .tex file every run starts from. Only text inside bullets, headings and skills lines is ever changed.</p>
          </div>
          <div className="panel">
            <div className="row">
              <span className="grow small muted selectable">{info?.has_base_resume ? `${info.data_dir}/base_resume.tex` : "Not chosen yet"}</span>
              <button className="btn btn-sm" onClick={importResume}>
                {info?.has_base_resume ? "Replace" : "Choose .tex file"}
              </button>
            </div>
            <div className="row">
              <span className="grow small muted">PDF compiler (Tectonic)</span>
              {info?.tectonic_path ? <span className="pill pill-positive">Found</span> : <span className="pill pill-negative">Not found</span>}
            </div>
            {info?.tectonic_path && <span className="small faint mono selectable">{info.tectonic_path}</span>}
          </div>
        </section>

        <section className="settings-section">
          <div>
            <h2>Manual baseline</h2>
            <p className="desc">Time your old copy-and-paste process with a chat window, start to exported PDF, three to five times. The results compare these with the app's own paste-to-PDF times.</p>
          </div>
          <Stopwatch />
        </section>

        <section className="settings-section">
          <div>
            <h2>Appearance</h2>
            <p className="desc">Motion follows your system's Reduce Motion setting.</p>
          </div>
          <div className="panel">
            <div className="segmented" role="group" aria-label="Theme">
              {[
                ["dark", "Dark"],
                ["light", "Light"],
                ["system", "System"],
              ].map(([id, label]) => (
                <button key={id} aria-pressed={theme === id} onClick={() => setTheme(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div>
            <h2>Data</h2>
            <p className="desc">History, tracker, facts bank and tailored outputs. All on this computer.</p>
          </div>
          <div className="panel">
            <span className="small mono selectable">{info?.data_dir ?? "–"}</span>
            <span className="small faint">
              {info?.name} {info?.version}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
