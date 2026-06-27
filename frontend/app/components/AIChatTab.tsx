"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { API_BASE } from "../lib/client";
import { getDeviceId } from "../lib/deviceId";
import { GITHUB_REPO_URL } from "../lib/constants";
import type { ChatController } from "../hooks/useChatSessions";

interface AIChatTabProps {
  owner: string;
  repo: string;
  commitSha: string;
  issueNumber: number | undefined;
  fileId: string;
  currentFileId: string;
  chat: ChatController;
}

// Shown (as the assistant reply) when the daily cap is hit — honest + actionable.
const LIMIT_MESSAGE = `**Today's chat limit is reached.** 🙏

I'm a solo student building CodeMap and can't cover unlimited AI costs yet, so there's a daily cap. Two ways to keep going right now:

- **Run it yourself** — use your own Gemini API key. CodeMap is open source: [grab it on GitHub](${GITHUB_REPO_URL})
- **If you can, sponsor the credits** to keep the shared instance alive (details on the repo).

The limit resets within 24 hours. Thanks for understanding 💛`;

// ── Scoped keyframes (only what Tailwind can't express) ───────────────────────

const SCOPED_STYLES = `
@keyframes aichat-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
@keyframes aichat-dots {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
@keyframes aichat-fadein {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes aichat-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
.aichat-dot-1 { animation: aichat-dots 1.4s infinite 0s; }
.aichat-dot-2 { animation: aichat-dots 1.4s infinite 0.2s; }
.aichat-dot-3 { animation: aichat-dots 1.4s infinite 0.4s; }
.aichat-cursor {
  display: inline-block; width: 6px; height: 13px; margin-left: 2px;
  background: #fb7a3c; border-radius: 1px; vertical-align: text-bottom;
  animation: aichat-blink 1s steps(1) infinite;
}
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Collapsible code block ────────────────────────────────────────────────────

function CodeBlock({ children, language }: { children?: React.ReactNode; language: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = typeof children === "string" ? children : "";
  const lineCount = text.split("\n").length;

  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      try { return hljs.highlight(text, { language }).value; } catch (_) {}
    }
    return hljs.highlightAuto(text).value;
  }, [text, language]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="my-2 rounded-lg overflow-hidden transition-colors"
      style={{ border: "1px solid #2c2c35", background: "#101014" }}
    >
      {/* Header — click to expand/collapse */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer select-none transition-colors hover:bg-[#1e1e25]"
        style={{ background: "#17171d", borderBottom: expanded ? "1px solid #2c2c35" : "none" }}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-1.5">
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2"
            className="transition-transform duration-200"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", color: "#484f58" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span className="text-[11px] font-mono" style={{ color: "#8b949e" }}>
            {language || "code"}
          </span>
          <span className="text-[10px]" style={{ color: "#484f58" }}>
            · {lineCount}L
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors hover:text-white"
          style={{ color: "#8b949e" }}
        >
          {copied ? "✓" : "Copy"}
        </button>
      </div>

      {/* Body — collapsible */}
      <div
        className="overflow-hidden transition-all duration-300"
        style={{ maxHeight: expanded ? "350px" : "0px", overflowY: expanded ? "auto" : "hidden" }}
      >
        <pre className="p-3 m-0 text-[11px] leading-relaxed font-mono" style={{ color: "#e6edf3" }}>
          <code
            className={`hljs ${language}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      </div>
    </div>
  );
}

// ── MarkdownCode renderer ─────────────────────────────────────────────────────

function MarkdownCode({ className, children, ...props }: any) {
  const match = /language-(\w+)/.exec(className || "");
  const isInline = !match;
  if (isInline) {
    return (
      <code
        className="text-[12px] px-1 py-0.5 rounded font-mono"
        style={{ background: "rgba(110,118,129,0.2)" }}
        {...props}
      >
        {children}
      </code>
    );
  }
  return <CodeBlock language={match[1]}>{children}</CodeBlock>;
}

// ── Streaming indicator ───────────────────────────────────────────────────────

