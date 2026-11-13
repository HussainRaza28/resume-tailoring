/** Typed calls into the Python backend. Types mirror the Pydantic models in app/. */

import { base64ToBytes, call, openChannel } from "./ipc";

export type ProviderId = "claude_api" | "claude_code" | "gemini" | "ollama" | "demo";
export type CheckStatus = "ok" | "blocked" | "unchanged";
export type DecisionState = "pending" | "accepted" | "rejected";
export type AppStatus = "tailored" | "applied" | "interview" | "offer" | "rejected";
export const APP_STATUSES: AppStatus[] = ["tailored", "applied", "interview", "offer", "rejected"];

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface RedFlag {
  flag: string;
  why: string;
  section: string;
}

export interface Claim {
  text: string;
  kind: "number" | "proper_noun" | "skill";
  supported: boolean;
}

export interface Violation {
  rule: string;
  excerpt: string;
  message: string;
}

export interface CheckedRewrite {
  bullet_id: string;
  entry: string;
  section: string;
  old_text: string;
  new_text: string;
  sources: string[];
  question: string | null;
  why: string;
  status: CheckStatus;
  grounding: { claims: Claim[]; citation_errors: string[] };
  style: Violation[];
  reasons: string[];
}

export interface SkippedSection {
  section: string;
  reason: string;
  rewrites: CheckedRewrite[];
}

export interface Review {
  score: number;
  verdict: string;
  skipped_sections: SkippedSection[];
}

export interface SkillStatus {
  skill: string;
  tier: "required" | "preferred" | "mentioned";
  covered: boolean;
  have: boolean;
  addable: boolean;
  evidence: string | null;
}

export interface Coverage {
  skills: SkillStatus[];
  required_total: number;
  required_have: number;
  required_covered: number;
  preferred_total: number;
  preferred_have: number;
  preferred_covered: number;
}

export interface StepRecord {
  step: string;
  usage: Usage;
  duration_ms: number;
  model: string;
  blocked_claims: number;
  style_violations: number;
  cost_usd: number | null;
}

export interface TrimHint {
  bullet_id: string;
  text: string;
  lines: number;
  cut_chars: number;
}

export interface RunState {
  id: string;
  created_at: string;
  company: string;
  role: string;
  posting: string;
  provider: string;
  model: string;
  pasted_at_ms: number | null;
  exported_at_ms: number | null;
  red_flags: { company: string; role: string; red_flags: RedFlag[] } | null;
  rewrites: CheckedRewrite[];
  decisions: Record<string, { state: DecisionState; origin: string }>;
  removed: string[];
  review_before: Review | null;
  review_after: Review | null;
  posting_skills: { required: string[]; preferred: string[]; mentioned: string[] };
  coverage_before: Coverage | null;
  coverage_after: Coverage | null;
  steps: StepRecord[];
  pages: number | null;
  trim_hints: TrimHint[];
  exported_path: string | null;
  /** File name the PDF is saved under, from the resume's name and the company. */
  export_name: string;
  error: { kind: string; message: string } | null;
}

export interface RunRecord {
  id: string;
  created_at: string;
  company: string;
  role: string;
  provider: string;
  model: string;
  status: string;
  pasted_at_ms: number | null;
  exported_at_ms: number | null;
  cost_usd: number;
  score_before: number | null;
  score_after: number | null;
}

export interface Application {
  id: number;
  run_id: string | null;
  company: string;
  role: string;
  date: string;
  status: AppStatus;
  notes: string;
}

export interface Fact {
  id: string;
  text: string;
  question: string | null;
  bullet_text: string | null;
  created_at: string;
}

export interface BaselineEntry {
  id: number;
  started_at: string;
  duration_ms: number;
  note: string;
}

export interface KeyStatus {
  provider: string;
  saved: boolean;
  masked: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  data_dir: string;
  has_base_resume: boolean;
  tectonic_path: string | null;
}

export interface OllamaModel {
  name: string;
  size_bytes: number;
}

export type StepEvent =
  | { type: "started"; step: string }
  | { type: "delta"; step: string; text: string }
  | { type: "finished"; step: string };

export type Settings = Partial<
  Record<
    | "provider"
    | "model.claude_api"
    | "model.claude_code"
    | "model.gemini"
    | "model.ollama"
    | "model.demo"
    | "effort"
    | "theme"
    | "export_dir"
    | "ollama_host",
    string
  >
>;

export interface ClaudeCodeStatus {
  installed: boolean;
  signed_in: boolean;
  path: string | null;
  version: string | null;
  auth_method: string | null;
}

/** Run a command that streams step events, closing its channel when it ends. */
async function streaming<T>(command: string, args: Record<string, unknown>, onEvent?: (e: StepEvent) => void): Promise<T> {
  const channel = openChannel<StepEvent>(onEvent);
  try {
    return await call<T>(command, { ...args, onEvent: channel.id });
  } finally {
    channel.close();
  }
}

