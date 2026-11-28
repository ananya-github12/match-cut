/** /playbooks (and /playbooks?channel=@name): what a channel's breakout Shorts share. */
import { Suspense } from "react";
import { PlaybookPage } from "../../components/playbook/PlaybookPage";

export const metadata = { title: "Channel playbook · Match Cut" };

export default function Page() {
  return (
    <Suspense>
      <PlaybookPage />
    </Suspense>
  );
}
