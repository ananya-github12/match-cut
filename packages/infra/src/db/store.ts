import { eq, gte, lt } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { decryptWithAny, encryptText } from "../crypto.js";
import type { BriefPatch, BriefRecord, BriefStore } from "../types.js";
import { briefs } from "./schema.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function connectPostgres(url: string) {
  const sql = postgres(url, { max: 10, connect_timeout: 5, onnotice: () => {} });
  return { sql, db: drizzle(sql) };
}

export async function runMigrations(db: PostgresJsDatabase): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS });
}

type Row = typeof briefs.$inferSelect;

/** Goal text is encrypted at rest; everything else is stored as is. */
export class PgBriefStore implements BriefStore {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly goalKey: Buffer,
    /** Older keys still accepted for reading (rotation). */
    private readonly previousGoalKeys: Buffer[] = [],
  ) {}

  private warnedUnreadable = false;

  private fromRow(r: Row): BriefRecord {
    const goal = decryptWithAny(r.goal, [this.goalKey, ...this.previousGoalKeys]);
    if (goal === null && !this.warnedUnreadable) {
      this.warnedUnreadable = true;
      console.warn(
        `[store] brief ${r.id}: goal can't be decrypted with the current or previous keys; treating it as empty`,
      );
    }
    return { ...(r as unknown as BriefRecord), goal: goal ?? "" };
  }

  async create(rec: BriefRecord): Promise<void> {
    await this.db.insert(briefs).values({
      ...rec,
      goal: encryptText(rec.goal, this.goalKey),
    } as unknown as typeof briefs.$inferInsert);
  }

  async get(id: string): Promise<BriefRecord | null> {
    const [row] = await this.db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
    return row ? this.fromRow(row) : null;
  }

  async update(id: string, patch: BriefPatch): Promise<BriefRecord | null> {
    const [row] = await this.db
      .update(briefs)
      .set({
        ...(patch as Partial<typeof briefs.$inferInsert>),
        ...(patch.goal !== undefined ? { goal: encryptText(patch.goal, this.goalKey) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(briefs.id, id))
      .returning();
    return row ? this.fromRow(row) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(briefs).where(eq(briefs.id, id));
  }

  async listUpdatedSince(since: Date): Promise<BriefRecord[]> {
    const rows = await this.db.select().from(briefs).where(gte(briefs.updatedAt, since));
    return rows.map((r) => this.fromRow(r));
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(briefs)
      .where(lt(briefs.createdAt, cutoff))
      .returning({ id: briefs.id });
    return rows.length;
  }
}
