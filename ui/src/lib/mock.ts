/**
 * In-memory stand-in for the Python backend, used only when the UI runs in a plain
 * browser (screenshots, Playwright, `npm run dev`). It serves the fake sample
 * resume in tests/fixtures (Jordan Sample) and the offline demo provider's kind of
 * output. None of this ships as data or appears in measured results.
 */
import { emit as emitTo, installMockBackend } from "./ipc";
import samplePosting from "../../../tests/fixtures/sample_posting.txt?raw";
import type { Application, BaselineEntry, CheckedRewrite, Coverage, Fact, FinalScore, ItemResult, JobsView, Listing, RewriteSummary, RunRecord, RunState, ScoreResult, StepEvent } from "./api";

const SAMPLE_POSTING = samplePosting.trim();

const now = () => new Date().toISOString();

function rw(id: string, entry: string, section: string, old: string, next: string, status: CheckedRewrite["status"], extra: Partial<CheckedRewrite> = {}): CheckedRewrite {
  return {
    bullet_id: id,
    entry,
    section,
    old_text: old,
    new_text: next,
    sources: [id],
    why: "",
    status,
    grounding: { claims: [], citation_errors: [] },
    style: [],
    reasons: [],
    dropped: [],
    warnings: [],
    ...extra,
  };
}

const NW = "Northwind Logistics | Software Engineering Intern, Routing Team";
const LIB = "Springfield Public Library | Student Technology Assistant";
const TM = "**TrailMap** | *TypeScript, React, Node.js, PostgreSQL*";
const BB = "**Budget Bot** | *Python, SQLite*";

function summary(lines: number, changed: number, blocked: number, hadAdvice: boolean, message: string): RewriteSummary {
  return { lines, changed, blocked, same_text: lines - changed - blocked, skipped: 0, bold_only: 0, reorder_only: 0, unknown_ids: [], retried: true, retry_error: "", had_advice: hadAdvice, block_reasons: [], message };
}

function rewrites(): CheckedRewrite[] {
  return [
    rw("b2", NW, "Experience", "Built a Python service that batches delivery route updates, cutting API calls to the mapping provider from **12,000 to 3,000 per day**", "Cut mapping API calls from **12,000 to 3,000 per day** by building a Python service that batches delivery route updates", "ok", { why: "Leads with the result the platform team cares about" }),
    rw("b3", NW, "Experience", "Added PostgreSQL indexes to the shipment lookup query after profiling showed full table scans on 2 million rows", "Removed full table scans on 2 million shipment rows by profiling the lookup query and adding PostgreSQL indexes", "ok", { why: "Puts the scale first" }),
    rw("b4", NW, "Experience", "Wrote 45 unit tests with pytest for the route validation module and set them to run in GitHub Actions on every pull request", "Wrote 45 unit tests with pytest for the route validation module and set them to run in GitHub Actions on every pull request", "unchanged"),
    rw("b5", NW, "Experience", "Worked with the team on various backend tasks and helped with code reviews", "Reviewed 40+ pull requests and shipped backend features with the routing team", "blocked", {
      why: "Replaces a vague teamwork line",
      grounding: { claims: [{ text: "40+", kind: "number", supported: false }], citation_errors: [] },
      reasons: ['Number "40+" is not in the cited sources.'],
    }),
    rw("b6", LIB, "Experience", "Helped patrons with computer and printer problems at the help desk", "Resolved computer and printer problems for library patrons at the help desk", "ok", { why: "Swaps a soft verb for the outcome" }),
    rw("b7", LIB, "Experience", "Set up 20 laptops for a weekly coding club for middle school students", "Set up 20 laptops for a weekly coding club for middle school students", "unchanged"),
    rw("b8", TM, "Projects", "Built a web app for logging hikes on an interactive map, used by 140 members of the university hiking club", "Built a web app for logging hikes on an interactive map, used by 140 members of the university hiking club", "unchanged"),
    rw("b9", TM, "Projects", "Designed a REST API in Node.js with JWT login and rate limiting", "Designed the Node.js REST API behind TrailMap, with JWT login and rate limiting", "ok", { why: "Names the API's job for a REST-heavy role" }),
    rw("b10", BB, "Projects", "Made a Discord bot that tracks shared expenses for roommates and posts a weekly summary", "Made a Discord bot that tracks shared expenses for roommates and posts a weekly summary", "unchanged"),
    rw("b11", BB, "Projects", "Parsed bank CSV exports from 3 banks into one SQLite schema", "Seamlessly unified bank CSV exports from 3 banks into one SQLite schema", "ok", {
      style: [{ rule: "stock_word", excerpt: "Seamlessly", message: '"Seamlessly" is a stock word. Say what actually happened.' }],
      warnings: ['Stock word: "Seamlessly" is a stock word. Say what actually happened.'],
    }),
  ];
}

