export function readStoredValue(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function writeStoredValue(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
}

export function removeStoredValue(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* Preferences are optional. */ }
}

export function createRecordId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
