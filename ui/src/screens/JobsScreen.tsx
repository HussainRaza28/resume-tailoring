/**
 * Jobs: internship listings from the Simplify, vanshb03 and SpeedyApply repos.
 *
 * Opening the screen shows the cached listings at once, then refreshes them if
 * the last fetch is more than an hour old. Search and the filters run in the
 * page. A listing first seen since the previous visit has a New badge.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DotLoader } from "../blocks/Loaders";
import { useToast } from "../blocks/ToastStack";
import { IconCheck, IconExternal, IconRefresh, IconSearch } from "../components/icons";
import { type JobsView, type Listing, api } from "../lib/api";
import { isCmdError } from "../lib/ipc";

/** Listings older than this are refreshed when the screen opens. */
export const STALE_MS = 60 * 60 * 1000;
/** Rows drawn at once; "Show more" adds this many again. */
const PAGE = 100;

const DATE_RANGES: { id: string; label: string; days: number | null }[] = [
  { id: "any", label: "Any time", days: null },
  { id: "1", label: "Past day", days: 1 },
  { id: "3", label: "Past 3 days", days: 3 },
  { id: "7", label: "Past week", days: 7 },
  { id: "30", label: "Past month", days: 30 },
];

export type TailorRequest = { company: string; role: string; url: string; posting: string; reason: string };

