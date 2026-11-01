export type InstallPromptResult = { outcome?: "accepted" | "dismissed" };

export type DeferredInstallPrompt = Event & {
  prompt: () => Promise<InstallPromptResult | void>;
  userChoice?: Promise<InstallPromptResult>;
};

let deferredInstallPrompt: DeferredInstallPrompt | null = null;
const listeners = new Set<(prompt: DeferredInstallPrompt) => void>();

// This module is loaded by the app entry point, so the browser's one-shot
// install event is captured even while the account panel is still lazy-loaded.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    const prompt = event as DeferredInstallPrompt;
    if (typeof prompt.prompt !== "function") return;
    event.preventDefault();
    deferredInstallPrompt = prompt;
    listeners.forEach((listener) => listener(prompt));
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    listeners.clear();
  });
}

export function getDeferredInstallPrompt() {
  return deferredInstallPrompt;
}

export function subscribeToInstallPrompt(listener: (prompt: DeferredInstallPrompt) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearDeferredInstallPrompt(prompt?: DeferredInstallPrompt) {
  if (!prompt || deferredInstallPrompt === prompt) deferredInstallPrompt = null;
}
