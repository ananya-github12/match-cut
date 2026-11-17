/** Deep link: /match?url=… opens the input panel prefilled (PRD entry point 4). */
import { Suspense } from "react";
import { EditorShell } from "../../components/editor/EditorShell";

export default async function MatchDeepLink({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { url } = await searchParams;
  return (
    <Suspense>
      <EditorShell deepLinkUrl={typeof url === "string" ? url : ""} />
    </Suspense>
  );
}
