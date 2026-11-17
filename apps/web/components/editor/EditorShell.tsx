"use client";
/**
 * Stand-in for Cardboard's editor: a project canvas and the AI Chat panel. Match Cut lives inside
 * the chat panel, so users never leave their project (PRD "Platforms and entry points").
 */
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { projectFromQuery } from "../../lib/project";
import { ChatPanel } from "./ChatPanel";
import css from "./editor.module.css";

export function EditorShell({ deepLinkUrl }: { deepLinkUrl?: string }) {
  const params = useSearchParams();
  const project = useMemo(() => projectFromQuery(new URLSearchParams(params.toString())), [params]);
  return (
    <div className={css.shell}>
      <main className={css.editor} aria-label="Editor">
        <div className={css.topbar}>
          <div>
            <div className={css.project}>{project.name}</div>
            <div className={css.projectMeta}>
              {project.aspect} ·{" "}
              {project.lengthSeconds ? `${project.lengthSeconds} s` : "any length"}
            </div>
          </div>
        </div>
        <div className={css.canvas}>
          Your footage and timeline would be here. This demo stubs Cardboard&apos;s editor; Match
          Cut runs in the AI Chat panel.
        </div>
        <div className={css.timeline} aria-hidden="true" />
      </main>
      <ChatPanel project={project} deepLinkUrl={deepLinkUrl} />
    </div>
  );
}
