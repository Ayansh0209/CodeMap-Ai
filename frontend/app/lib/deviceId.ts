// A stable, random per-browser id used to (a) scope on-device chat history and
// (b) give the backend rate limiter a per-device bucket via the `x-device-id`
// header. It is NOT auth — it's a casual-abuse deterrent that the IP-based limit
// backstops. Clearing site data resets it (acceptable for our purposes).

const KEY = "codemap-device-id";

export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `dev-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Storage blocked (private mode / disabled) — fall back to an ephemeral id.
    return "";
  }
}
