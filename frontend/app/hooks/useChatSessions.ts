import { useState, useEffect, useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  type ChatMessage,
  type ChatSession,
  loadSessions,
  saveSessions,
  makeSession,
  deriveTitle,
} from "../lib/chatStore";

export interface ChatController {
  sessions: ChatSession[];
  currentSessionId: string;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  isLoading: boolean;
  setIsLoading: (v: boolean) => void;
  newChat: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
}

/**
 * Owns the chat sessions for one repo, backed by on-device localStorage.
 * Lives in the page (not the chat tab) so an in-flight stream survives the user
 * switching to the Info/Code tab and back.
 */
export function useChatSessions(repo: string): ChatController {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const loadedRepoRef = useRef<string>("");

  // Load (once) when a real "owner/repo" becomes available.
  useEffect(() => {
    if (!repo || repo.startsWith("/") || repo.endsWith("/")) return;
    if (loadedRepoRef.current === repo) return;
    loadedRepoRef.current = repo;

    const loaded = loadSessions(repo);
    if (loaded.length > 0) {
      setSessions(loaded);
      setCurrentSessionId(loaded[0].id);
    } else {
      const s = makeSession(repo);
      setSessions([s]);
      setCurrentSessionId(s.id);
    }
  }, [repo]);

  // Persist (debounced) so per-chunk streaming updates don't hammer localStorage.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!repo || sessions.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveSessions(repo, sessions), 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [repo, sessions]);

  const messages = sessions.find((s) => s.id === currentSessionId)?.messages ?? [];

  const setMessages: Dispatch<SetStateAction<ChatMessage[]>> = useCallback(
    (updater) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== currentSessionId) return s;
          const next =
            typeof updater === "function"
              ? (updater as (m: ChatMessage[]) => ChatMessage[])(s.messages)
              : updater;
          return { ...s, messages: next, title: s.title || deriveTitle(next), updatedAt: Date.now() };
        })
      );
    },
    [currentSessionId]
  );

  const newChat = useCallback(() => {
    const cur = sessions.find((s) => s.id === currentSessionId);
    if (cur && cur.messages.length === 0) return; // already on a blank chat
    const s = makeSession(repo);
    setSessions((prev) => [s, ...prev]);
    setCurrentSessionId(s.id);
  }, [repo, sessions, currentSessionId]);

  const switchSession = useCallback((id: string) => {
    setCurrentSessionId(id);
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
      const remaining = sessions.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const s = makeSession(repo);
        setSessions([s]);
        setCurrentSessionId(s.id);
        saveSessions(repo, []); // clear persisted copy immediately
        return;
      }
      setSessions(remaining);
      if (id === currentSessionId) setCurrentSessionId(remaining[0].id);
      saveSessions(repo, remaining);
    },
    [repo, sessions, currentSessionId]
  );

  return {
    sessions,
    currentSessionId,
    messages,
    setMessages,
    isLoading,
    setIsLoading,
    newChat,
    switchSession,
    deleteSession,
  };
}
