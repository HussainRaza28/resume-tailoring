import { useEffect, useMemo, useState } from "react";
import { useToast } from "../blocks/ToastStack";
import { IconPlus, IconTrash } from "../components/icons";
import { APP_STATUSES, type AppStatus, type Application, api } from "../lib/api";
import { isCmdError } from "../lib/ipc";

const LABEL: Record<AppStatus, string> = {
  tailored: "Tailored",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
};

export default function TrackerScreen({ openRun }: { openRun: (id: string) => void }) {
  const toast = useToast();
  const [apps, setApps] = useState<Application[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ company: "", role: "", date: new Date().toISOString().slice(0, 10) });
  const [filter, setFilter] = useState<AppStatus | "all">("all");

  const load = () => api.listApplications().then(setApps).catch(() => setApps([]));
  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    const c: Record<AppStatus, number> = { tailored: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
    for (const a of apps ?? []) c[a.status]++;
    return c;
  }, [apps]);

  const shown = (apps ?? []).filter((a) => filter === "all" || a.status === filter);

  const save = async (a: Application) => {
    setApps((xs) => xs?.map((x) => (x.id === a.id ? a : x)) ?? null);
    try {
      await api.updateApplication(a);
    } catch (e) {
      toast.push({ tone: "error", title: "Could not save", body: isCmdError(e) ? e.message : String(e) });
      load();
    }
  };

  const add = async () => {
    try {
      await api.addApplication(draft.company, draft.role, draft.date, "applied");
      setDraft({ company: "", role: "", date: draft.date });
      setAdding(false);
      load();
    } catch (e) {
      toast.push({ tone: "error", title: "Could not add", body: isCmdError(e) ? e.message : String(e) });
    }
  };

  return (
    <div className="screen">
      <div className="screen-inner">
        <div className="title-row">
          <div className="grow">
            <h1>Applications</h1>
            <p className="sub">
              {apps == null ? " " : apps.length === 0 ? "Nothing tracked yet. Exporting a tailored PDF adds the role here." : `${apps.length} tracked, ${counts.interview + counts.offer} past the first screen`}
            </p>
          </div>
          <button className="btn" onClick={() => setAdding((a) => !a)}>
            <IconPlus /> Add manually
          </button>
        </div>

        <div className="status-strip" role="group" aria-label="Filter by status">
          {APP_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter((f) => (f === s ? "all" : s))}
              aria-pressed={filter === s}
              style={{ textAlign: "left", background: "none", border: 0, cursor: "pointer", padding: "16px 20px", borderLeft: s === "tailored" ? 0 : "1px solid var(--rule)", boxShadow: filter === s ? "inset 0 -2px 0 var(--text)" : undefined }}
            >
              <div className="label">{LABEL[s]}</div>
              <div className="value num">{counts[s]}</div>
            </button>
          ))}
        </div>

        {apps != null && apps.length > 0 && <Pipeline counts={counts} total={apps.length} />}

        {adding && (
          <form
            className="card row enter"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input className="input" placeholder="Company" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} autoFocus aria-label="Company" />
            <input className="input" placeholder="Role" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} aria-label="Role" />
            <input className="input" type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} style={{ maxWidth: 170 }} aria-label="Date" />
            <button className="btn btn-primary" type="submit" disabled={!draft.company.trim()}>
              Add
            </button>
          </form>
        )}

        <div className="card" style={{ padding: "16px 8px 8px" }}>
          {apps == null ? (
            <div style={{ display: "grid", gap: 10, padding: 12 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 36 }} />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <p className="muted" style={{ padding: "8px 12px 14px" }}>
              {filter === "all" ? "No applications yet." : `No applications marked ${LABEL[filter as AppStatus].toLowerCase()}.`}
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "22%" }}>Company</th>
                  <th style={{ width: "26%" }}>Role</th>
                  <th className="num" style={{ width: 120 }}>
                    Date
                  </th>
                  <th style={{ width: 150 }}>Status</th>
                  <th>Notes</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span style={{ fontWeight: 500 }}>{a.company}</span>
                    </td>
                    <td className="muted">{a.role || "–"}</td>
                    <td className="num muted">{a.date}</td>
                    <td>
                      <label className="sr-only" htmlFor={`st-${a.id}`}>
                        Status for {a.company}
                      </label>
                      <select id={`st-${a.id}`} className="select" value={a.status} onChange={(e) => save({ ...a, status: e.target.value as AppStatus })}>
                        {APP_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{ height: 32, border: 0, background: "transparent", paddingLeft: 0 }}
                        defaultValue={a.notes}
                        placeholder="Add a note"
                        aria-label={`Notes for ${a.company}`}
                        onBlur={(e) => e.target.value !== a.notes && save({ ...a, notes: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      {a.run_id && (
                        <button className="btn btn-sm btn-ghost" onClick={() => openRun(a.run_id!)}>
                          Open
                        </button>
                      )}
                      <button
                        className="btn btn-icon"
                        aria-label={`Delete ${a.company}`}
                        onClick={async () => {
                          await api.deleteApplication(a.id);
                          load();
                        }}
                      >
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

/** How far applications have got: one 100% bar, the hue only on what moved past
 *  the first screen (interview and offer). */
function Pipeline({ counts, total }: { counts: Record<AppStatus, number>; total: number }) {
  const order: AppStatus[] = ["offer", "interview", "applied", "tailored", "rejected"];
  const color: Record<AppStatus, string> = {
    offer: "var(--accent)",
    interview: "color-mix(in srgb, var(--accent) 55%, var(--raised))",
    applied: "var(--control)",
    tailored: "var(--raised)",
    rejected: "color-mix(in srgb, var(--negative) 35%, var(--raised))",
  };
  const moved = counts.interview + counts.offer;
  return (
    <div className="card" style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <h2 className="grow">Past the first screen</h2>
        <span className="num" style={{ fontSize: 20, fontWeight: 600 }}>
          {moved} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>of {total}</span>
        </span>
      </div>
      <div style={{ display: "flex", gap: 2, height: 10, borderRadius: 99, overflow: "hidden" }} role="img" aria-label={order.map((s) => `${LABEL[s]} ${counts[s]}`).join(", ")}>
        {order.filter((s) => counts[s] > 0).map((s) => (
          <span key={s} style={{ flex: counts[s], background: color[s] }} title={`${LABEL[s]}: ${counts[s]}`} />
        ))}
      </div>
      <div className="legend">
        {order.filter((s) => counts[s] > 0).map((s) => (
          <span key={s} className="row" style={{ gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: color[s] }} />
            {LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}
