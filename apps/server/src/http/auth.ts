import type { FastifyRequest } from 'fastify';
import type { Container } from '../container';
import type { Role } from '../db/schema';
import { unauthorized } from '../lib/errors';
import { isUuid } from '../lib/ids';
import { requireRole, requireScope, type ApiKeyScope, type AuthContext } from '../modules/auth/service';
import type { WidgetClaims } from '../modules/auth/tokens';

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/** Dashboard user (JWT) or integration (org API key `sk_…`). The org comes from the credential, never the body. */
export async function authenticate(c: Container, req: FastifyRequest): Promise<AuthContext> {
  const token = bearer(req);
  if (!token) throw unauthorized();
  if (token.startsWith('sk_')) return c.auth.apiKeyContext(token);
  const userId = await c.auth.userIdFromBearer(token);
  const orgHeader = req.headers['x-org-id'];
  const requested = typeof orgHeader === 'string' && isUuid(orgHeader) ? orgHeader : undefined;
  return c.auth.userContext(userId, requested);
}

export async function requireUser(c: Container, req: FastifyRequest, minimum: Role = 'viewer'): Promise<Extract<AuthContext, { kind: 'user' }>> {
  const auth = await authenticate(c, req);
  if (auth.kind !== 'user') throw unauthorized('This endpoint requires a user session');
  requireRole(auth, minimum);
  return auth;
}

/** User with at least `minimum` role, or an API key holding `scope`. */
export async function requireAccess(c: Container, req: FastifyRequest, minimum: Role, scope?: ApiKeyScope): Promise<AuthContext> {
  const auth = await authenticate(c, req);
  if (auth.kind === 'api_key') {
    if (!scope) throw unauthorized('API keys cannot use this endpoint');
    requireScope(auth, scope);
  } else {
    requireRole(auth, minimum);
  }
  return auth;
}

export async function requireWidget(c: Container, req: FastifyRequest): Promise<WidgetClaims> {
  const token = bearer(req);
  if (!token) throw unauthorized('Widget session required');
  const claims = await c.tokens.verifyWidgetToken(token);
  const origin = req.headers.origin;
  if (claims.origin && origin && origin !== claims.origin) throw unauthorized('Widget session belongs to another site');
  return claims;
}

export const actorUserId = (auth: AuthContext) => (auth.kind === 'user' ? auth.userId : undefined);
