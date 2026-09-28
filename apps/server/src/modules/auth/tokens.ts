import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../../config/env';
import { unauthorized } from '../../lib/errors';

const ISSUER = 'omni';

export interface WidgetClaims {
  orgId: string;
  channelAccountId: string;
  visitorId: string;
  /** Playground sessions test a specific bot, which may not be the channel's default. */
  botId?: string;
  /** Origin the session was opened from; later requests must come from the same origin. */
  origin?: string;
}

/**
 * Two token families signed with our secret: dashboard user sessions (`typ: user`, local auth mode)
 * and widget visitor sessions (`typ: widget`). Supabase-issued user tokens are verified separately.
 */
export class TokenService {
  private readonly secret: Uint8Array;
  private readonly supabaseSecret?: Uint8Array;
  private readonly supabaseJwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly env: Env) {
    this.secret = new TextEncoder().encode(env.JWT_SECRET);
    if (env.SUPABASE_JWT_SECRET) this.supabaseSecret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    else if (env.SUPABASE_URL) {
      this.supabaseJwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
    }
  }

  async signUserToken(userId: string): Promise<string> {
    return new SignJWT({ typ: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${this.env.JWT_TTL_HOURS}h`)
      .sign(this.secret);
  }

  async verifyUserToken(token: string): Promise<string> {
    const payload = await this.verifyOwn(token, 'user');
    if (!payload.sub) throw unauthorized('Invalid token');
    return payload.sub;
  }

  async signWidgetToken(claims: WidgetClaims): Promise<string> {
    return new SignJWT({ typ: 'widget', org: claims.orgId, ca: claims.channelAccountId, bot: claims.botId, ori: claims.origin })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.visitorId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${this.env.WIDGET_TOKEN_TTL_HOURS}h`)
      .sign(this.secret);
  }

  async verifyWidgetToken(token: string): Promise<WidgetClaims> {
    const payload = await this.verifyOwn(token, 'widget');
    if (typeof payload.org !== 'string' || typeof payload.ca !== 'string' || !payload.sub) {
      throw unauthorized('Invalid widget session');
    }
    return {
      orgId: payload.org,
      channelAccountId: payload.ca,
      visitorId: payload.sub,
      botId: typeof payload.bot === 'string' ? payload.bot : undefined,
      origin: typeof payload.ori === 'string' ? payload.ori : undefined,
    };
  }

  /** Supabase Auth access token → { sub, email }. */
  async verifySupabaseToken(token: string): Promise<{ sub: string; email: string | null; name: string | null }> {
    let payload: JWTPayload;
    try {
      if (this.supabaseSecret) payload = (await jwtVerify(token, this.supabaseSecret)).payload;
      else if (this.supabaseJwks) payload = (await jwtVerify(token, this.supabaseJwks)).payload;
      else throw new Error('Supabase auth is not configured');
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    if (!payload.sub) throw unauthorized('Invalid token');
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      name: typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : null,
    };
  }

  private async verifyOwn(token: string, typ: 'user' | 'widget'): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, algorithms: ['HS256'] });
      if (payload.typ !== typ) throw new Error('wrong token type');
      return payload;
    } catch {
      throw unauthorized(typ === 'widget' ? 'Widget session expired' : 'Invalid or expired token');
    }
  }
}