function StreamingIndicator({ label }: { label: string }) {
  // Shows the REAL backend stage (searching graph → ranking → reading → generating),
  // streamed live over SSE — not a timed guess.
  return (
    <div className="flex justify-start">
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px]"
        style={{
          background: "rgba(251,122,60,0.08)",
          border: "1px solid rgba(251,122,60,0.2)",
          color: "#e6edf3",
        }}
      >
        <span
          key={label}
          className="flex items-center gap-1.5"
          style={{ animation: "aichat-fadein 0.25s ease-out" }}
        >
          <span className="text-[11px]">✨</span>
          <span>{label || "Working…"}</span>
        </span>
        <span className="flex gap-0.5 ml-1">
          <span className="aichat-dot-1 w-1 h-1 rounded-full bg-current inline-block" />
          <span className="aichat-dot-2 w-1 h-1 rounded-full bg-current inline-block" />
          <span className="aichat-dot-3 w-1 h-1 rounded-full bg-current inline-block" />
        </span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AIChatTab({
  owner,
  repo,
  commitSha,
  issueNumber,
  fileId,
  currentFileId,
  chat,
}: AIChatTabProps) {
  const {
    sessions,
    currentSessionId,
    messages,
    setMessages,
    isLoading,
    setIsLoading,
    newChat,
    switchSession,
    deleteSession,
  } = chat;

  const [input, setInput] = useState("");
  const [statusLabel, setStatusLabel] = useState(""); // live backend stage during retrieval
  const [deepThink, setDeepThink] = useState(false);  // flash thinking on = deeper, slower
  const [historyOpen, setHistoryOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileName = fileId.split("/").pop() || fileId;

  const pastSessions = useMemo(
    () => sessions.filter((s) => s.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  );
  const currentTitle = sessions.find((s) => s.id === currentSessionId)?.title || "";

  // ── Smooth typewriter reveal (ChatGPT/Claude-style) ─────────────────────────
  // The full streamed text always lands in `messages` (source of truth, persisted);
  // this only controls how many chars of the actively-streaming message are shown.
  const [displayLen, setDisplayLen] = useState(0);
  const [revealing, setRevealing] = useState(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingRef = useRef(isLoading);
  loadingRef.current = isLoading;
  const rafRef = useRef<number | null>(null);

  const runReveal = useCallback(() => {
    if (rafRef.current != null) return; // already animating
    const animate = () => {
      const msgs = messagesRef.current;
      const last = msgs[msgs.length - 1];
      const target = last && last.role === "assistant" ? last.content.length : 0;
      let done = false;
      setDisplayLen((prev) => {
        if (prev >= target) {
          if (!loadingRef.current) done = true; // stream finished AND caught up
          return prev;
        }
        const step = Math.max(2, Math.ceil((target - prev) / 5));
        return Math.min(target, prev + step);
      });
      if (done) {
        rafRef.current = null;
        setRevealing(false);
        return;
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Auto-scroll on new content / reveal progress
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, displayLen]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setIsLoading(true);
    setRevealing(true);
    setDisplayLen(0);
    setStatusLabel("Understanding your question…");

    try {
      const res = await fetch(`${API_BASE}/issue-map/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-device-id": getDeviceId() },
        body: JSON.stringify({
          owner, repo, commitSha, currentFileId, issueNumber,
          thinking: deepThink,
          messages: [...messages, { role: "user", content: userMsg }],
        }),
      });

      // Rate limit (returned as JSON before the stream starts)
      if (res.status === 429) {
        await res.json().catch(() => ({}));
        setRevealing(false);
        setMessages((prev) => [...prev, { role: "assistant", content: LIMIT_MESSAGE }]);
        return;
      }

      if (!res.ok || !res.body) throw new Error("Failed to chat");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let buffer = "";
      let assistantStarted = false; // create the bubble only when the first token lands

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") continue;
            let evt: { type?: string; label?: string; text?: string };
            try { evt = JSON.parse(dataStr); } catch { continue; }

            if (evt.type === "status") {
              setStatusLabel(typeof evt.label === "string" ? evt.label : "");
            } else if (evt.type === "token" && typeof evt.text === "string") {
              const text = evt.text;
              if (!assistantStarted) {
                assistantStarted = true;
                setMessages((prev) => [...prev, { role: "assistant", content: text }]);
                runReveal();
              } else {
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last && last.role === "assistant") {
                    return [...prev.slice(0, -1), { ...last, content: last.content + text }];
                  }
                  return prev;
                });
              }
            }
          }
        }
      }

      // Stream ended with no tokens (e.g. empty answer) — don't hang in "revealing".
      if (!assistantStarted) {
        setRevealing(false);
        setMessages((prev) => [...prev, { role: "assistant", content: "_(No response was generated.)_" }]);
      }
    } catch (err) {
      console.error(err);
      setRevealing(false);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, an error occurred." },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, messages, owner, repo, commitSha, currentFileId, issueNumber, deepThink, setMessages, setIsLoading, runReveal]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "#101014" }}>
      {/* Scoped keyframes */}
      <style dangerouslySetInnerHTML={{ __html: SCOPED_STYLES }} />

      {/* ── Session bar: Previous chats · title · New chat ──────────── */}
      <div
        className="shrink-0 flex items-center gap-2 px-2.5 py-2 relative"
        style={{ borderBottom: "1px solid #23232a", background: "#17171d" }}
      >
        {/* Previous chats */}
        <div className="relative">
          <button
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors hover:bg-[#23232a]"
            style={{ color: historyOpen ? "#e6edf3" : "#8b949e", border: "1px solid #2c2c35" }}
            title="Previous chats"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l3 2" />
            </svg>
            Chats
            {pastSessions.length > 0 && (
              <span className="text-[9px] px-1 rounded-full" style={{ background: "rgba(139,148,158,0.2)", color: "#c9d1d9" }}>
                {pastSessions.length}
              </span>
            )}
          </button>

          {historyOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setHistoryOpen(false)} />
              <div
                className="absolute left-0 top-full mt-1 z-50 w-72 rounded-lg shadow-2xl overflow-hidden"
                style={{ background: "#101014", border: "1px solid #2c2c35" }}
              >
                <div className="px-3 py-2 text-[10px] uppercase tracking-wider" style={{ color: "#8b949e", borderBottom: "1px solid #23232a" }}>
                  Previous chats · this repo
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {pastSessions.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[12px]" style={{ color: "#484f58" }}>
                      No saved chats yet.
                    </div>
                  ) : (
                    pastSessions.map((s) => (
                      <div
                        key={s.id}
                        className="group flex items-center gap-1 px-2 py-2 transition-colors hover:bg-[#17171d]"
                        style={{ background: s.id === currentSessionId ? "#17171d" : "transparent" }}
                      >
                        <button
                          onClick={() => { switchSession(s.id); setHistoryOpen(false); }}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div className="text-[12px] truncate" style={{ color: "#e6edf3" }}>
                            {s.title || "Untitled chat"}
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: "#6e7681" }}>
                            {relativeTime(s.updatedAt)} · {s.messages.length} message{s.messages.length === 1 ? "" : "s"}
                          </div>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                          className="shrink-0 w-6 h-6 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[rgba(248,81,73,0.15)]"
                          title="Delete chat"
                          style={{ color: "#8b949e" }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Current title */}
        <span className="flex-1 truncate text-center text-[11px]" style={{ color: "#8b949e" }}>
          {currentTitle || "New chat"}
        </span>

        {/* New chat */}
        <button
          onClick={() => { newChat(); setHistoryOpen(false); }}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors hover:opacity-90"
          style={{ color: "#fff", background: "rgba(251,122,60,0.9)" }}
          title="Start a new chat"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New
        </button>
      </div>

      {/* ── Messages ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Empty state */}
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center text-center py-8">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
              style={{ background: "linear-gradient(135deg, rgba(251,122,60,0.15), rgba(236,72,153,0.15))", border: "1px solid rgba(251,122,60,0.2)" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fd9a63" strokeWidth="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium mb-1" style={{ color: "#e6edf3" }}>
              Ask about <span style={{ color: "#fd9a63" }}>{fileName}</span>
            </p>
            <p className="text-xs mb-4" style={{ color: "#484f58" }}>
              Context includes this file and the related issue.
            </p>

            {/* Quick suggestion chips */}
            <div className="flex flex-col gap-1.5 w-full">
              {["What does this file do?", "How to fix the issue?", "Side effects?"].map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                  className="text-[11px] px-2.5 py-1.5 rounded-lg text-left transition-all hover:bg-[#1e1e25] hover:border-[#484f58]"
                  style={{ color: "#8b949e", border: "1px solid #2c2c35", background: "#17171d" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg, idx) => {
          const isLast = idx === messages.length - 1;
          const isStreamingThis = isLast && msg.role === "assistant" && revealing;
          const shown = isStreamingThis ? msg.content.slice(0, displayLen) : msg.content;
          const showCursor = isStreamingThis && displayLen < msg.content.length;
          return (
            <div
              key={idx}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              style={{ animation: "aichat-fadein 0.2s ease-out" }}
            >
              {msg.role === "user" ? (
                /* User bubble */
                <div
                  className="max-w-[88%] rounded-xl rounded-br-sm px-3 py-2 text-[13px]"
                  style={{
                    background: "rgba(251,122,60,0.1)",
                    border: "1px solid rgba(251,122,60,0.2)",
                    color: "#e6edf3",
                  }}
                >
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              ) : (
                /* Assistant bubble */
                <div
                  className="max-w-[95%] rounded-xl rounded-bl-sm px-3 py-2.5 text-[13px]"
                  style={{
                    background: "#17171d",
                    border: "1px solid #23232a",
                    color: "#e6edf3",
                  }}
                >
                  <div
                    className="chat-prose"
                    style={{ maxWidth: "100%", overflowX: "hidden", wordBreak: "break-word", overflowWrap: "anywhere" }}
                  >
                    <ReactMarkdown components={{ code: MarkdownCode }}>
                      {shown.replace(/\\n/g, "\n")}
                    </ReactMarkdown>
                    {showCursor && <span className="aichat-cursor" />}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Streaming indicator — shows the real backend stage until tokens arrive */}
        {isLoading && (messages.length === 0 || messages[messages.length - 1]?.role === "user" ||
          (messages[messages.length - 1]?.role === "assistant" && messages[messages.length - 1]?.content === "")) && (
          <StreamingIndicator label={statusLabel} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input ────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-2.5" style={{ borderTop: "1px solid #23232a", background: "#17171d" }}>
        <form onSubmit={handleSubmit}>
          <div
            className="flex items-end gap-2 rounded-lg px-3 py-2 transition-all"
            style={{ background: "#101014", border: "1px solid #2c2c35" }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Ask about ${fileName}…`}
              disabled={isLoading}
              rows={1}
              className="flex-1 bg-transparent text-[13px] text-white resize-none outline-none disabled:opacity-50 placeholder:text-[#484f58]"
              style={{ maxHeight: "120px", lineHeight: "1.4" }}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-all disabled:opacity-30"
              style={{ background: input.trim() ? "#fb7a3c" : "#23232a", color: "#fff" }}
            >
              {isLoading ? (
                <span
                  className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin"
                  style={{ borderColor: "#fff", borderTopColor: "transparent" }}
                />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              )}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-0.5">
            <button
              type="button"
              onClick={() => setDeepThink((v) => !v)}
              title={deepThink
                ? "Deep: the model thinks longer for complex questions (slower)"
                : "Fast: quick answers (recommended for most questions)"}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md transition-colors"
              style={{
                color: deepThink ? "#fb7a3c" : "#8b949e",
                background: deepThink ? "rgba(251,122,60,0.12)" : "transparent",
                border: `1px solid ${deepThink ? "rgba(251,122,60,0.35)" : "#2c2c35"}`,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 .9 1 1.8v.5h6v-.5c0-.9.4-1.3 1-1.8A7 7 0 0 0 12 2Z" />
              </svg>
              {deepThink ? "Deep" : "Fast"}
            </button>
            <span className="text-[9px]" style={{ color: "#484f58" }}>
              ↵ send · ⇧↵ newline · on-device history
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
