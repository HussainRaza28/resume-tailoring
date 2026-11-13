/**
 * Facts import: drop a file or paste a link, and the selected provider suggests
 * short facts from it. Each suggestion is checked against the document, and
 * nothing is saved until the user accepts it (as is, or edited).
 */
import { useState } from "react";
import { Upload } from "../blocks/UploadDropzone";
import { DotLoader } from "../blocks/Loaders";
import { type Fact, type Suggestion, type SuggestionResult, api } from "../lib/api";
import { isCmdError } from "../lib/ipc";

/** A file's bytes as base64, for the trip to Python. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject({ kind: "io", message: "That file could not be read." });
    reader.readAsDataURL(file);
  });
}

type Row = Suggestion & { key: number; editing: boolean; draft: string };

export default function FactImport({ onSaved }: { onSaved: (facts: Fact[]) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestionResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  const show = (r: SuggestionResult) => {
    setResult(r);
    setRows(r.suggestions.map((s, i) => ({ ...s, key: i, editing: false, draft: s.text })));
  };

  const fromFile = async (file: File) => {
    setError(null);
    setBusy(`Reading ${file.name}`);
    try {
      show(await api.suggestFactsFromFile(file.name, await fileToBase64(file)));
    } finally {
      setBusy(null);
    }
  };

  const fromUrl = async (target: string) => {
    if (!target.trim()) return;
    setError(null);
    setBusy(`Reading ${target}`);
    try {
      show(await api.suggestFactsFromUrl(target));
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const update = (key: number, change: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const drop = (key: number) => setRows((rs) => rs.filter((r) => r.key !== key));

  const save = async (row: Row, text: string) => {
    try {
      onSaved(await api.saveFact(null, text));
      drop(row.key);
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  return (
    <div className="card fact-import">
      <div className="fact-import-inputs">
        <Upload
          onFile={fromFile}
          accept=".pdf,.docx,.txt,.md"
          maxMb={10}
          hint="PDF, Word, text or Markdown, up to 10 MB"
        />
        <form
          className="fact-import-url"
          onSubmit={(e) => {
            e.preventDefault();
            fromUrl(url);
          }}
        >
          <h2>Or read a page</h2>
          <p className="small muted">A personal site or portfolio. If it links to a resume PDF, you can read that too.</p>
          <div className="row">
            <input className="input grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-site.dev" aria-label="Page to read" />
            <button className="btn" type="submit" disabled={!url.trim() || busy !== null}>
              Read page
            </button>
          </div>
        </form>
      </div>

      {busy && (
        <div className="row small muted">
          <DotLoader label={busy} /> {busy}, then suggesting facts…
        </div>
      )}
      {error && (
        <p className="small" role="alert" style={{ color: "var(--negative)" }}>
          {error}
        </p>
      )}

      {result && (
        <div className="fact-suggestions">
          <div className="row">
            <h2 className="grow">Suggested from {result.source}</h2>
            <span className="small faint">{rows.length ? "Nothing is saved until you accept it." : "All done."}</span>
          </div>
          {result.truncated && <p className="small muted">The document was long, so only its first part was read.</p>}
          {result.pdf_links.length > 0 && (
            <div className="row small" style={{ flexWrap: "wrap" }}>
              <span className="muted">This page links to:</span>
              {result.pdf_links.map((l) => (
                <button key={l.url} className="btn btn-sm" onClick={() => fromUrl(l.url)} disabled={busy !== null}>
                  Read {l.label}
                </button>
              ))}
            </div>
          )}
          {result.suggestions.length === 0 && <p className="small muted">No facts with specifics were found.</p>}
          {rows.map((row) => (
            <div key={row.key} className="suggestion" data-status={row.duplicate ? "duplicate" : row.supported ? "ok" : "blocked"}>
              {row.editing ? (
                <input
                  className="input"
                  value={row.draft}
                  onChange={(e) => update(row.key, { draft: e.target.value })}
                  aria-label="Edit the suggested fact"
                  autoFocus
                />
              ) : (
                <p className="suggestion-text">{row.text}</p>
              )}
              {row.quote && <p className="small faint">From: “{row.quote}”</p>}
              {row.duplicate && <p className="small muted">Already in your facts bank.</p>}
              {!row.supported && !row.editing && (
                <p className="small" style={{ color: "var(--negative)" }}>
                  {row.reasons.join(" ")} Edit it to keep it.
                </p>
              )}
              <div className="row">
                {row.editing ? (
                  <>
                    <button className="btn btn-sm btn-primary" disabled={!row.draft.trim()} onClick={() => save(row, row.draft)}>
                      Save fact
                    </button>
                    <button className="btn btn-sm" onClick={() => update(row.key, { editing: false, draft: row.text })}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-sm btn-primary" disabled={!row.supported || row.duplicate} onClick={() => save(row, row.text)}>
                      Accept
                    </button>
                    <button className="btn btn-sm" onClick={() => update(row.key, { editing: true })}>
                      Edit
                    </button>
                    <button className="btn btn-sm" onClick={() => drop(row.key)}>
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
