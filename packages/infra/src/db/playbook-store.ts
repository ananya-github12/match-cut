/** Postgres stores for playbooks and skills (PRD-playbooks.md, Features 3 and 4). */
import { count, desc, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { decryptWithAny, encryptText } from "../crypto.js";
import type {
  PlaybookPatch,
  PlaybookRecord,
  PlaybookStore,
  SkillPatch,
  SkillRecord,
  SkillSource,
  SkillStore,
} from "../types.js";
import { playbooks, skills } from "./schema.js";

type PlaybookRow = typeof playbooks.$inferSelect;
type SkillRow = typeof skills.$inferSelect;

export class PgPlaybookStore implements PlaybookStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  private fromRow(r: PlaybookRow): PlaybookRecord {
    return r as unknown as PlaybookRecord;
  }

  async create(rec: PlaybookRecord): Promise<void> {
    await this.db.insert(playbooks).values(rec as unknown as typeof playbooks.$inferInsert);
  }

  async get(id: string): Promise<PlaybookRecord | null> {
    const [row] = await this.db.select().from(playbooks).where(eq(playbooks.id, id)).limit(1);
    return row ? this.fromRow(row) : null;
  }

  async update(id: string, patch: PlaybookPatch): Promise<PlaybookRecord | null> {
    const [row] = await this.db
      .update(playbooks)
      .set({ ...(patch as Partial<typeof playbooks.$inferInsert>), updatedAt: new Date() })
      .where(eq(playbooks.id, id))
      .returning();
    return row ? this.fromRow(row) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(playbooks).where(eq(playbooks.id, id));
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(playbooks)
      .where(lt(playbooks.createdAt, cutoff))
      .returning({ id: playbooks.id });
    return rows.length;
  }
}

/** Skill names are user-written, so they're encrypted at rest with the goal key. */
export class PgSkillStore implements SkillStore {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly key: Buffer,
    private readonly previousKeys: Buffer[] = [],
  ) {}

  private fromRow(r: SkillRow): SkillRecord {
    const { sourceType, sourceId, ...rest } = r;
    return {
      ...(rest as unknown as Omit<SkillRecord, "source">),
      name: decryptWithAny(r.name, [this.key, ...this.previousKeys]) ?? "",
      source: { type: sourceType, id: sourceId } as SkillSource,
    };
  }

  private toColumns(rec: SkillRecord): typeof skills.$inferInsert {
    const { source, ...rest } = rec;
    return {
      ...(rest as unknown as typeof skills.$inferInsert),
      name: encryptText(rec.name, this.key),
      sourceType: source.type,
      sourceId: source.id,
    };
  }

  async create(rec: SkillRecord, limit: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // One saver per user at a time, so the count and the insert can't race (PRD: 50 per user).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skills:${rec.userId}`}))`);
      const [row] = await tx
        .select({ n: count() })
        .from(skills)
        .where(eq(skills.userId, rec.userId));
      if ((row?.n ?? 0) >= limit) return false;
      await tx.insert(skills).values(this.toColumns(rec));
      return true;
    });
  }

  async get(id: string): Promise<SkillRecord | null> {
    const [row] = await this.db.select().from(skills).where(eq(skills.id, id)).limit(1);
    return row ? this.fromRow(row) : null;
  }

  async listByUser(userId: string): Promise<SkillRecord[]> {
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.userId, userId))
      .orderBy(
        desc(sql`coalesce(${skills.lastUsedAt}, ${skills.createdAt})`),
        desc(skills.createdAt),
        skills.id,
      );
    return rows.map((r) => this.fromRow(r));
  }

  async update(id: string, patch: SkillPatch): Promise<SkillRecord | null> {
    const [row] = await this.db
      .update(skills)
      .set({
        ...(patch as Partial<typeof skills.$inferInsert>),
        ...(patch.name !== undefined ? { name: encryptText(patch.name, this.key) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(skills.id, id))
      .returning();
    return row ? this.fromRow(row) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(skills).where(eq(skills.id, id));
  }
}
