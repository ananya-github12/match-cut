"use client";
/**
 * AI Chat panel with Match Cut's entry points (PRD "Platforms and entry points"):
 * 1. Pasting a YouTube link shows "Match this video's style?" with Match and Dismiss.
 *    Nothing starts until the user picks Match.
 * 2. "Match a reference" in the input area, and the /match slash command.
 * 3. A request like "make it look like this video" plus a link: the Director calls the tool.
 * 4. A deep link (/match?url=…) opens the input panel prefilled.
 * Cardboard's Director is a stub here: it acknowledges prompts sent to it and edits nothing.
 */
import { parseYouTubeSource } from "@match-cut/core/youtube-url";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EntryPoint } from "../../lib/analytics";
import { activeBriefKey, store, type Project } from "../../lib/project";
import { S } from "../../lib/strings";
import css from "./editor.module.css";

// PRD performance: Match Cut code loads only when an entry point is used.
const MatchSession = dynamic(() => import("../match/MatchSession").then((m) => m.MatchSession), {
  ssr: false,
  loading: () => <div className={css.loading}>Loading Match Cut…</div>,
});

type Message =
  | { id: string; kind: "text"; role: "user" | "director"; text: string }
  | { id: string; kind: "paste-card"; url: string }
  | {
      id: string;
      kind: "match";
      entry: EntryPoint;
      url?: string;
      goal?: string;
      autoStart?: boolean;
      resumeBriefId?: string;
    };

const LINK_RE = /(https?:\/\/\S+|(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/\S+)/i;
const STYLE_REQUEST = /\b(look|feel|style|match|like this|same vibe)\b/i;
let seq = 0;
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

export function ChatPanel({ project, deepLinkUrl }: { project: Project; deepLinkUrl?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const add = useCallback((...m: Message[]) => setMessages((prev) => [...prev, ...m]), []);
  const remove = useCallback(
    (id: string) => setMessages((prev) => prev.filter((m) => m.id !== id)),
    [],
  );
  const replace = useCallback(
    (id: string, m: Message) => setMessages((prev) => prev.map((x) => (x.id === id ? m : x))),
    [],
  );

  // On load: resume the active brief for this project (PRD), or open the deep link.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const active = store.get(activeBriefKey(project.id));
    const initial: Message[] = [];
    if (active)
      initial.push({ id: nextId(), kind: "match", entry: "chat_action", resumeBriefId: active });
    if (deepLinkUrl !== undefined) {
      initial.push({ id: nextId(), kind: "match", entry: "deep_link", url: deepLinkUrl });
    }
    if (initial.length) setMessages(initial);
  }, [project.id, deepLinkUrl]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const openMatch = (entry: EntryPoint, url?: string) =>
    add({ id: nextId(), kind: "match", entry, url });

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (/^\/match\b/i.test(text)) {
      const arg = text.replace(/^\/match\s*/i, "").trim();
      openMatch("slash_command", arg || undefined);
      return;
    }
    const link = LINK_RE.exec(text)?.[0];
    const parsed = link ? parseYouTubeSource(link) : null;
    if (link && parsed?.ok && text === link) {
      add(
        { id: nextId(), kind: "text", role: "user", text },
        { id: nextId(), kind: "paste-card", url: link },
      );
      return;
    }
    if (link && parsed?.ok && STYLE_REQUEST.test(text)) {
      const goal = text.replace(link, "").replace(/\s+/g, " ").trim();
      add(
        { id: nextId(), kind: "text", role: "user", text },
        { id: nextId(), kind: "text", role: "director", text: S.directorStudying },
        { id: nextId(), kind: "match", entry: "director", url: link, goal, autoStart: true },
      );
      return;
    }
    add(
      { id: nextId(), kind: "text", role: "user", text },
      { id: nextId(), kind: "text", role: "director", text: S.directorGeneric },
    );
  };

  const sendToDirector = useCallback(
    (prompt: string) =>
      add(
        { id: nextId(), kind: "text", role: "user", text: prompt },
        { id: nextId(), kind: "text", role: "director", text: S.directorAck },
      ),
    [add],
  );

  return (
    <aside className={css.chat} aria-label={S.chatTitle}>
      <div className={css.chatHeader}>{S.chatTitle}</div>
      <div className={css.messages} data-testid="chat-messages">
        {messages.map((m) => {
          if (m.kind === "text") {
            return (
              <div
                key={m.id}
                className={`${css.bubble} ${m.role === "user" ? css.user : css.director}`}
                data-role={m.role}
              >
                {m.text}
              </div>
            );
          }
          if (m.kind === "paste-card") {
            return (
              <div key={m.id} className={css.card} role="group" aria-label={S.pasteCardTitle}>
                <span>{S.pasteCardTitle}</span>
                <span style={{ display: "flex", gap: 8 }}>
                  <button
                    className={`${css.btn} ${css.primary}`}
                    onClick={() =>
                      replace(m.id, { id: m.id, kind: "match", entry: "paste_card", url: m.url })
                    }
                  >
                    {S.pasteCardMatch}
                  </button>
                  <button className={css.btn} onClick={() => remove(m.id)}>
                    {S.pasteCardDismiss}
                  </button>
                </span>
              </div>
            );
          }
          return (
            <MatchSession
              key={m.id}
              project={project}
              entry={m.entry}
              initialUrl={m.url}
              initialGoal={m.goal}
              autoStart={m.autoStart}
              resumeBriefId={m.resumeBriefId}
              onSendToDirector={sendToDirector}
              onRemove={() => remove(m.id)}
            />
          );
        })}
        <div ref={endRef} />
      </div>
      <div className={css.composer}>
        <div className={css.composerRow}>
          <label htmlFor="chat-input" className="visually-hidden">
            Message
          </label>
          <input
            id="chat-input"
            className={css.composerInput}
            value={draft}
            placeholder={S.chatPlaceholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className={`${css.btn} ${css.primary}`} onClick={send}>
            {S.chatSend}
          </button>
        </div>
        <div>
          <button className={css.btn} onClick={() => openMatch("chat_action")}>
            {S.matchAction}
          </button>
        </div>
      </div>
    </aside>
  );
}
