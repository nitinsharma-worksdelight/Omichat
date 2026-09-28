import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Env } from '../../config/env';
import { schema, type Db } from '../../db/client';
import type { OrgSettings, Role } from '../../db/schema';
import type { TenantDb } from '../../db/tenant';
import { hashPassword } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { bootstrapOrganization, DEFAULT_LIFECYCLE_STAGES } from './bootstrap';

export const OrgUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z
    .string()
    .refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC', 'unknown timezone')
    .optional(),
  aiEnabled: z.boolean().optional(),
  monthlyAiBudgetUsd: z.number().nonnegative().max(1_000_000).nullable().optional(),
  settings: z
    .object({
      notificationEmails: z.array(z.string().email()).max(20).optional(),
      lifecycleStages: z.array(z.string().trim().min(1).max(40)).min(1).max(30).optional(),
      defaultCountry: z.string().length(2).toUpperCase().optional(),
      currency: z
        .string()
        .trim()
        .toUpperCase()
        .refine((c) => Intl.supportedValuesOf('currency').includes(c), 'unknown currency (use an ISO 4217 code such as USD, EUR or INR)')
        .optional(),
    })
    .optional(),
});

export type OrgView = ReturnType<typeof toOrgView>;

function toOrgView(row: typeof schema.organizations.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    aiEnabled: row.aiEnabled,
    monthlyAiBudgetUsd: row.monthlyAiBudgetUsd === null ? null : Number(row.monthlyAiBudgetUsd),
    settings: {
      notificationEmails: row.settings.notificationEmails ?? [],
      lifecycleStages: row.settings.lifecycleStages ?? DEFAULT_LIFECYCLE_STAGES,
      defaultCountry: row.settings.defaultCountry ?? 'US',
    },
    createdAt: row.createdAt,
  };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TenancyService {
  constructor(
    private readonly db: Db,
    private readonly tenantDb: TenantDb,
    private readonly env: Env,
  ) {}

  /** System operation: the org doesn't exist yet, so this runs outside a tenant scope. */
  async createOrganization(input: { name: string; timezone?: string; ownerUserId: string }) {
    const timezone = input.timezone ?? 'UTC';
    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(schema.organizations)
        .values({
          name: input.name,
          slug: slugify(input.name),
          timezone,
          settings: { lifecycleStages: DEFAULT_LIFECYCLE_STAGES },
        })
        .returning();
      await tx.insert(schema.memberships).values({ organizationId: org!.id, userId: input.ownerUserId, role: 'owner' });
      const resources = await bootstrapOrganization(tx as unknown as Db, org!);
      return { organization: toOrgView(org!), ...resources };
    });
  }

  async getOrganization(orgId: string) {
    return this.tenantDb.run(orgId, async (tx) => {
      const [row] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
      if (!row) throw notFound('Organization');
      return toOrgView(row);
    });
  }

  async updateOrganization(orgId: string, input: z.infer<typeof OrgUpdateSchema>) {
    return this.tenantDb.run(orgId, async (tx) => {
      const [current] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
      if (!current) throw notFound('Organization');
      const settings: OrgSettings = { ...current.settings, ...(input.settings ?? {}) };
      const [row] = await tx
        .update(schema.organizations)
        .set({
          name: input.name,
          timezone: input.timezone,
          aiEnabled: input.aiEnabled,
          monthlyAiBudgetUsd:
            input.monthlyAiBudgetUsd === undefined ? undefined : input.monthlyAiBudgetUsd === null ? null : String(input.monthlyAiBudgetUsd),
          settings,
        })
        .where(eq(schema.organizations.id, orgId))
        .returning();
      return toOrgView(row!);
    });
  }

  /** Memberships of a user across orgs (system read used during authentication). */
  async membershipsForUser(userId: string) {
    return this.db
      .select({
        organizationId: schema.memberships.organizationId,
        role: schema.memberships.role,
        organizationName: schema.organizations.name,
      })
      .from(schema.memberships)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
      .where(eq(schema.memberships.userId, userId))
      .orderBy(schema.memberships.createdAt);
  }

  async membership(userId: string, orgId: string): Promise<Role | null> {
    const [row] = await this.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, orgId)));
    return row?.role ?? null;
  }

  async listMembers(orgId: string) {
    return this.tenantDb.run(orgId, (tx) =>
      tx
        .select({
          userId: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          role: schema.memberships.role,
          createdAt: schema.memberships.createdAt,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.organizationId, orgId))
        .orderBy(schema.memberships.createdAt),
    );
  }

  /**
   * Adds a teammate. Existing users are linked; in local auth mode a new user can be created with an
   * initial password (a real invite-by-email flow comes with the human-agent phase).
   */
  async addMember(orgId: string, input: { email: string; role: Role; name?: string; password?: string }) {
    if (input.role === 'owner') throw badRequest('Use ownership transfer to add owners');
    const email = input.email.trim().toLowerCase();
    return this.db.transaction(async (tx) => {
      let [user] = await tx.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
      if (!user) {
        if (this.env.AUTH_MODE !== 'local' || !input.password) {
          throw badRequest('User not found. In local auth mode, provide an initial password to create them.');
        }
        [user] = await tx
          .insert(schema.users)
          .values({ email, name: input.name ?? '', passwordHash: await hashPassword(input.password) })
          .returning();
      }
      const existing = await tx
        .select()
        .from(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user!.id)));
      if (existing.length) throw conflict('Already a member');
      await tx.insert(schema.memberships).values({ organizationId: orgId, userId: user!.id, role: input.role });
      return { userId: user!.id, email: user!.email, name: user!.name, role: input.role };
    });
  }

  async updateMemberRole(orgId: string, userId: string, role: Exclude<Role, 'owner'>) {
    return this.tenantDb.run(orgId, async (tx) => {
      const [m] = await tx
        .select()
        .from(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, userId)));
      if (!m) throw notFound('Member');
      if (m.role === 'owner') throw badRequest("The owner's role cannot be changed");
      await tx.update(schema.memberships).set({ role }).where(eq(schema.memberships.id, m.id));
      return { userId, role };
    });
  }

  async removeMember(orgId: string, userId: string) {
    await this.tenantDb.run(orgId, async (tx) => {
      const [m] = await tx
        .select()
        .from(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, userId)));
      if (!m) throw notFound('Member');
      if (m.role === 'owner') throw badRequest('The owner cannot be removed');
      await tx.delete(schema.memberships).where(eq(schema.memberships.id, m.id));
    });
  }
}
