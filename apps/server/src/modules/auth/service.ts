import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Env } from '../../config/env';
import { schema, type Db } from '../../db/client';
import type { Role } from '../../db/schema';
import type { TenantDb } from '../../db/tenant';
import { hashPassword, sha256, verifyPassword } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { randomToken } from '../../lib/ids';
import type { TenancyService } from '../tenancy/service';
import type { TokenService } from './tokens';

export const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  name: z.string().trim().max(120).default(''),
  organizationName: z.string().trim().min(1).max(120),
  timezone: z.string().optional(),
});

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

export const API_KEY_SCOPES = [
  'conversations:read',
  'conversations:write',
  'contacts:read',
  'contacts:write',
  'appointments:read',
  'appointments:write',
  'deals:read',
  'deals:write',
  'knowledge:write',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type AuthContext =
  | { kind: 'user'; userId: string; orgId: string; role: Role }
  | { kind: 'api_key'; keyId: string; orgId: string; scopes: string[] };

const ROLE_RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };

export function hasRole(auth: AuthContext, minimum: Role): boolean {
  // API keys act as an integration with admin-level access to the scopes they were granted.
  if (auth.kind === 'api_key') return ROLE_RANK.admin >= ROLE_RANK[minimum];
  return ROLE_RANK[auth.role] >= ROLE_RANK[minimum];
}

export function requireRole(auth: AuthContext, minimum: Role): void {
  if (!hasRole(auth, minimum)) throw forbidden(`Requires ${minimum} role`);
}

