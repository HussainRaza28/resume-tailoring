/** The toolbar popup: who the profile is for, and a way to edit it. */
import { loadProfile, loadResume } from "./profile";

const who = document.getElementById("who")!;

async function start(): Promise<void> {
  const [profile, resume] = await Promise.all([loadProfile(), loadResume()]);
  const name = `${profile.firstName} ${profile.lastName}`.trim();
  who.textContent = name ? `${name}${resume ? " · resume attached" : " · no resume yet"}` : "Set up your profile first.";
  document.getElementById("edit")!.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

start();
