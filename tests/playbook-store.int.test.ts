/**
 * M10.5 against real Postgres (`pnpm services:up`, then `pnpm test:int`): the migration, the
 * store contract, the atomic skill limit and skill names encrypted at rest.
 */
import {
  connectPostgres,
  goalKeyFrom,
  PgPlaybookStore,
  PgSkillStore,
  runMigrations,
} from "@match-cut/infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skillRecord, storeContract } from "./playbook-fixtures.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://matchcut:matchcut@localhost:5432/matchcut";
const { sql, db } = connectPostgres(DATABASE_URL);
const key = goalKeyFrom(undefined, "integration-test");

beforeAll(async () => {
  await runMigrations(db);
});
afterAll(async () => {
  await sql.end();
});

storeContract("postgres", () => ({
  playbooks: new PgPlaybookStore(db),
  skills: new PgSkillStore(db, key),
}));

describe("postgres: skill names at rest", () => {
  it("are encrypted, and readable with a previous key after rotation", async () => {
    const store = new PgSkillStore(db, key);
    const rec = skillRecord({ userId: `user_enc_${Date.now()}`, name: "My secret recipe" });
    await store.create(rec, 50);
    const [row] = await sql<{ name: string }[]>`select name from skills where id = ${rec.id}`;
    expect(row!.name).not.toContain("secret");
    expect(row!.name.startsWith("v1:")).toBe(true);
    const rotated = new PgSkillStore(db, goalKeyFrom(undefined, "new-key"), [key]);
    expect((await rotated.get(rec.id))!.name).toBe("My secret recipe");
    await store.delete(rec.id);
  });
});
