/** Postgres stores for playbooks and skills (PRD-playbooks.md, Features 3 and 4). */
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { decryptWithAny, encryptText } from "../crypto.js";
import { definedOnly, storageSafe } from "../storage-safe.js";
import type {
  PlaybookPatch,
  PlaybookRecord,
  PlaybookSettings,
  PlaybookStore,
  PlaybookUpdateOptions,
  SkillPatch,
  SkillRecord,
  SkillStore,
} from "../types.js";
import { playbooks, skills } from "./schema.js";

type PlaybookRow = typeof playbooks.$inferSelect;
type SkillRow = typeof skills.$inferSelect;

export const sameSettings = (a: PlaybookSettings, b: PlaybookSettings) =>
  a.windowDays === b.windowDays &&
  a.maxVideos === b.maxVideos &&
  a.outlierThreshold === b.outlierThreshold;

export class PgPlaybookStore implements PlaybookStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  private fromRow(r: PlaybookRow): PlaybookRecord {
    const { channelId: _channelId, ...rec } = r;
    return rec as PlaybookRecord;
  }

  async create(rec: PlaybookRecord): Promise<void> {
    await this.db
      .insert(playbooks)
      .values({ ...storageSafe(rec), channelId: rec.channel?.id ?? null });
  }

  async get(id: string): Promise<PlaybookRecord | null> {
    const [row] = await this.db.select().from(playbooks).where(eq(playbooks.id, id)).limit(1);
    return row ? this.fromRow(row) : null;
  }

  async update(
    id: string,
    patch: PlaybookPatch,
    opts: PlaybookUpdateOptions = {},
  ): Promise<PlaybookRecord | null> {
    const set = storageSafe(definedOnly(patch));
    const where = opts.onlyIfStatus
      ? and(eq(playbooks.id, id), inArray(playbooks.status, [...opts.onlyIfStatus]))
      : eq(playbooks.id, id);
    const [row] = await this.db
      .update(playbooks)
      .set({
        ...set,
        ...("channel" in set ? { channelId: set.channel?.id ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(where)
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

  async findRecent(q: {
    userId: string;
    channelId: string;
    settings: PlaybookSettings;
    since: Date;
  }): Promise<PlaybookRecord | null> {
    // A handful of rows per user and channel a day: settings are compared here, not in SQL.
    const rows = await this.db
      .select()
      .from(playbooks)
      .where(
        and(
          eq(playbooks.channelId, q.channelId),
          eq(playbooks.userId, q.userId),
          eq(playbooks.status, "succeeded"),
          gte(playbooks.createdAt, q.since),
        ),
      )
      .orderBy(desc(playbooks.createdAt), sql`${playbooks.id} collate "C"`)
      .limit(20);
    const hit = rows.find((r) => sameSettings(r.settings, q.settings));
    return hit ? this.fromRow(hit) : null;
  }

  async countByUserSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(playbooks)
      .where(and(eq(playbooks.userId, userId), gte(playbooks.createdAt, since)));
    return row?.n ?? 0;
  }
}

/** Skill names are user-written, so they're encrypted at rest with the goal key. */
export class PgSkillStore implements SkillStore {
  private warnedUnreadable = false;

  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly key: Buffer,
    private readonly previousKeys: Buffer[] = [],
  ) {}

  private fromRow(r: SkillRow): SkillRecord {
    const { sourceType, sourceId, ...rest } = r;
    const name = decryptWithAny(r.name, [this.key, ...this.previousKeys]);
    if (name === null && !this.warnedUnreadable) {
      this.warnedUnreadable = true;
      console.warn(
        `[store] skill ${r.id}: name can't be decrypted with the current or previous keys; treating it as empty`,
      );
    }
    return { ...rest, name: name ?? "", source: { type: sourceType, id: sourceId } };
  }

  async create(rec: SkillRecord, limit: number): Promise<boolean> {
    const { source, ...rest } = storageSafe(rec);
    return this.db.transaction(async (tx) => {
      // One saver per user at a time, so the count and the insert can't race (PRD: 50 per user).
      // Relies on READ COMMITTED (the default): the count runs after the lock and sees commits.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skills:${rec.userId}`}))`);
      const [row] = await tx
        .select({ n: count() })
        .from(skills)
        .where(eq(skills.userId, rec.userId));
      if ((row?.n ?? 0) >= limit) return false;
      await tx.insert(skills).values({
        ...rest,
        name: encryptText(rest.name, this.key),
        sourceType: source.type,
        sourceId: source.id,
      });
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
        // Byte order, as the in-memory store sorts, whatever the database's collation.
        sql`${skills.id} collate "C"`,
      );
    return rows.map((r) => this.fromRow(r));
  }

  async update(id: string, patch: SkillPatch): Promise<SkillRecord | null> {
    const set = storageSafe(definedOnly(patch));
    const [row] = await this.db
      .update(skills)
      .set({
        ...set,
        ...(set.name !== undefined ? { name: encryptText(set.name, this.key) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(skills.id, id))
      .returning();
    return row ? this.fromRow(row) : null;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.db.update(skills).set({ lastUsedAt: at }).where(eq(skills.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(skills).where(eq(skills.id, id));
  }
}
