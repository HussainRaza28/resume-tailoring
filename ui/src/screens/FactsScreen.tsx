import { useEffect, useState } from "react";
import { useToast } from "../blocks/ToastStack";
import FactImport from "../components/FactImport";
import { IconPlus, IconTrash } from "../components/icons";
import { type Fact, api } from "../lib/api";
import { shortDate } from "../lib/format";
import { isCmdError } from "../lib/ipc";

export default function FactsScreen() {
  const toast = useToast();
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    api.listFacts().then(setFacts).catch(() => setFacts([]));
  }, []);

  const run = async (p: Promise<Fact[]>) => {
    try {
      setFacts(await p);
    } catch (e) {
      toast.push({ tone: "error", title: "Could not save the fact", body: isCmdError(e) ? e.message : String(e) });
    }
  };

  return (
    <div className="screen">
      <div className="screen-inner" style={{ maxWidth: 900 }}>
        <div className="title-row">
          <div className="grow">
            <h1>Facts bank</h1>
            <p className="sub">Things you know that your resume does not say yet. Rewrites may cite these, and nothing else.</p>
          </div>
        </div>
        <FactImport onSaved={setFacts} />
        <form
          className="card row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            run(api.saveFact(null, draft));
            setDraft("");
          }}
        >
          <input className="input grow" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Skypane had 40 beta testers on TestFlight" aria-label="New fact" />
          <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
            <IconPlus /> Add fact
          </button>
        </form>
        <div className="card" style={{ padding: "8px 8px" }}>
          {facts == null ? (
            <div className="skeleton" style={{ height: 40, margin: 12 }} />
          ) : facts.length === 0 ? (
            <p className="muted" style={{ padding: 14 }}>
              Empty. When a rewrite asks “how many…?”, your answer lands here and is reused next time.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Id</th>
                  <th>Fact</th>
                  <th className="num" style={{ width: 90 }}>
                    Added
                  </th>
                  <th style={{ width: 50 }} />
                </tr>
              </thead>
              <tbody>
                {facts.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <span className="chip">{f.id}</span>
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{ height: 34, border: 0, background: "transparent", paddingLeft: 0 }}
                        defaultValue={f.text}
                        aria-label={`Edit fact ${f.id}`}
                        onBlur={(e) => e.target.value.trim() && e.target.value !== f.text && run(api.saveFact(f.id, e.target.value))}
                      />
                      {f.bullet_text && <div className="small faint" style={{ marginTop: -6, marginBottom: 8 }}>About: {f.bullet_text.slice(0, 90)}{f.bullet_text.length > 90 ? "…" : ""}</div>}
                    </td>
                    <td className="num faint">{shortDate(f.created_at)}</td>
                    <td>
                      <button className="btn btn-icon" aria-label={`Delete fact ${f.id}`} onClick={() => run(api.deleteFact(f.id))}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