function coverage(after: boolean): Coverage {
  const s = (skill: string, tier: "required" | "preferred", covered: boolean, have: boolean, evidence: string | null = have ? "base" : null) => ({ skill, tier, covered, have, addable: have && !covered, evidence });
  const skills = [
    s("Python", "required", true, true),
    s("SQL", "required", true, true),
    s("PostgreSQL", "required", true, true),
    s("Docker", "required", true, true),
    s("Git", "required", true, true),
    s("REST", "required", after, true),
    s("TypeScript", "preferred", true, true),
    s("Node.js", "preferred", true, true),
    s("Redis", "preferred", false, true, "f1"),
    s("Kubernetes", "preferred", false, false),
    s("AWS", "preferred", false, false),
  ];
  const req = skills.filter((x) => x.tier === "required");
  const pref = skills.filter((x) => x.tier === "preferred");
  return {
    skills,
    required_total: req.length,
    required_have: req.filter((x) => x.have).length,
    required_covered: req.filter((x) => x.covered).length,
    preferred_total: pref.length,
    preferred_have: pref.filter((x) => x.have).length,
    preferred_covered: pref.filter((x) => x.covered).length,
  };
}

type Db = {
  runs: Map<string, RunState>;
  apps: Application[];
  jobsFetchedAt: string | null;
  facts: Fact[];
  baseline: BaselineEntry[];
  settings: Record<string, string>;
  keys: Record<string, string>;
  hasBase: boolean;
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const job = (company: string, role: string, locations: string[], age: number, url: string, sources: string[], isNew = false, us = true, advanced = false): Listing & { isNew: boolean } => ({
  id: url.split("?")[0],
  company,
  role,
  locations,
  date_posted: daysAgo(age),
  url,
  sources,
  first_seen_at: "",
  advanced_degree: advanced,
  us,
  isNew,
});

/** Sample listings in the shape the two repos give. The Workday one can't be read, like the real thing. */
const JOBS = [
  job("Larkspur Freight", "Software Engineer Intern, Platform", ["Chicago, IL"], 0, "https://jobs.larkspur.example/platform-intern", ["Simplify", "SpeedyApply"], true),
  job("Northbeam Energy", "Backend Software Intern - Summer 2027", ["Denver, CO", "Remote in USA"], 0, "https://northbeam.wd5.myworkdayjobs.com/en-US/careers/job/Backend-Intern_R1023", ["Simplify"], true),
  job("Harbor Analytics", "Data Engineering Intern", ["Boston, MA"], 2, "https://jobs.harbor.example/data-intern", ["SpeedyApply"]),
  job("Kestrel Robotics", "Software Intern, Autonomy", ["Pittsburgh, PA"], 4, "https://kestrel.example/careers/autonomy-intern", ["Simplify"]),
  job("Quillstone", "Full-Stack Intern", ["New York, NY"], 6, "https://quillstone.example/jobs/fullstack", ["Simplify"]),
  job("Morrow Health", "Backend Engineering Intern", ["Remote"], 12, "https://morrow.example/jobs/backend-intern", ["SpeedyApply"]),
  job("Tessellate", "Machine Learning Intern", ["San Francisco, CA", "Seattle, WA", "Austin, TX"], 25, "https://tessellate.example/ml-intern", ["Simplify"]),
  job("Brightline Labs", "Software Engineering Intern", ["London, UK"], 40, "https://brightline.example/swe-intern", ["SpeedyApply"], false, false),
  job("Maple Systems", "Backend Developer Intern", ["Toronto, ON, Canada"], 3, "https://maple.example/backend-intern", ["vanshb03"], false, false),
  job("Tessellate", "Research Intern, PhD", ["San Francisco, CA"], 5, "https://tessellate.example/research-phd", ["Simplify", "vanshb03"], false, true, true),
];

const db: Db = {
  runs: new Map(),
  // Two hours old, so opening Jobs refreshes it, as the app does after an hour.
  jobsFetchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  apps: [
    { id: 1, run_id: null, company: "Harbor Analytics", role: "Data Engineering Intern", date: "2026-11-02", status: "interview", notes: "Phone screen Nov 18", url: "" },
    { id: 2, run_id: null, company: "Kestrel Robotics", role: "Software Intern, Autonomy", date: "2026-10-27", status: "applied", notes: "", url: "" },
    { id: 3, run_id: null, company: "Morrow Health", role: "Backend Engineering Intern", date: "2026-10-19", status: "rejected", notes: "Position filled", url: "" },
    { id: 4, run_id: null, company: "Quillstone", role: "Full-Stack Intern", date: "2026-10-12", status: "offer", notes: "Decide by Dec 1", url: "" },
  ],
  facts: [{ id: "f1", text: "Used Redis to cache route lookups at Northwind Logistics", question: null, bullet_text: null, created_at: "2026-11-01T12:00:00Z" }],
  baseline: [
    { id: 1, started_at: "2026-11-04T18:00:00Z", duration_ms: 1_920_000, note: "Harbor Analytics" },
    { id: 2, started_at: "2026-11-06T18:00:00Z", duration_ms: 2_310_000, note: "Kestrel Robotics" },
  ],
  settings: { provider: "demo", "model.demo": "demo", theme: "dark", export_dir: "/Users/jordan/Documents/Resumes" },
  keys: {},
  hasBase: true,
};

const pdfCache: Record<string, ArrayBuffer> = {};
async function pdf(name: "base" | "tailored"): Promise<ArrayBuffer> {
  if (!pdfCache[name]) pdfCache[name] = await (await fetch(`${import.meta.env.BASE_URL}mock/sample-${name}.pdf`)).arrayBuffer();
  return pdfCache[name].slice(0);
}

function emit(ch: unknown, e: StepEvent) {
  emitTo(ch, e);
}

/** The sample resume belongs to Jordan Sample, so its PDFs are named after them. */
function exportName(company: string) {
  const c = company.trim().replace(/[^A-Za-z0-9-]+/g, "_").replace(/^_+|_+$/g, "");
  return c ? `Jordan_Sample_Resume_${c}.pdf` : "Jordan_Sample_Resume.pdf";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const speed = () => Number(new URLSearchParams(location.search).get("speed") ?? "1");

async function streamText(ch: unknown, step: string, text: string) {
  emit(ch, { type: "started", step });
  const chunks = text.match(/[\s\S]{1,48}/g) ?? [];
  for (const c of chunks) {
    emit(ch, { type: "delta", step, text: c });
    await sleep(28 / speed());
  }
  emit(ch, { type: "finished", step });
}

function step(name: string, input: number, output: number, ms: number) {
  return { step: name, usage: { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 }, duration_ms: ms, model: "demo", blocked_claims: name === "rewrite" ? 1 : 0, style_violations: name === "rewrite" ? 1 : 0, cost_usd: 0 };
}

function record(r: RunState): RunRecord {
  return {
    id: r.id,
    created_at: r.created_at,
    company: r.company,
    role: r.role,
    provider: r.provider,
    model: r.model,
    status: r.exported_at_ms ? "exported" : r.error ? "failed" : "running",
    pasted_at_ms: r.pasted_at_ms,
    exported_at_ms: r.exported_at_ms,
    cost_usd: 0,
    score_before: r.final?.before ?? r.score?.ats ?? null,
    score_after: r.final?.after ?? null,
  };
}

function seedHistory() {
  const mk = (id: string, company: string, role: string, daysAgo: number, exported: boolean): RunState => {
    const created = new Date(Date.now() - daysAgo * 86_400_000);
    return {
      id,
      created_at: created.toISOString(),
      company,
      role,
      posting: SAMPLE_POSTING,
      provider: "demo",
      model: "demo",
      pasted_at_ms: created.getTime(),
      exported_at_ms: exported ? created.getTime() + 412_000 : null,
      posting_url: "",
      score: null,
      rewrites: [],
      rewrite_summary: null,
      decisions: {},
      removed: [],
      final: null,
      note_fact_ids: [],
      posting_skills: { required: [], preferred: [], mentioned: [] },
      coverage_before: null,
      coverage_after: null,
      steps: [],
      pages: 1,
      trim_hints: [],
      exported_path: null,
      export_name: "",
      error: null,
    };
  };
  for (const r of [mk("h1", "Harbor Analytics", "Data Engineering Intern", 11, true), mk("h2", "Kestrel Robotics", "Software Intern, Autonomy", 17, true), mk("h3", "Morrow Health", "Backend Engineering Intern", 25, true)]) db.runs.set(r.id, r);
}

function sampleScore(company: string, role: string): ScoreResult {
  return {
    company,
    role,
    ats: 58,
    red_flags: [
      { flag: "A teamwork bullet with no outcome", why: "“Worked with the team on various backend tasks” reads as filler for a platform role.", section: "Experience" },
      { flag: "REST work is buried in a side project", why: "The posting asks for REST APIs twice; yours sits last under TrailMap.", section: "Projects" },
      { flag: "The posting's stack isn't first in Skills", why: "PostgreSQL and Docker are required but come after Git and SQLite.", section: "Technical Skills" },
    ],
  };
}

/** The mock's before and after: four points for each accepted change. */
function sampleFinal(r: RunState): FinalScore {
  const current: Record<string, string> = {};
  for (const x of r.rewrites) if (r.decisions[x.bullet_id]?.state === "accepted") current[x.bullet_id] = x.new_text;
  for (const id of r.removed) current[id] = "";
  const accepted = Object.keys(current).length;
  return { before: 57, after: Math.min(95, 57 + accepted * 4), scored: current };
}

/** A finished sample run, so each step can be opened straight from a URL. */
function seedSampleRun(stage: string) {
  const r: RunState = {
    id: "sample",
    created_at: now(),
    company: "Larkspur Freight",
    role: "Software Engineer Intern, Platform",
    posting: SAMPLE_POSTING,
    provider: "demo",
    model: "demo",
    pasted_at_ms: Date.now() - 95_000,
    exported_at_ms: null,
    posting_url: "https://jobs.larkspur.example/platform-intern",
    score: sampleScore("Larkspur Freight", "Software Engineer Intern, Platform"),
    rewrites: rewrites(),
    rewrite_summary: null,
    decisions: { b2: { state: "accepted", origin: "rewrite" }, b3: { state: "accepted", origin: "rewrite" } },
    removed: [],
    final: null,
    note_fact_ids: [],
    posting_skills: { required: ["Python", "SQL", "PostgreSQL", "Docker", "Git", "REST"], preferred: ["TypeScript", "Node.js", "Kubernetes", "AWS", "Redis"], mentioned: [] },
    coverage_before: coverage(false),
    coverage_after: coverage(true),
    steps: [step("score", 1210, 260, 3100), step("rewrite", 3120, 1240, 14800), step("rewrite_retry", 1410, 220, 3900)],
    pages: 1,
    trim_hints: [],
    exported_path: null,
    export_name: "",
    error: null,
  };
  if (stage === "done") {
    r.final = sampleFinal(r);
    r.steps.push(step("rescore", 3410, 60, 4100));
  }
  db.runs.set(r.id, r);
}

export async function installMock() {
  (window as { __TAILOR_MOCK__?: boolean }).__TAILOR_MOCK__ = true;
  const params = new URLSearchParams(location.search);
  if (params.get("empty") === "1") {
    db.apps = [];
    db.baseline = [];
    db.facts = [];
  } else seedHistory();
  if (params.get("nobase") === "1") db.hasBase = false;
  if (params.get("run") === "sample") seedSampleRun(params.get("step") ?? "rewrite");
  const failStep = params.get("fail"); // e.g. ?fail=bad_key
  const rewriteMode = params.get("rewrite"); // "same": every line comes back unchanged; "fail": the call fails

  const handle = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    const a = (args ?? {}) as Record<string, unknown>;
    const run = (id: unknown) => {
      const r = db.runs.get(String(id));
      if (!r) throw { kind: "not_found", message: "That run no longer exists." };
      return r;
    };
    switch (cmd) {
      case "app_info":
        return { name: "Tailor", version: "0.1.0", data_dir: "~/Library/Application Support/Tailor/private", has_base_resume: db.hasBase, tectonic_path: "/Applications/Tailor.app/Contents/MacOS/tectonic" };
      case "get_settings":
        return ["provider", "model.claude_api", "model.claude_code", "model.codex", "model.gemini", "model.ollama", "model.demo", "effort", "theme", "export_dir", "ollama_host", "path.claude_code", "path.codex"].map((key) => ({ key, value: db.settings[key] ?? null }));
      case "set_setting":
        db.settings[String(a.key)] = String(a.value);
        return null;
      case "key_status":
        return { provider: a.provider, saved: !!db.keys[String(a.provider)], masked: db.keys[String(a.provider)] ? "sk-ant…9f2c" : null };
      case "save_key":
        db.keys[String(a.provider)] = String(a.key);
        return { provider: a.provider, saved: true, masked: "sk-ant…9f2c" };
      case "delete_key":
        delete db.keys[String(a.provider)];
        return null;
      case "ollama_models":
        return [{ name: "llama3.2:3b", size_bytes: 2_000_000_000 }, { name: "qwen2.5:7b", size_bytes: 4_700_000_000 }];
      case "gemini_models":
        if (!db.keys.gemini) throw { kind: "missing_key", message: "No key" };
        return ["gemini-flash-latest", "gemini-3.6-flash"];
      case "compile_base":
        await sleep(300 / speed());
        return { pdf: Array.from(new Uint8Array(await pdf("base"))), pages: 1, duration_ms: 840 };
      case "compile_run": {
        const r = run(a.runId);
        await sleep(300 / speed());
        r.pages = r.removed.length > 99 ? 2 : 1;
        const tailored = Object.values(r.decisions).some((d) => d.state === "accepted");
        return pdf(tailored ? "tailored" : "base");
      }
      case "list_runs":
        return [...db.runs.values()].sort((x, y) => y.created_at.localeCompare(x.created_at)).map(record);
      case "delete_run":
        db.runs.delete(String(a.runId));
        return null;
      case "get_run_state":
        return structuredClone(run(a.runId));
      case "start_run": {
        const id = `run-${Date.now()}`;
        const r: RunState = {
          id,
          created_at: now(),
          company: String(a.company || "") || "Larkspur Freight",
          role: "",
          posting: String(a.posting),
          provider: String(a.provider || "demo"),
          model: String(a.model || "demo"),
          pasted_at_ms: (a.pastedAtMs as number) ?? Date.now(),
          exported_at_ms: null,
          posting_url: String(a.postingUrl ?? ""),
          score: null,
          rewrites: [],
          rewrite_summary: null,
          decisions: {},
          removed: [],
          final: null,
          note_fact_ids: [],
          posting_skills: { required: ["Python", "SQL", "PostgreSQL", "Docker", "Git", "REST"], preferred: ["TypeScript", "Node.js", "Kubernetes", "AWS", "Redis"], mentioned: [] },
          coverage_before: coverage(false),
          coverage_after: coverage(false),
          steps: [],
          pages: null,
          trim_hints: [],
          exported_path: null,
          export_name: "",
          error: null,
        };
        db.runs.set(id, r);
        return structuredClone(r);
      }
      case "run_step": {
        const r = run(a.runId);
        const s = String(a.step);
        if (failStep && s === "score") {
          await sleep(500);
          const msgs: Record<string, string> = {
            bad_key: "The API key was rejected. Check it in Settings.",
            rate_limited: "Rate limited by the provider. Try again in a moment.",
            offline: "Could not reach the provider. Check your connection.",
          };
          r.error = { kind: failStep, message: msgs[failStep] ?? "Failed" };
          throw r.error;
        }
        if (s === "score") {
          await streamText(a.onEvent, s, JSON.stringify({ company: "Larkspur Freight", role: "Software Engineer Intern, Platform", ats_score: 58 }, null, 1).repeat(2));
          r.company = r.company || "Larkspur Freight";
          r.role = r.role || "Software Engineer Intern, Platform";
          r.score = sampleScore(r.company, r.role);
          r.steps.push(step("score", 1210, 260, 3100));
        } else if (s === "rewrite") {
          await streamText(a.onEvent, s, JSON.stringify(rewrites().map((x) => ({ bullet_id: x.bullet_id, new_text: x.new_text })), null, 1));
          if (rewriteMode === "fail") {
            r.error = { kind: "server", message: "The provider is overloaded or returned a server error." };
            throw r.error;
          }
          r.error = null;
          if (rewriteMode === "same") {
            r.rewrites = rewrites().map((x) => ({ ...x, new_text: x.old_text, status: "unchanged", reasons: [], warnings: [], unchanged_reason: "same_text" }));
            r.rewrite_summary = summary(r.rewrites.length, 0, 0, true, "The model returned every line unchanged after a second try that listed the advice, so there is nothing to review.");
            r.decisions = {};
            r.final = null;
            r.steps.push(step("rewrite", 3120, 1240, 14800), step("rewrite_retry", 1410, 220, 3900));
            return structuredClone(r);
          }
          r.rewrites = rewrites();
          // A note that names a skill puts it on the skills line, backed up by the note's fact.
          const skill = db.facts.find((f) => r.note_fact_ids.includes(f.id) && f.text.startsWith("Skills: "));
          if (skill) {
            const named = skill.text.slice("Skills: ".length);
            r.rewrites.push(
              rw("s2", "Technical Skills | Frameworks & Libraries", "Technical Skills", "React, Express, pytest, pandas", `React, ${named}, Express, pytest, pandas`, "ok", {
                why: `Shows ${named} from your note`,
                sources: ["s2", skill.id],
              }),
            );
          }
          // A note that says how many pull requests unblocks b5, the way a fact does in the real checker.
          const prs = db.facts.find((f) => r.note_fact_ids.includes(f.id) && /\d+ pull requests/.test(f.text));
          if (prs) {
            const n = prs.text.match(/(\d+) pull requests/)![1];
            r.rewrites = r.rewrites.map((x) =>
              x.bullet_id === "b5" ? { ...x, new_text: `Reviewed ${n} pull requests and shipped backend features with the routing team`, status: "ok", reasons: [], sources: ["b5", prs.id], grounding: { claims: [{ text: n, kind: "number", supported: true }], citation_errors: [] } } : x,
            );
          }
          r.decisions = {};
          r.final = null;
          // Changes a note asked for: the graduation date one is applied; "my dates" asks which line.
          const items: ItemResult[] = [
            { id: "a1", kind: "advice", text: r.score?.red_flags[0] ? `${r.score.red_flags[0].flag} (${r.score.red_flags[0].section})` : "Vague bullets", status: "applied", lines: ["b5"], why: "Made the teamwork bullet specific" },
            { id: "a2", kind: "advice", text: "No GitHub or portfolio link in the header (Header)", status: "couldnt_act", lines: [], why: 'There\'s no line in "Header" that the rewrite can change, so this needs a change you make yourself or a note that says what to change.' },
          ];
          for (const [i, ask] of (r.note_asks ?? []).entries()) {
            const grad = ask.match(/graduation date to (.+)$/i);
            if (grad) {
              const next = /^\d{4}$/.test(grad[1]) ? `Expected May ${grad[1]}` : grad[1];
              r.rewrites.unshift(rw("h1.3", "Education | State University", "Education", "Expected May 2027", next, "ok", { label: "Graduation date", asked: ask, sources: ["h1.3", "note"], why: "You asked for it" }));
              r.decisions["h1.3"] = { state: "accepted", origin: "note" };
              items.push({ id: `n${i + 1}`, kind: "note", text: ask, status: "applied", lines: ["h1.3"], why: "Changed the graduation date as you asked." });
            } else {
              items.push({ id: `n${i + 1}`, kind: "note", text: ask, status: "ask", lines: ["h1.3", "h2.1", "h3.1"], why: `"${ask}" could mean more than one line. Say which one, and what it should say. It could be: Graduation date (Education | State University): "Expected May 2027"; Dates (Experience | Northwind Logistics): "June 2025 – August 2025"; Dates (Experience | Springfield Public Library): "September 2023 – May 2025".` });
            }
          }
          const changed = r.rewrites.filter((x) => x.status !== "unchanged");
          const blocked = changed.filter((x) => x.status === "blocked");
          r.rewrite_summary = summary(
            r.rewrites.length,
            changed.length - blocked.length,
            blocked.length,
            true,
            [
              blocked.length ? `${blocked.length} rewrite${blocked.length === 1 ? " was" : "s were"} blocked because the sources don't back up every claim. ${blocked[0].reasons[0] ?? ""}`.trim() : "",
              items.some((x) => x.status === "ask") ? "1 note needs you to say which line." : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
          r.rewrite_summary.items = items;
          r.steps.push(step("rewrite", 3120, 1240, 14800), step("rewrite_retry", 1410, 220, 3900));
        } else if (s === "rescore") {
          await streamText(a.onEvent, s, JSON.stringify({ base_ats_score: 57, tailored_ats_score: 69 }).repeat(3));
          r.final = sampleFinal(r);
          r.coverage_after = coverage(Object.values(r.decisions).some((d) => d.state === "accepted"));
          r.steps.push(step("rescore", 3410, 60, 4100));
        }
        return structuredClone(r);
      }
      case "decide": {
        const r = run(a.runId);
        const id = String(a.bulletId);
        const x = r.rewrites.find((y) => y.bullet_id === id);
        if (!x) throw { kind: "not_found", message: "No rewrite for that bullet." };
        const action = String(a.action);
        if (action === "accept") {
          if (x.status === "blocked") throw { kind: "blocked", message: x.reasons.join(" ") };
          r.decisions[id] = { state: "accepted", origin: "rewrite" };
        } else if (action === "reject") r.decisions[id] = { state: "rejected", origin: "rewrite" };
        else if (action === "reset") r.decisions[id] = { state: "pending", origin: "" };
        else if (action === "edit") {
          x.new_text = String(a.text ?? "");
          const bad = /\b\d+\+?\b/.test(x.new_text) && !/\b\d+\b/.test(x.old_text);
          x.status = bad ? "blocked" : "ok";
          x.reasons = bad ? ["A number in your edit is not in the cited sources. Answer the question to add it to your facts bank."] : [];
          r.decisions[id] = { state: bad ? "pending" : "accepted", origin: "rewrite" };
        }
        r.coverage_after = coverage(Object.values(r.decisions).some((d) => d.state === "accepted"));
        return structuredClone(r);
      }
      case "add_note": {
        const r = run(a.runId);
        const raw = String(a.note)
          .split(/\n|(?<=[.!?])\s+/)
          .map((x) => x.replace(/^[-*•\s]+/, "").trim().replace(/\.$/, ""));
        // A sentence that asks for a change is kept on the run, as the backend does; the rewrite applies it.
        const asks = raw.filter((x) => /^(?:please\s+)?(?:change|update|replace|correct|fix|rename)\s/i.test(x));
        r.note_asks = [...(r.note_asks ?? []), ...asks.filter((x) => !(r.note_asks ?? []).includes(x))];
        const pieces = raw
          .filter((x) => !asks.includes(x))
          // "add Node.js to my skills" is saved as the skill it names, as the backend does.
          .map((x) => x.replace(/^(?:please\s+)?(?:add|include|mention|list|show|put)\s+(.+?)(?:\s+to\b.*)?$/i, "Skills: $1"))
          .filter((x) => x.startsWith("Skills: ") || x.split(/\s+/).length >= 3);
        for (const text of pieces) {
          if (db.facts.some((f) => f.text.toLowerCase() === text.toLowerCase())) continue;
          const id = `f${db.facts.length + 1}`;
          db.facts.push({ id, text, question: null, bullet_text: null, created_at: now() });
          r.note_fact_ids.push(id);
        }
        return structuredClone(r);
      }
      case "undo_note": {
        const r = run(a.runId);
        db.facts = db.facts.filter((f) => !r.note_fact_ids.includes(f.id));
        r.note_fact_ids = [];
        r.note_asks = [];
        r.rewrites = r.rewrites.filter((x) => !x.asked);
        return structuredClone(r);
      }
      case "toggle_remove": {
        const r = run(a.runId);
        const id = String(a.bulletId);
        r.removed = r.removed.includes(id) ? r.removed.filter((b) => b !== id) : [...r.removed, id];
        return structuredClone(r);
      }
      case "export_run": {
        const r = run(a.runId);
        await sleep(500 / speed());
        r.exported_at_ms = r.exported_at_ms ?? Date.now();
        r.exported_path = `${a.dir}/${exportName(r.company)}`;
        r.pages = 1;
        if (!db.apps.some((x) => x.run_id === r.id)) db.apps.unshift({ id: Date.now(), run_id: r.id, company: r.company, role: r.role, date: new Date().toISOString().slice(0, 10), status: "tailored", notes: "", url: "" });
        return structuredClone(r);
      }
      case "jobs_open":
      case "jobs_refresh": {
        if (cmd === "jobs_refresh") {
          await sleep(400 / speed());
          db.jobsFetchedAt = new Date().toISOString();
        }
        const view: JobsView = {
          fetched_at: db.jobsFetchedAt,
          errors: {},
          listings: JOBS.map(({ isNew: _isNew, ...x }) => x),
          new_ids: JOBS.filter((x) => x.isNew).map((x) => x.id),
          applied_urls: db.apps.map((x) => x.url).filter(Boolean),
        };
        return structuredClone(view);
      }
      case "job_posting": {
        await sleep(300 / speed());
        const url = String(a.url);
        if (url.includes("myworkdayjobs.com")) return { ok: false, text: "", reason: "The page didn't include the posting's text." };
        return { ok: true, text: SAMPLE_POSTING, reason: "" };
      }
      case "mark_applied": {
        const url = String(a.url);
        const seen = db.apps.find((x) => x.url && x.url === url);
        if (seen) {
          seen.status = "applied";
          return structuredClone(seen);
        }
        const entry: Application = { id: Date.now(), run_id: null, company: String(a.company), role: String(a.role), date: new Date().toISOString().slice(0, 10), status: "applied", notes: "", url };
        db.apps.unshift(entry);
        return structuredClone(entry);
      }
      case "open_url":
        return null;
      case "list_applications":
        return structuredClone(db.apps);
      case "add_application":
        db.apps.unshift({ id: Date.now(), run_id: null, company: String(a.company), role: String(a.role), date: String(a.date), status: a.status as Application["status"], notes: "", url: String(a.url ?? "") });
        return 1;
      case "update_application": {
        const x = a.application as Application;
        db.apps = db.apps.map((y) => (y.id === x.id ? x : y));
        return null;
      }
      case "delete_application":
        db.apps = db.apps.filter((y) => y.id !== a.id);
        return null;
      case "list_facts":
        return structuredClone(db.facts);
      case "save_fact":
        if (a.id) db.facts = db.facts.map((f) => (f.id === a.id ? { ...f, text: String(a.text) } : f));
        else db.facts.push({ id: `f${db.facts.length + 1}`, text: String(a.text), question: null, bullet_text: null, created_at: now() });
        return structuredClone(db.facts);
      case "delete_fact":
        db.facts = db.facts.filter((f) => f.id !== a.id);
        return structuredClone(db.facts);
      case "list_baseline":
        return structuredClone(db.baseline);
      case "add_baseline":
        db.baseline.push({ id: Date.now(), started_at: now(), duration_ms: Number(a.durationMs), note: String(a.note ?? "") });
        return structuredClone(db.baseline);
      case "delete_baseline":
        db.baseline = db.baseline.filter((b) => b.id !== a.id);
        return structuredClone(db.baseline);
      case "import_base_resume":
        db.hasBase = true;
        return null;
      case "base_resume_info":
        return { tex: "", bullets: 11, sections: ["Education", "Experience", "Projects", "Technical Skills"] };
      case "suggest_facts_from_file":
      case "suggest_facts_from_url":
        await streamText(a.onEvent, "suggest_facts", "{}");
        return {
          source: cmd === "suggest_facts_from_url" ? "Jordan Sample" : String(a.name),
          truncated: false,
          suggestions: [
            { text: "TrailMap had 25 contributors on GitHub", quote: "25 contributors", supported: true, reasons: [], duplicate: false, covered_by: null, covered_in: null, covered_text: null },
            { text: "Budget Bot parses CSV exports from 3 banks", quote: "CSV exports from 3 banks", supported: true, reasons: [], duplicate: false, covered_by: "b11", covered_in: "resume", covered_text: "Budget Bot | Python, SQLite. Parsed bank CSV exports from 3 banks into one SQLite schema" },
            { text: "TrailMap has 2,000 monthly users", quote: "TrailMap", supported: false, reasons: ['Number "2,000" is not in the document.'], duplicate: false, covered_by: null, covered_in: null, covered_text: null },
          ],
          pdf_links: cmd === "suggest_facts_from_url" ? [{ url: "https://jordan.example/resume.pdf", label: "Resume (PDF)" }] : [],
        };
      case "change_data_dir":
        return { name: "Tailor", version: "0.1.0", data_dir: String(a.path), has_base_resume: db.hasBase, tectonic_path: "/Applications/Tailor.app/Contents/MacOS/tectonic" };
      case "show_data_dir":
        return null;
      case "pick_program":
        return null;
      case "autofill_profile":
        return {
          format: "tailor-autofill-profile",
          version: 1,
          profile: {
            firstName: "Jordan",
            lastName: "Sample",
            email: "jordan.sample@example.com",
            phone: "555-010-0199",
            linkedin: "https://www.linkedin.com/in/jordan-sample",
            github: "https://github.com/jordan-sample",
            portfolio: "",
            websites: [],
            education: [{ school: "State University", degree: "Bachelor of Science", field: "Computer Science", minor: "Statistics", gpa: "", start: "", end: "2027-05" }],
            work: [{ title: "Software Engineering Intern, Routing Team", company: "Northwind Logistics", location: "Chicago, IL", current: false, start: "2025-06", end: "2025-08", bullets: ["Built a Python service that batches delivery route updates"] }],
            skills: ["Python", "TypeScript", "PostgreSQL"],
          },
          facts: db.facts.map((f) => f.text),
        };
      case "codex_status":
        return { installed: true, signed_in: true, path: "/opt/homebrew/bin/codex", version: "0.169.0", auth_method: "chatgpt" };
      case "claude_code_status":
        return { installed: true, signed_in: true, path: "/Users/you/.local/bin/claude", version: "2.1.325", auth_method: "claude.ai" };
      default:
        throw { kind: "unknown", message: `mock has no handler for ${cmd}` };
    }
  };
  // The real backend adds the export file name to every run it returns; so does the mock.
  installMockBackend(async (cmd, args) => {
    const out = await handle(cmd, args);
    if (out && typeof out === "object" && "decisions" in out && "posting" in out) {
      const r = out as RunState;
      r.export_name = exportName(r.company);
    }
    return out;
  });
}

export const MOCK_POSTING = SAMPLE_POSTING;
