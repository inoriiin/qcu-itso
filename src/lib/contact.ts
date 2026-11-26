export const ITSO_EMAIL = "itso@qcu.edu.ph";

export async function copyItsoEmail(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(ITSO_EMAIL);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = ITSO_EMAIL;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
