/** The profile page: load the saved profile, show it, save it, and keep the resume PDF. */
import { type Settings, loadSettings, saveSettings } from "./settings";
import { loadProfile, loadResume, removeResume, saveProfile, saveResume, type StoredResume } from "./profile";
import { changes, mergeImport, parseTailorExport } from "./importTailor";
import { readForm, renderForm } from "./profileForm";
import { applyTheme, themeButton } from "./theme";
import { mountWake } from "./wake";

applyTheme();
mountWake(document.getElementById("wake") as HTMLCanvasElement);
themeButton(document.getElementById("theme") as HTMLButtonElement);

const form = document.getElementById("profile") as HTMLFormElement;
const saved = document.getElementById("saved")!;
const resumeStatus = document.getElementById("resume-status")!;
const resumeInput = document.getElementById("resume-file") as HTMLInputElement;
const resumeRemove = document.getElementById("resume-remove") as HTMLButtonElement;

function showResume(resume: StoredResume | null): void {
  resumeStatus.textContent = resume ? `${resume.name} · ${Math.round(resume.size / 1024)} KB` : "No resume yet.";
  resumeRemove.hidden = !resume;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });
}

/** The Autofill settings: each checkbox saves as soon as it changes. */
async function showSettings(): Promise<void> {
  const settings = await loadSettings();
  const saved = document.getElementById("settings-saved")!;
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    const box = document.getElementById(`setting-${key}`) as HTMLInputElement | null;
    if (!box) continue;
    box.checked = settings[key];
    box.addEventListener("change", async () => {
      settings[key] = box.checked;
      await saveSettings(settings);
      saved.textContent = "Saved";
    });
  }
}

async function start(): Promise<void> {
  showSettings();
  let profile = await loadProfile();
  renderForm(form, profile);
  showResume(await loadResume());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    profile = readForm(form, profile);
    await saveProfile(profile);
    saved.textContent = "Saved";
    setTimeout(() => (saved.textContent = ""), 2000);
  });

  resumeInput.addEventListener("change", async () => {
    const file = resumeInput.files?.[0];
    if (!file) return;
    try {
      const resume = { name: file.name, type: file.type || "application/pdf", size: file.size, dataUrl: await readAsDataUrl(file) };
      await saveResume(resume);
      showResume(resume);
    } catch (e) {
      resumeStatus.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      resumeInput.value = "";
    }
  });

  // Import from Tailor: pick the exported file, preview what changes, apply.
  const importInput = document.getElementById("import-file") as HTMLInputElement;
  const dialog = document.getElementById("import-dialog") as HTMLDialogElement;
  const summary = document.getElementById("import-summary")!;
  const list = document.getElementById("import-changes")!;
  const apply = document.getElementById("import-apply") as HTMLButtonElement;
  let pending: typeof profile | null = null;
  document.getElementById("import")!.addEventListener("click", () => importInput.click());
  document.getElementById("import-cancel")!.addEventListener("click", () => dialog.close());
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    list.replaceChildren();
    try {
      const current = readForm(form, profile);
      const merged = mergeImport(current, parseTailorExport(await file.text()));
      const found = changes(current, merged);
      pending = merged;
      summary.textContent = found.length
        ? `${found.length} change${found.length === 1 ? "" : "s"} from ${file.name}. Your address, answers and self-identification stay as they are.`
        : "Nothing new in that file: the profile already matches it.";
      for (const c of found) {
        const row = document.createElement("div");
        row.className = "change";
        const label = Object.assign(document.createElement("strong"), { textContent: c.label });
        const values = document.createElement("div");
        if (c.was) values.append(Object.assign(document.createElement("div"), { className: "was", textContent: c.was }));
        values.append(Object.assign(document.createElement("div"), { className: "now", textContent: c.now }));
        row.append(label, values);
        list.append(row);
      }
      list.hidden = !found.length;
      apply.disabled = !found.length;
    } catch (e) {
      pending = null;
      summary.textContent = e instanceof Error ? e.message : String(e);
      list.hidden = true;
      apply.disabled = true;
    }
    dialog.showModal();
  });
  apply.addEventListener("click", async () => {
    if (!pending) return;
    profile = pending;
    pending = null;
    renderForm(form, profile);
    await saveProfile(profile);
    dialog.close();
    saved.textContent = "Imported and saved";
    setTimeout(() => (saved.textContent = ""), 2500);
  });

  resumeRemove.addEventListener("click", async () => {
    await removeResume();
    showResume(null);
  });
}

start();