/** "Updated just now", "Updated 12 minutes ago", "Updated 3 hours ago". */
export function updatedLabel(fetchedAt: string | null, now: number): string {
  if (!fetchedAt) return "Not loaded yet";
  const minutes = Math.max(0, Math.floor((now - Date.parse(fetchedAt)) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
}

export function isStale(fetchedAt: string | null, now: number): boolean {
  return !fetchedAt || now - Date.parse(fetchedAt) > STALE_MS;
}

type Filters = { search: string; company: string; role: string; location: string; range: string; advanced: boolean };

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.trim().toLowerCase());

/** Typed into the location filter, these mean anywhere in the US. Same list as places.py. */
const US_QUERIES = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"]);
export const meansUs = (q: string) => US_QUERIES.has(q.trim().toLowerCase().replace(/\s+/g, " "));

/** The filters, applied in the page. Each text filter matches anywhere in its field. */
export function filterListings(listings: Listing[], f: Filters, today: Date): Listing[] {
  const days = DATE_RANGES.find((r) => r.id === f.range)?.days ?? null;
  const since = days == null ? "" : new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return listings.filter(
    (x) =>
      (!f.search.trim() || has(`${x.company} ${x.role} ${x.locations.join(" ")}`, f.search)) &&
      (!f.company.trim() || has(x.company, f.company)) &&
      (!f.role.trim() || has(x.role, f.role)) &&
      (!f.location.trim() || (meansUs(f.location) ? x.us : x.locations.some((l) => has(l, f.location)))) &&
      (!since || x.date_posted >= since) &&
      (f.advanced || !x.advanced_degree),
  );
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function JobsScreen({ onTailor }: { onTailor: (request: TailorRequest) => void }) {
  const toast = useToast();
  const [view, setView] = useState<JobsView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [filters, setFilters] = useState<Filters>({ search: "", company: "", role: "", location: "", range: "any", advanced: false });
  const [limit, setLimit] = useState(PAGE);
  const [opening, setOpening] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.jobsRefresh();
      // Keep the New badges from this visit's start; a refresh adds to them.
      setView((v) => ({ ...next, new_ids: Array.from(new Set([...(v?.new_ids ?? []), ...next.new_ids])) }));
      const failed = Object.entries(next.errors);
      if (failed.length) toast.push({ tone: "error", title: `${failed.map(([k]) => k).join(" and ")} could not be refreshed`, body: `${failed.map(([, v]) => v).join(" ")} Showing the last listings saved.` });
    } catch (e) {
      toast.push({ tone: "error", title: "Could not load the listings", body: isCmdError(e) ? e.message : String(e) });
    } finally {
      setRefreshing(false);
      setNow(Date.now());
    }
  }, [toast]);

  useEffect(() => {
    let live = true;
    api
      .jobsOpen()
      .then((v) => {
        if (!live) return;
        setView(v);
        if (isStale(v.fetched_at, Date.now())) refresh();
      })
      .catch(() => live && setView({ fetched_at: null, errors: {}, listings: [], new_ids: [], applied_urls: [] }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* "Updated X minutes ago" keeps moving while the screen is open. */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const listings = view?.listings ?? [];
  const newIds = useMemo(() => new Set(view?.new_ids ?? []), [view]);
  const applied = useMemo(() => new Set(view?.applied_urls ?? []), [view]);
  const shown = useMemo(() => filterListings(listings, filters, new Date(now)), [listings, filters, now]);
  const companies = useMemo(() => Array.from(new Set(listings.map((x) => x.company))).sort(), [listings]);
  const places = useMemo(() => Array.from(new Set(listings.flatMap((x) => x.locations))).sort(), [listings]);
  const set = (k: Exclude<keyof Filters, "advanced">) => (v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setLimit(PAGE);
  };
  const filtered = Object.entries(filters).some(([k, v]) => (k === "advanced" ? false : k === "range" ? v !== "any" : String(v).trim()));
  const advancedCount = useMemo(() => listings.filter((x) => x.advanced_degree).length, [listings]);
  const open = (x: Listing) => api.openUrl(x.url).catch(() => window.open(x.url, "_blank"));

  const tailor = async (x: Listing) => {
    setOpening(x.id);
    try {
      const page = await api.jobPosting(x.url);
      onTailor({ company: x.company, role: x.role, url: x.url, posting: page.ok ? page.text : "", reason: page.ok ? "" : page.reason });
    } catch (e) {
      onTailor({ company: x.company, role: x.role, url: x.url, posting: "", reason: isCmdError(e) ? e.message : String(e) });
    } finally {
      setOpening(null);
    }
  };

  const markApplied = async (x: Listing) => {
    try {
      await api.markApplied(x.company, x.role, x.url);
      setView((v) => (v ? { ...v, applied_urls: [...v.applied_urls, x.url] } : v));
      toast.push({ tone: "success", title: "Marked as applied", body: `${x.company} is in your Applications, with the link.` });
    } catch (e) {
      toast.push({ tone: "error", title: "Could not add it", body: isCmdError(e) ? e.message : String(e) });
    }
  };

  return (
    <div className="screen">
      <div className="screen-inner">
        <div className="title-row">
          <div className="grow">
            <h1>Jobs</h1>
            <p className="sub">{view ? `${listings.length.toLocaleString()} open internships${newIds.size ? ` · ${newIds.size} new` : ""}` : " "}</p>
          </div>
          <span className="small muted num" aria-live="polite">
            {refreshing ? "Updating…" : updatedLabel(view?.fetched_at ?? null, now)}
          </span>
          <button className="btn" onClick={refresh} disabled={refreshing}>
            {refreshing ? <DotLoader label="Refreshing" /> : <IconRefresh />} Refresh
          </button>
        </div>

        <div className="card jobs-filters">
          <label className="jobs-search">
            <IconSearch />
            <span className="sr-only">Search jobs</span>
            <input className="input" placeholder="Search company, role or location" value={filters.search} onChange={(e) => set("search")(e.target.value)} />
          </label>
          <input className="input" placeholder="Company" aria-label="Company" list="jobs-companies" value={filters.company} onChange={(e) => set("company")(e.target.value)} />
          <input className="input" placeholder="Role" aria-label="Role" value={filters.role} onChange={(e) => set("role")(e.target.value)} />
          <input className="input" placeholder="Location" aria-label="Location" list="jobs-places" value={filters.location} onChange={(e) => set("location")(e.target.value)} />
          <select className="select" aria-label="Date posted" value={filters.range} onChange={(e) => set("range")(e.target.value)}>
            {DATE_RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <label className="toggle small muted jobs-advanced">
            <input type="checkbox" checked={filters.advanced} onChange={(e) => setFilters((f) => ({ ...f, advanced: e.target.checked }))} />
            Show PhD and Master's roles{advancedCount ? ` (${advancedCount.toLocaleString()})` : ""}
          </label>
          <datalist id="jobs-companies">
            {companies.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <datalist id="jobs-places">
            {places.slice(0, 400).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {view == null ? (
            <div style={{ padding: 24 }}>
              <div className="skeleton" style={{ height: 14, width: "40%" }} />
            </div>
          ) : listings.length === 0 ? (
            <p className="muted" style={{ padding: 24 }}>
              {refreshing ? "Loading the listings…" : "No listings yet. Refresh to load them."}
            </p>
          ) : (
            <>
              <div className="jobs-count small muted num">
                {filtered ? `${shown.length.toLocaleString()} match` : `${shown.length.toLocaleString()} listings, newest first`}
              </div>
              <table className="table jobs-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Role</th>
                    <th>Location</th>
                    <th className="num">Posted</th>
                    <th>Source</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, limit).map((x) => (
                    <tr key={x.id} data-new={newIds.has(x.id) || undefined}>
                      <td>
                        <span style={{ fontWeight: 500 }}>{x.company}</span>
                        {newIds.has(x.id) && <span className="pill pill-positive new-badge">New</span>}
                      </td>
                      <td>
                        <button className="link-button role-link" onClick={() => open(x)} aria-label={`Open the ${x.company} posting: ${x.role}`}>
                          {x.role} <IconExternal size={13} />
                        </button>
                      </td>
                      <td className="muted">{x.locations.length > 2 ? `${x.locations.slice(0, 2).join(", ")} +${x.locations.length - 2}` : x.locations.join(", ") || "–"}</td>
                      <td className="num muted" title={x.date_posted}>
                        {prettyDate(x.date_posted)}
                      </td>
                      <td className="small muted">{x.sources.join(", ")}</td>
                      <td className="jobs-actions">
                        {applied.has(x.url) ? (
                          <span className="small muted applied-mark" title="In Applications">
                            <IconCheck size={12} /> Applied
                          </span>
                        ) : (
                          <button className="btn btn-sm btn-ghost" onClick={() => markApplied(x)} aria-label={`Mark ${x.company} applied`}>
                            Mark applied
                          </button>
                        )}
                        <button className="btn btn-sm btn-primary" onClick={() => tailor(x)} disabled={opening !== null}>
                          {opening === x.id ? "Reading…" : "Tailor"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length === 0 && <p className="muted" style={{ padding: 24 }}>Nothing matches these filters.</p>}
              {shown.length > limit && (
                <div style={{ padding: 16 }}>
                  <button className="btn" onClick={() => setLimit((n) => n + PAGE)}>
                    Show {Math.min(PAGE, shown.length - limit)} more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