/** PDFs come back base64-encoded; the mock backend may hand over raw bytes. */
function toBytes(r: unknown): Uint8Array {
  if (typeof r === "string") return base64ToBytes(r);
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (r instanceof Uint8Array) return r;
  throw { kind: "bad_pdf", message: "The PDF came back in an unexpected format." };
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  changeDataDir: (path: string) => call<AppInfo>("change_data_dir", { path }),
  showDataDir: () => call<void>("show_data_dir"),
  importBaseResume: (path: string) => call<void>("import_base_resume", { path }),
  compileBase: async () => {
    const r = await call<{ pdf: string; pages: number; duration_ms: number }>("compile_base");
    return { ...r, pdf: toBytes(r.pdf) };
  },
  baseResumeInfo: () => call<{ tex: string; bullets: number; sections: string[] }>("base_resume_info"),

  keyStatus: (provider: string) => call<KeyStatus>("key_status", { provider }),
  saveKey: (provider: string, key: string) => call<KeyStatus>("save_key", { provider, key }),
  deleteKey: (provider: string) => call<void>("delete_key", { provider }),
  ollamaModels: () => call<OllamaModel[]>("ollama_models"),
  geminiModels: () => call<string[]>("gemini_models"),
  claudeCodeStatus: () => call<ClaudeCodeStatus>("claude_code_status"),

  startRun: (posting: string, company: string, provider: string | null, model: string | null, pastedAtMs: number | null) =>
    call<RunState>("start_run", { posting, company, provider, model, pastedAtMs }),
  getRun: (runId: string) => call<RunState>("get_run_state", { runId }),
  updateRunMeta: (runId: string, company: string, role: string) => call<RunState>("update_run_meta", { runId, company, role }),
  runStep: (runId: string, step: "red_flags" | "rewrite" | "review", onEvent?: (e: StepEvent) => void) =>
    streaming<RunState>("run_step", { runId, step }, onEvent),
  decide: (runId: string, bulletId: string, action: "accept" | "reject" | "reset" | "edit", text?: string) =>
    call<RunState>("decide", { runId, bulletId, action, text: text ?? null }),
  toggleRemove: (runId: string, bulletId: string) => call<RunState>("toggle_remove", { runId, bulletId }),
  acceptSuggestion: (runId: string, section: number, bulletId: string) =>
    call<RunState>("accept_suggestion", { runId, section, bulletId }),
  answerQuestion: (runId: string, bulletId: string, answer: string, onEvent?: (e: StepEvent) => void) =>
    streaming<RunState>("answer_question", { runId, bulletId, answer }, onEvent),
  compileRun: async (runId: string) => toBytes(await call<unknown>("compile_run", { runId })),
  exportRun: (runId: string, dir: string) => call<RunState>("export_run", { runId, dir }),
  tailoredSource: (runId: string) => call<string>("tailored_source", { runId }),

  listRuns: () => call<RunRecord[]>("list_runs"),
  deleteRun: (runId: string) => call<void>("delete_run", { runId }),
  listApplications: () => call<Application[]>("list_applications"),
  addApplication: (company: string, role: string, date: string, status: AppStatus) =>
    call<number>("add_application", { company, role, date, status }),
  updateApplication: (application: Application) => call<void>("update_application", { application }),
  deleteApplication: (id: number) => call<void>("delete_application", { id }),

  listFacts: () => call<Fact[]>("list_facts"),
  saveFact: (id: string | null, text: string) => call<Fact[]>("save_fact", { id, text }),
  deleteFact: (id: string) => call<Fact[]>("delete_fact", { id }),

  listBaseline: () => call<BaselineEntry[]>("list_baseline"),
  addBaseline: (durationMs: number, note: string) => call<BaselineEntry[]>("add_baseline", { durationMs, note }),
  deleteBaseline: (id: number) => call<BaselineEntry[]>("delete_baseline", { id }),

  getSettings: async (): Promise<Settings> => {
    const pairs = await call<{ key: string; value: string | null }[]>("get_settings");
    const out: Settings = {};
    for (const p of pairs) if (p.value != null) out[p.key as keyof Settings] = p.value;
    return out;
  },
  setSetting: (key: keyof Settings, value: string) => call<void>("set_setting", { key, value }),
};

/** Display names for providers and models. */
export function providerLabel(p: string): string {
  const names: Record<string, string> = {
    claude_api: "Claude API",
    claude_code: "Claude Code (Pro plan)",
    gemini: "Gemini",
    ollama: "Ollama",
    demo: "Demo",
  };
  return names[p] ?? p;
}

export function modelLabel(m: string): string {
  const known: Record<string, string> = {
    "claude-sonnet-5-5": "Sonnet 5.5",
    "claude-opus-5-5": "Opus 5.5",
    demo: "Offline demo",
    sonnet: "Sonnet (latest)",
    opus: "Opus (latest)",
    "gemini-flash-latest": "Flash (latest)",
  };
  return known[m] ?? m;
}

/** Accepted text per bullet, the same rule as RunState.accepted() in app/bridge.py. */
export function acceptedTexts(run: RunState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of run.rewrites) if (run.decisions[r.bullet_id]?.state === "accepted") out[r.bullet_id] = r.new_text;
  return out;
}

export function runTotals(run: RunState) {
  const usage = run.steps.reduce(
    (u, s) => ({
      input: u.input + s.usage.input_tokens + s.usage.cache_read_tokens + s.usage.cache_write_tokens,
      output: u.output + s.usage.output_tokens,
      cached: u.cached + s.usage.cache_read_tokens,
    }),
    { input: 0, output: 0, cached: 0 },
  );
  const cost = run.steps.some((s) => s.cost_usd == null) && run.steps.length ? null : run.steps.reduce((c, s) => c + (s.cost_usd ?? 0), 0);
  const ms = run.steps.reduce((t, s) => t + s.duration_ms, 0);
  return { ...usage, cost, ms };
}