export function requireScope(auth: AuthContext, scope: ApiKeyScope): void {
  if (auth.kind === 'api_key' && !auth.scopes.includes(scope)) throw forbidden(`API key lacks scope ${scope}`);
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly tenantDb: TenantDb,
    private readonly env: Env,
    private readonly tokens: TokenService,
    private readonly tenancy: TenancyService,
  ) {}

  async signup(input: z.infer<typeof SignupSchema>) {
    if (this.env.AUTH_MODE !== 'local') throw badRequest('Sign-up happens through Supabase Auth in this deployment');
    const existing = await this.db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${input.email}`);
    if (existing.length) throw conflict('An account with this email already exists');
    const [user] = await this.db
      .insert(schema.users)
      .values({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password), lastLoginAt: new Date() })
      .returning();
    const created = await this.tenancy.createOrganization({ name: input.organizationName, timezone: input.timezone, ownerUserId: user!.id });
    return {
      token: await this.tokens.signUserToken(user!.id),
      user: { id: user!.id, email: user!.email, name: user!.name },
      organization: created.organization,
    };
  }

  async login(input: z.infer<typeof LoginSchema>) {
    if (this.env.AUTH_MODE !== 'local') throw badRequest('Log in through Supabase Auth in this deployment');
    const [user] = await this.db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${input.email}`);
    // Same error either way so the endpoint doesn't reveal which emails exist.
    if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      throw unauthorized('Invalid email or password');
    }
    await this.db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
    return {
      token: await this.tokens.signUserToken(user.id),
      user: { id: user.id, email: user.email, name: user.name },
      memberships: await this.tenancy.membershipsForUser(user.id),
    };
  }

  /** Bearer token → user id. Supabase mode provisions the local user row on first sight. */
  async userIdFromBearer(token: string): Promise<string> {
    if (this.env.AUTH_MODE === 'local') return this.tokens.verifyUserToken(token);
    const claims = await this.tokens.verifySupabaseToken(token);
    const [found] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.externalAuthId, claims.sub));
    if (found) return found.id;
    if (!claims.email) throw unauthorized('Token has no email');
    const [user] = await this.db
      .insert(schema.users)
      .values({ email: claims.email, name: claims.name ?? '', authProvider: 'supabase', externalAuthId: claims.sub })
      .onConflictDoNothing()
      .returning({ id: schema.users.id });
    if (user) return user.id;
    // Same email already registered locally: link it.
    const [linked] = await this.db
      .update(schema.users)
      .set({ externalAuthId: claims.sub, authProvider: 'supabase' })
      .where(and(sql`lower(${schema.users.email}) = ${claims.email.toLowerCase()}`, isNull(schema.users.externalAuthId)))
      .returning({ id: schema.users.id });
    if (!linked) throw unauthorized('Account conflict');
    return linked.id;
  }

  async me(userId: string) {
    const [user] = await this.db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!user) throw unauthorized('User no longer exists');
    return { user, memberships: await this.tenancy.membershipsForUser(userId) };
  }

  /** Resolves which org a user request acts on: explicit header, else their only/first membership. */
  async userContext(userId: string, requestedOrgId: string | undefined): Promise<AuthContext> {
    if (requestedOrgId) {
      const role = await this.tenancy.membership(userId, requestedOrgId);
      if (!role) throw forbidden('Not a member of this organization');
      return { kind: 'user', userId, orgId: requestedOrgId, role };
    }
    const memberships = await this.tenancy.membershipsForUser(userId);
    const first = memberships[0];
    if (!first) throw forbidden('You are not a member of any organization');
    return { kind: 'user', userId, orgId: first.organizationId, role: first.role };
  }

  // ---- API keys (server-to-server, e.g. n8n or the LeadsMagnet app) ----

  async createApiKey(orgId: string, input: { name: string; scopes: string[]; createdByUserId?: string }) {
    const plaintext = randomToken('sk', 32);
    const [row] = await this.tenantDb.run(orgId, (tx) =>
      tx
        .insert(schema.apiKeys)
        .values({
          organizationId: orgId,
          name: input.name,
          prefix: plaintext.slice(0, 10),
          keyHash: sha256(plaintext),
          scopes: input.scopes,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning(),
    );
    // The plaintext key is only ever returned here.
    return { id: row!.id, name: row!.name, prefix: row!.prefix, scopes: row!.scopes, key: plaintext, createdAt: row!.createdAt };
  }

  async listApiKeys(orgId: string) {
    return this.tenantDb.run(orgId, (tx) =>
      tx
        .select({
          id: schema.apiKeys.id,
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
          scopes: schema.apiKeys.scopes,
          lastUsedAt: schema.apiKeys.lastUsedAt,
          revokedAt: schema.apiKeys.revokedAt,
          createdAt: schema.apiKeys.createdAt,
        })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.organizationId, orgId))
        .orderBy(schema.apiKeys.createdAt),
    );
  }

  /** Rename a key or change its scopes; the change applies on the key's next request. Revoked keys can't change. */
  async updateApiKey(orgId: string, keyId: string, input: { name?: string; scopes?: string[] }) {
    const [row] = await this.tenantDb.run(orgId, (tx) =>
      tx
        .update(schema.apiKeys)
        .set({ ...(input.name ? { name: input.name } : {}), ...(input.scopes ? { scopes: input.scopes } : {}) })
        .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.organizationId, orgId), isNull(schema.apiKeys.revokedAt)))
        .returning({
          id: schema.apiKeys.id,
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
          scopes: schema.apiKeys.scopes,
          lastUsedAt: schema.apiKeys.lastUsedAt,
          revokedAt: schema.apiKeys.revokedAt,
          createdAt: schema.apiKeys.createdAt,
        }),
    );
    if (!row) throw notFound('API key');
    return row;
  }

  async revokeApiKey(orgId: string, keyId: string) {
    await this.tenantDb.run(orgId, (tx) =>
      tx
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.organizationId, orgId))),
    );
  }

  async apiKeyContext(plaintext: string): Promise<AuthContext> {
    const [row] = await this.db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, sha256(plaintext)), isNull(schema.apiKeys.revokedAt)));
    if (!row) throw unauthorized('Invalid API key');
    void this.db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.id)).catch(() => {});
    return { kind: 'api_key', keyId: row.id, orgId: row.organizationId, scopes: row.scopes };
  }
}
