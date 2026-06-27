// On-device chat history. Sessions live in localStorage, keyed by repo, and
// never leave the browser — so there is no server-side store to leak between
// users or to attack. "New chat" / "Previous chats" is just managing this list.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSession {
  id: string;
  repo: string; // "owner/repo"
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

const keyFor = (repo: string) => `codemap-chats:${repo}`;
const MAX_SESSIONS = 50; // cap stored history so localStorage can't grow unbounded

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `sess-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function makeSession(repo: string): ChatSession {
  const now = Date.now();
  return { id: newId(), repo, title: "", messages: [], createdAt: now, updatedAt: now };
}

/** Derive a short title from the first user message. */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  const t = first.content.trim().replace(/\s+/g, " ");
  return t.length > 48 ? t.slice(0, 47) + "…" : t;
}

export function loadSessions(repo: string): ChatSession[] {
  if (typeof window === "undefined" || !repo) return [];
  try {
    const raw = localStorage.getItem(keyFor(repo));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as ChatSession[])
      .filter((s) => s && typeof s.id === "string" && Array.isArray(s.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveSessions(repo: string, sessions: ChatSession[]): void {
  if (typeof window === "undefined" || !repo) return;
  try {
    // Keep only sessions that have content, newest first, capped.
    const trimmed = sessions
      .filter((s) => s.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    localStorage.setItem(keyFor(repo), JSON.stringify(trimmed));
  } catch {
    // Quota exceeded or storage blocked — history just won't persist this round.
  }
}
