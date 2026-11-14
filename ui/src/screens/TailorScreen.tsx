import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AsciiWake } from "../blocks/AsciiWake";
import SplitView from "../blocks/SplitView";
import { useToast } from "../blocks/ToastStack";
import { Notice, explainError } from "../components/Notice";
import PdfPreview from "../components/PdfPreview";
import Stepper, { type StepId } from "../components/Stepper";
import { CostFooter, DoneStep, RewriteStep, ScoreStep, SkeletonList, StreamPanel } from "../components/Steps";
import { IconExternal } from "../components/icons";
import { api, finalIsStale, type Fact, type ModelStep, type RunState, type Settings } from "../lib/api";
import { type CmdError, isCmdError } from "../lib/ipc";
import { modKey, pickFolder, reveal } from "../lib/platform";
import type { TailorRequest } from "./JobsScreen";

type Props = {
  runId: string | null;
  settings: Settings;
  provider: string;
  model: string;
  onRunChanged: (run: RunState | null) => void;
  openSettings: () => void;
  importResume: () => void;
  hasBase: boolean;
  setExportDir: (dir: string) => void;
  /** A listing from the Jobs screen: its company, role and, if it could be read, the posting. */
  prefill?: TailorRequest | null;
};

type Pending = { step: string; text: string } | null;

const STEP_TITLES: Record<string, string> = {
  score: "Scoring",
  rewrite: "Rewriting",
  rescore: "Scoring before and after",
};

