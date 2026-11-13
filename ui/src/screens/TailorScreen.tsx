import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsciiWake from "../blocks/AsciiWake";
import SplitView from "../blocks/SplitView";
import { useToast } from "../blocks/ToastStack";
import { Notice, explainError } from "../components/Notice";
import PdfPreview from "../components/PdfPreview";
import Stepper, { type StepId } from "../components/Stepper";
import { CostFooter, ExportStep, RedFlagsStep, ReviewStep, RewriteStep, SkeletonList, StreamPanel } from "../components/Steps";
import { api, type Application, type Fact, type RunState, type Settings } from "../lib/api";
import { type CmdError, isCmdError } from "../lib/ipc";
import { modKey, pickFolder, reveal, writeClipboard } from "../lib/platform";

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
};

type Pending = { step: string; text: string } | null;

const STEP_TITLES: Record<string, string> = {
  red_flags: "Skimming like a recruiter",
  rewrite: "Rewriting bullets and checking every claim",
  rewrite_one: "Rewriting with your answer",
  review: "Scoring as an ATS and a hiring manager",
};

export default function TailorScreen(p: Props) {
  const toast = useToast();
  const [run, setRun] = useState<RunState | null>(null);
  const [posting, setPosting] = useState("");
  const [company, setCompany] = useState("");
  const [pastedAt, setPastedAt] = useState<number | null>(null);
  const [view, setView] = useState<StepId>("red_flags");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<(CmdError & { retry?: () => void }) | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [pdfLabel, setPdfLabel] = useState("Base resume");
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<CmdError | null>(null);
  const [focus, setFocus] = useState(0);
  const [editRequest, setEditRequest] = useState(0);
  const [busyBullet, setBusyBullet] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [application, setApplication] = useState<Application | null>(null);
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
      setPastedAt(null);
      setView("red_flags");
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
        setView(want && ["red_flags", "rewrite", "review", "export"].includes(want) ? want : r.exported_at_ms ? "export" : r.review_after ? "review" : r.rewrites.length ? "rewrite" : "red_flags");
      })
      .catch((e) => fail(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.runId]);

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

  useEffect(() => {
    if (!run?.exported_at_ms) {
      setApplication(null);
      return;
    }
    api
      .listApplications()
      .then((apps) => setApplication(apps.find((a) => a.run_id === run.id) ?? null))
      .catch(() => setApplication(null));
  }, [run?.id, run?.exported_at_ms]);

  /* ---------- steps ---------- */
  const stream = (step: string) => (e: { type: string; text?: string }) => {
    if (e.type === "started") setPending({ step, text: "" });
    else if (e.type === "delta") setPending((x) => ({ step, text: (x?.text ?? "") + (e.text ?? "") }));
  };

  const runStep = useCallback(
    async (r: RunState, step: "red_flags" | "rewrite" | "review"): Promise<RunState | null> => {
      setError(null);
      setPending({ step, text: "" });
      try {
        const next = await api.runStep(r.id, step, stream(step));
        update(next);
        return next;
      } catch (e) {
        fail(e, () => {
          runStep(r, step).then((n) => {
            if (n && step === "red_flags") runStep(n, "rewrite");
          });
        });
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
      const r = await api.startRun(posting, company, p.provider, p.model, pastedAt);
      update(r);
      setView("red_flags");
      const afterFlags = await runStep(r, "red_flags");
      if (!afterFlags) return;
      setCompany(afterFlags.company);
      setView("rewrite");
      setFocus(0);
      await runStep(afterFlags, "rewrite");
    } catch (e) {
      fail(e, tailor);
    }
  }, [pending, p, posting, company, pastedAt, update, runStep, fail]);

  const toReview = useCallback(async () => {
    if (!run || pending) return;
    setView("review");
    await runStep(run, "review");
  }, [run, pending, runStep]);

  const decide = useCallback(
    async (bulletId: string, action: "accept" | "reject" | "reset" | "edit", text?: string) => {
      if (!run) return;
      try {
        const next = await api.decide(run.id, bulletId, action, text);
        update(next);
        if (action === "edit") {
          const r = next.rewrites.find((x) => x.bullet_id === bulletId);
          if (r?.status === "blocked") toast.push({ tone: "error", title: "Your edit was blocked", body: r.reasons[0] });
        }
      } catch (e) {
        const err = isCmdError(e) ? e : { kind: "unknown", message: String(e) };
        toast.push({ tone: "error", title: err.kind === "blocked" ? "Blocked rewrites cannot be accepted" : "Could not save that", body: err.message });
      }
    },
    [run, update, toast],
  );

  const answer = useCallback(
    async (bulletId: string, text: string) => {
      if (!run) return;
      setBusyBullet(bulletId);
      try {
        const next = await api.answerQuestion(run.id, bulletId, text, stream("rewrite_one"));
        update(next);
        if (text.trim()) toast.push({ tone: "success", title: "Saved to your facts bank", body: "It will be reused on future runs." });
        api.listFacts().then(setFacts).catch(() => {});
      } catch (e) {
        fail(e);
      } finally {
        setBusyBullet(null);
        setPending(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, update, toast, fail],
  );

  const acceptSuggestion = useCallback(
    async (section: number, bulletId: string) => {
      if (!run) return;
      try {
        update(await api.acceptSuggestion(run.id, section, bulletId));
      } catch (e) {
        toast.push({ tone: "error", title: "Could not accept that rewrite", body: isCmdError(e) ? e.message : String(e) });
      }
    },
    [run, update, toast],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        await writeClipboard(text);
        toast.push({ tone: "success", title: "Copied", body: text.length > 70 ? `${text.slice(0, 70)}…` : text });
      } catch {
        toast.push({ tone: "error", title: "Could not copy to the clipboard" });
      }
    },
    [toast],
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

  const setStatus = useCallback(
    async (status: string) => {
      if (!application) return;
      const next = { ...application, status: status as Application["status"] };
      await api.updateApplication(next);
      setApplication(next);
      toast.push({ tone: "success", title: `Marked as ${status}` });
    },
    [application, toast],
  );

  /* ---------- keyboard ---------- */
  const changed = run ? run.rewrites.filter((r) => r.status !== "unchanged") : [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (!run) tailor();
        else if (view === "rewrite") toReview();
        else if (view === "review") setView("export");
        else if (view === "export") exportPdf();
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
      } else if (e.key === "e") setEditRequest((n) => n + 1);
      else if (e.key === "u") decide(r.bullet_id, "reset");
      else if (e.key === "c") copy(r.new_text);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, view, changed, focus, pending, tailor, toReview, exportPdf, decide, copy]);

  /* commands from the command bar */
  useEffect(() => {
    const onCmd = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (cmd === "run") tailor();
      else if (cmd === "review") toReview();
      else if (cmd === "export") run && setView("export");
      else if (cmd === "accept-all" && run) changed.filter((r) => r.status === "ok").forEach((r) => decide(r.bullet_id, "accept"));
    };
    window.addEventListener("tailor:cmd", onCmd);
    return () => window.removeEventListener("tailor:cmd", onCmd);
  }, [tailor, toReview, run, changed, decide]);

  /* ---------- derived ---------- */
  const done = useMemo(() => {
    const s = new Set<StepId>();
    if (run?.red_flags) s.add("red_flags");
    if (run?.rewrites.length) s.add("rewrite");
    if (run?.review_after) s.add("review");
    if (run?.exported_at_ms) s.add("export");
    return s;
  }, [run]);
  const enabled = useMemo(() => {
    const s = new Set<StepId>(["red_flags"]);
    if (run?.red_flags) s.add("rewrite");
    if (run?.rewrites.length) s.add("review");
    if (run?.rewrites.length) s.add("export");
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
                <div>
                  <h1>{run.company || "Untitled posting"}</h1>
                  <p className="muted" style={{ marginTop: 2 }}>{run.role || "Role not found in the posting"}</p>
                </div>
                <Stepper current={view} done={done} enabled={enabled} onSelect={setView} />
              </div>
              {errInfo && (
                <Notice tone="error" title={errInfo.title} action={errAction}>
                  {errInfo.body}
                </Notice>
              )}
              {pending && pending.step !== "rewrite_one" ? (
                <>
                  <StreamPanel title={STEP_TITLES[pending.step] ?? "Working"} text={pending.text} />
                  {pending.step === "rewrite" && <SkeletonList />}
                </>
              ) : (
                <>
                  {view === "red_flags" && run.red_flags && (
                    <>
                      <RedFlagsStep run={run} />
                      {run.rewrites.length > 0 && (
                        <button className="btn" style={{ justifySelf: "start" }} onClick={() => setView("rewrite")}>
                          See the rewrites that fix these
                        </button>
                      )}
                    </>
                  )}
                  {view === "rewrite" && (
                    <RewriteStep
                      run={run}
                      facts={facts}
                      focus={focus}
                      setFocus={setFocus}
                      busyBullet={busyBullet}
                      editRequest={editRequest}
                      decide={decide}
                      answer={answer}
                      copy={copy}
                    />
                  )}
                  {view === "review" && run.review_after && <ReviewStep run={run} facts={facts} acceptSuggestion={acceptSuggestion} copy={copy} />}
                  {view === "review" && !run.review_after && (
                    <div className="card" style={{ display: "grid", gap: 12, justifyItems: "start" }}>
                      <h2>Score the resume</h2>
                      <p className="muted">Scores your base resume and the version with your accepted rewrites, and lists sections a busy reader would skip.</p>
                      <button className="btn btn-primary" onClick={toReview}>
                        Run review <span className="kbd">{modKey}↵</span>
                      </button>
                    </div>
                  )}
                  {view === "export" && (
                    <ExportStep
                      run={run}
                      fileName={run.export_name}
                      dir={p.settings.export_dir ?? null}
                      exporting={exporting}
                      chooseDir={chooseDir}
                      exportPdf={exportPdf}
                      removeBullet={removeBullet}
                      reveal={() => run.exported_path && reveal(run.exported_path)}
                      status={application?.status ?? null}
                      setStatus={setStatus}
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
              {counts.blocked > 0 && <span style={{ color: "var(--negative)" }}> · {counts.blocked} blocked</span>}
            </span>
            <span className="grow" />
            <span className="small faint hint">↑↓ move · → accept · ← keep · E edit</span>
            <button className="btn btn-primary btn-sm" onClick={toReview}>
              Continue to review <span className="kbd">{modKey}↵</span>
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
        <AsciiWake width={440} height={190} />
        <h1>Paste a job posting</h1>
        <p>Red flags, grounded rewrites and a review, then a one-page PDF in your own template. Nothing is invented: every claim is checked against your resume.</p>
      </div>
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
