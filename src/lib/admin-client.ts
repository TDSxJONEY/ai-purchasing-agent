const STORAGE_KEY = "admin-seed-token";

/** Prompts once per tab for ADMIN_SEED_TOKEN. Never baked into the client bundle. */
export function adminHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};

  let token = sessionStorage.getItem(STORAGE_KEY);
  if (!token) {
    token = window.prompt("Enter ADMIN_SEED_TOKEN") ?? "";
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
  }

  return token ? { "x-admin-token": token } : {};
}

export function clearAdminToken() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(STORAGE_KEY);
}
