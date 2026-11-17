import { Suspense } from "react";
import { EditorShell } from "../components/editor/EditorShell";

export default function Home() {
  return (
    <Suspense>
      <EditorShell />
    </Suspense>
  );
}
