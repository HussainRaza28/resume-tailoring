/** The profile page: load the saved profile, show it, save it, and keep the resume PDF. */
import { loadProfile, loadResume, removeResume, saveProfile, saveResume, type StoredResume } from "./profile";
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

async function start(): Promise<void> {
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

  resumeRemove.addEventListener("click", async () => {
    await removeResume();
    showResume(null);
  });
}

start();
