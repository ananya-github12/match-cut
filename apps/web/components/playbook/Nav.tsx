/** Links between the editor, the playbook page and the skills list. */
import Link from "next/link";
import { P } from "../../lib/playbook-strings";
import css from "./playbook.module.css";

export function Nav({ current }: { current: "playbooks" | "skills" }) {
  return (
    <nav className={css.nav} aria-label="Match Cut">
      <Link href="/">{P.navEditor}</Link>
      <Link href="/playbooks" aria-current={current === "playbooks" ? "page" : undefined}>
        {P.navPlaybooks}
      </Link>
      <Link href="/skills" aria-current={current === "skills" ? "page" : undefined}>
        {P.navSkills}
      </Link>
    </nav>
  );
}