export default function TailorScreen(p: Props) {
  const toast = useToast();
  const [run, setRun] = useState<RunState | null>(null);
  const [posting, setPosting] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [pastedAt, setPastedAt] = useState<number | null>(null);
  const [view, setView] = useState<StepId>("score");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<(CmdError & { retry?: () => void }) | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [pdfLabel, setPdfLabel] = useState("Base resume");
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<CmdError | null>(null);
  const [focus, setFocus] = useState(0);
  const [note, setNote] = useState("");
  const [exporting, setExporting] = useState(false);
  const compileSeq = useRef(0);

  const update = useCallback(
    (r: RunState | null) => {
      setRun(r);
      p.onRunChanged(r);
    },
    [p],
  );

  const fail = useCallback((e: unknown, retry?: () => void) => {
    const err: CmdError = isCmdError(e) ? e : { kind: "unknown", message: String(e) };
    setError({ ...err, retry });
  }, []);

  /* ---------- load a run from history, or reset ---------- */
  useEffect(() => {
    setError(null);
    if (!p.runId) {
      update(null);
      setPosting("");
      setCompany("");
      setRole("");
      setNote("");
      setPastedAt(null);
      setView("score");
      return;
    }
    if (run?.id === p.runId) return;
    api
      .getRun(p.runId)
      .then((r) => {
        update(r);
        setPosting(r.posting);
        setCompany(r.company);
        const want = new URLSearchParams(window.location.search).get("step") as StepId | null;
        setView(want && ["score", "rewrite", "done"].includes(want) ? want : r.exported_at_ms || r.final ? "done" : r.rewrites.length ? "rewrite" : "score");
      })
      .catch((e) => fail(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.runId]);

  /* a listing picked on the Jobs screen fills in the form */
  useEffect(() => {
    if (!p.prefill || p.runId) return;
    setPosting(p.prefill.posting);
    setCompany(p.prefill.company);
    setRole(p.prefill.role);
    setPastedAt(p.prefill.posting ? Date.now() : null);
  }, [p.prefill, p.runId]);

  useEffect(() => {
    api.listFacts().then(setFacts).catch(() => setFacts([]));
  }, [run?.id]);

  /* ---------- preview ---------- */
  const decisionsKey = run ? JSON.stringify([run.decisions, run.removed, run.rewrites.map((r) => r.new_text)]) : "base";
  useEffect(() => {
    if (!p.hasBase) return;
    const seq = ++compileSeq.current;
    const t = setTimeout(
      async () => {
        setCompiling(true);
        try {
          const bytes = run ? await api.compileRun(run.id) : (await api.compileBase()).pdf;
          if (seq !== compileSeq.current) return;
          setPdf(bytes);
          setPdfLabel(run ? "Tailored" : "Base resume");
          setCompileError(null);
          if (run) {
            const fresh = await api.getRun(run.id);
            if (seq === compileSeq.current) update(fresh);
          }
        } catch (e) {
          if (seq === compileSeq.current) setCompileError(isCmdError(e) ? e : { kind: "unknown", message: String(e) });
        } finally {
          if (seq === compileSeq.current) setCompiling(false);
        }
      },
      run ? 450 : 0,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionsKey, run?.id, p.hasBase]);

  /* ---------- steps ---------- */
  const stream = (step: string) => (e: { type: string; text?: string }) => {
    if (e.type === "started") setPending({ step, text: "" });
    else if (e.type === "delta") setPending((x) => ({ step, text: (x?.text ?? "") + (e.text ?? "") }));
  };

  const runStep = useCallback(
    async (r: RunState, step: ModelStep): Promise<RunState | null> => {
      setError(null);
      setPending({ step, text: "" });
      try {
        const next = await api.runStep(r.id, step, stream(step));
        update(next);
        return next;
      } catch (e) {
        fail(e, () => runStep(r, step));
        try {
          update(await api.getRun(r.id));
        } catch {
          /* keep the last state */
        }
        return null;
      } finally {
        setPending(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, fail],
  );

  const tailor = useCallback(async () => {
    if (pending) return;
    if (!p.hasBase) {
      p.importResume();
      return;
    }
    if (posting.trim().length < 40) {
      setError({ kind: "invalid", message: "Paste the full job posting first." });
      return;
    }
    setError(null);
    try {
      const r = await api.startRun(posting, company, p.provider, p.model, pastedAt, role, p.prefill?.url ?? "");
      update(r);
      setView("score");
      const scored = await runStep(r, "score");
      if (scored) setCompany(scored.company);
    } catch (e) {
      fail(e, tailor);
    }
  }, [pending, p, posting, company, pastedAt, update, runStep, fail]);

  /* The note's facts are saved first, so the rewrite and the checker can use them. */
  const toRewrite = useCallback(async () => {
    if (!run || pending) return;
    let current = run;
    if (note.trim()) {
      try {
        current = await api.addNote(run.id, note);
        update(current);
        setNote("");
        api.listFacts().then(setFacts).catch(() => {});
      } catch (e) {
        fail(e);
        return;
      }
    }
    setView("rewrite");
    setFocus(0);
    await runStep(current, "rewrite");
  }, [run, pending, note, update, runStep, fail]);

  const undoNote = useCallback(async () => {
    if (!run) return;
    update(await api.undoNote(run.id));
    api.listFacts().then(setFacts).catch(() => {});
  }, [run, update]);

  /* Done scores before and after once, and again only when decisions have moved on. */
  const toDone = useCallback(async () => {
    if (!run || pending) return;
    setView("done");
    if (!run.final || finalIsStale(run)) await runStep(run, "rescore");
  }, [run, pending, runStep]);

  const decide = useCallback(
    async (bulletId: string, action: "accept" | "reject" | "reset") => {
      if (!run) return;
      try {
        update(await api.decide(run.id, bulletId, action));
      } catch (e) {
        const err = isCmdError(e) ? e : { kind: "unknown", message: String(e) };
        toast.push({ tone: "error", title: err.kind === "blocked" ? "Blocked rewrites cannot be accepted" : "Could not save that", body: err.message });
      }
    },
    [run, update, toast],
  );

  const chooseDir = useCallback(async () => {
    const dir = await pickFolder(p.settings.export_dir);
    if (dir) p.setExportDir(dir);
  }, [p]);

  const exportPdf = useCallback(async () => {
    if (!run) return;
    const dir = p.settings.export_dir;
    if (!dir) {
      await chooseDir();
      return;
    }
    setExporting(true);
    try {
      const next = await api.exportRun(run.id, dir);
      update(next);
      toast.push({
        tone: "success",
        title: "PDF exported",
        body: next.export_name,
        action: next.exported_path ? { label: "Show", run: () => reveal(next.exported_path!) } : undefined,
      });
    } catch (e) {
      const err = isCmdError(e) ? e : { kind: "unknown", message: String(e) };
      if (err.kind === "too_long") update(await api.getRun(run.id));
      toast.push({ tone: "error", title: explainError(err).title, body: err.message });
    } finally {
      setExporting(false);
    }
  }, [run, p.settings.export_dir, chooseDir, update, toast]);

  const removeBullet = useCallback(
    async (id: string) => {
      if (!run) return;
      update(await api.toggleRemove(run.id, id));
    },
    [run, update],
  );

  /* ---------- keyboard ---------- */
  const changed = run ? run.rewrites.filter((r) => r.status !== "unchanged") : [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (!run) tailor();
        else if (view === "score") toRewrite();
        else if (view === "rewrite") toDone();
        else if (view === "done") exportPdf();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]") || mod || e.altKey) return;
      if (view !== "rewrite" || !changed.length || pending) return;
      const r = changed[Math.min(focus, changed.length - 1)];
      if (e.key === "ArrowDown" || e.key === "j") setFocus((f) => Math.min(changed.length - 1, f + 1));
      else if (e.key === "ArrowUp" || e.key === "k") setFocus((f) => Math.max(0, f - 1));
      else if (e.key === "ArrowRight") {
        decide(r.bullet_id, "accept");
        setFocus((f) => Math.min(changed.length - 1, f + 1));
      } else if (e.key === "ArrowLeft") {
        decide(r.bullet_id, "reject");
        setFocus((f) => Math.min(changed.length - 1, f + 1));
      } else if (e.key === "u") decide(r.bullet_id, "reset");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, view, changed, focus, pending, tailor, toRewrite, toDone, exportPdf, decide]);

  /* commands from the command bar */
  useEffect(() => {
    const onCmd = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (cmd === "run") tailor();
      else if (cmd === "rewrite") toRewrite();
      else if (cmd === "done") toDone();
      else if (cmd === "accept-all" && run) changed.filter((r) => r.status === "ok").forEach((r) => decide(r.bullet_id, "accept"));
    };
    window.addEventListener("tailor:cmd", onCmd);
    return () => window.removeEventListener("tailor:cmd", onCmd);
  }, [tailor, toRewrite, toDone, run, changed, decide]);

  /* ---------- derived ---------- */
  const done = useMemo(() => {
    const s = new Set<StepId>();
    if (run?.score) s.add("score");
    if (run?.rewrites.length) s.add("rewrite");
    if (run?.exported_at_ms) s.add("done");
    return s;
  }, [run]);
  const enabled = useMemo(() => {
    const s = new Set<StepId>(["score"]);
    if (run?.rewrites.length) s.add("rewrite");
    if (run?.rewrites.length) s.add("done");
    return s;
  }, [run]);

  const counts = useMemo(() => {
    const c = { accepted: 0, rejected: 0, pending: 0, blocked: 0 };
    for (const r of changed) {
      const d = run?.decisions[r.bullet_id]?.state ?? "pending";
      c[d]++;
      if (r.status === "blocked" && d === "pending") c.blocked++;
    }
    return c;
  }, [changed, run]);

  const errInfo = error ? explainError(error) : null;
  const errAction = errInfo
    ? errInfo.action === "settings"
      ? { label: "Open Settings", run: p.openSettings }
      : errInfo.action === "import"
        ? { label: "Choose .tex file", run: p.importResume }
        : errInfo.action === "retry" && error?.retry
          ? { label: "Try again", run: error.retry }
          : undefined
    : undefined;

  /* ---------- render ---------- */
  const left = (
    <>
      <div className="work">
        <div className="work-inner">
          {!run ? (
            <EmptyState
              posting={posting}
              company={company}
              role={role}
              setRole={setRole}
              prefill={p.prefill ?? null}
              setPosting={(v) => {
                if (!pastedAt && v.trim()) setPastedAt(Date.now());
                setPosting(v);
              }}
              setCompany={setCompany}
              onTailor={tailor}
              busy={!!pending}
              hasBase={p.hasBase}
              importResume={p.importResume}
            />
          ) : (
            <>
              <div className="run-head">
                <RunTitle run={run} />
                <Stepper current={view} done={done} enabled={enabled} onSelect={(s) => (s === "done" ? toDone() : setView(s))} />
              </div>
              {errInfo && (
                <Notice tone="error" title={errInfo.title} action={errAction}>
                  {errInfo.body}
                </Notice>
              )}
              {pending ? (
                <>
                  <StreamPanel title={STEP_TITLES[pending.step] ?? "Working"} text={pending.text} />
                  {pending.step === "rewrite" && <SkeletonList />}
                </>
              ) : null}
              {(!pending || pending.step === "rescore") && (
                <>
                  {view === "score" && run.score && !pending && (
                    <ScoreStep run={run} note={note} setNote={setNote} onRewrite={toRewrite} undoNote={undoNote} busy={!!pending} />
                  )}
                  {view === "rewrite" && !pending && <RewriteStep run={run} facts={facts} focus={focus} setFocus={setFocus} decide={decide} />}
                  {view === "done" && (
                    <DoneStep
                      run={run}
                      fileName={run.export_name}
                      dir={p.settings.export_dir ?? null}
                      exporting={exporting}
                      scoring={pending?.step === "rescore"}
                      chooseDir={chooseDir}
                      exportPdf={exportPdf}
                      scoreAgain={() => runStep(run, "rescore")}
                      removeBullet={removeBullet}
                      reveal={() => run.exported_path && reveal(run.exported_path)}
                    />
                  )}
                </>
              )}
            </>
          )}
          {!run && errInfo && (
            <Notice tone="error" title={errInfo.title} action={errAction}>
              {errInfo.body}
            </Notice>
          )}
        </div>
        {run && view === "rewrite" && changed.length > 0 && !pending && (
          <div className="summary-bar num">
            <span>
              <b>{counts.accepted}</b> accepted · <b>{counts.rejected}</b> kept · <b>{counts.pending}</b> to decide
            </span>
            <span className="grow" />
            <span className="small faint hint">→ accept · ← keep</span>
            <button className="btn btn-primary btn-sm" onClick={toDone}>
              Done <span className="kbd">{modKey}↵</span>
            </button>
          </div>
        )}
      </div>
      <CostFooter run={run} />
    </>
  );

  const right = (
    <div className="preview">
      <div className="preview-bar">
        <h2 style={{ fontSize: 14 }}>{pdfLabel}</h2>
        {run?.pages != null && (
          <span className={`pill ${run.pages === 1 ? "pill-positive" : "pill-negative"}`}>{run.pages === 1 ? "1 page" : `${run.pages} pages`}</span>
        )}
        <span className="grow" />
        {compiling && <span className="small faint">Compiling</span>}
      </div>
      <div className="desk">
        {!p.hasBase ? (
          <div className="preview-empty">
            <h2>No base resume yet</h2>
            <p>Choose the .tex file you tailor from. It stays on this computer.</p>
            <button className="btn btn-primary" onClick={p.importResume}>
              Choose .tex file
            </button>
          </div>
        ) : compileError && !pdf ? (
          <div style={{ width: "100%", padding: 24, alignSelf: "start" }}>
            <Notice tone="error" title={explainError(compileError).title} action={explainError(compileError).action === "settings" ? { label: "Open Settings", run: p.openSettings } : undefined}>
              {explainError(compileError).body}
            </Notice>
          </div>
        ) : (
          <PdfPreview pdf={pdf} busy={compiling} />
        )}
      </div>
    </div>
  );

  return <SplitView left={left} right={right} storageKey="split-ratio" />;
}

function EmptyState(p: {
  posting: string;
  company: string;
  role: string;
  setRole: (v: string) => void;
  prefill: TailorRequest | null;
  setPosting: (v: string) => void;
  setCompany: (v: string) => void;
  onTailor: () => void;
  busy: boolean;
  hasBase: boolean;
  importResume: () => void;
}) {
  return (
    <>
      <div className="hero enter">
        <AsciiWake />
        <h1>{p.prefill ? `${p.prefill.company}: ${p.prefill.role}` : "Paste a job posting"}</h1>
        <p>Score it, fix the red flags, export a one-page PDF.</p>
      </div>
      {p.prefill && <ListingNotice prefill={p.prefill} />}
      <div className="paste enter">
        <label className="sr-only" htmlFor="posting">
          Job posting
        </label>
        <textarea
          id="posting"
          className="textarea"
          placeholder="Paste the full posting here, including the requirements."
          value={p.posting}
          onChange={(e) => p.setPosting(e.target.value)}
          autoFocus
        />
        <div className="paste-row">
          <label className="sr-only" htmlFor="company">
            Company
          </label>
          <input id="company" className="input" placeholder="Company (found automatically)" value={p.company} onChange={(e) => p.setCompany(e.target.value)} />
          <label className="sr-only" htmlFor="role">
            Role
          </label>
          <input id="role" className="input" placeholder="Role (found automatically)" value={p.role} onChange={(e) => p.setRole(e.target.value)} />
          <span className="spacer" />
          {!p.hasBase && (
            <button className="btn" onClick={p.importResume}>
              Choose base resume
            </button>
          )}
          <button className="btn btn-primary" onClick={p.onTailor} disabled={p.busy || !p.posting.trim()}>
            Tailor <span className="kbd">{modKey}↵</span>
          </button>
        </div>
      </div>
    </>
  );
}

/** Where a listing's posting came from, or why it has to be pasted. */
function ListingNotice({ prefill }: { prefill: TailorRequest }) {
  const open = () => api.openUrl(prefill.url).catch(() => window.open(prefill.url, "_blank"));
  let host = prefill.url;
  try {
    host = new URL(prefill.url).hostname;
  } catch {
    /* keep the link as given */
  }
  return prefill.posting ? (
    <Notice tone="info" title={`Posting read from ${host}`} action={{ label: "View posting", run: open }}>
      Check it's complete.
    </Notice>
  ) : (
    <Notice tone="warning" title="Paste the posting to continue" action={{ label: "View posting", run: open }}>
      This site won't share it with the app. Open it, copy the text and paste it below.
    </Notice>
  );
}

/** Company · Role · ↗ View posting, at the top of every step. */
function RunTitle({ run }: { run: RunState }) {
  const open = () => api.openUrl(run.posting_url).catch(() => window.open(run.posting_url, "_blank"));
  return (
    <div className="run-title">
      <h1>{run.company || "Untitled posting"}</h1>
      {run.role && <span className="muted">· {run.role}</span>}
      {run.posting_url && (
        <button className="link-button" onClick={open}>
          · <IconExternal size={13} /> View posting
        </button>
      )}
    </div>
  );
}
