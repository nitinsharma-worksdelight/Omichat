import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container';
import { parseInput } from '../../lib/validation';
import { LoginSchema, SignupSchema } from '../../modules/auth/service';
import { requireUser } from '../auth';

export async function registerAuthRoutes(app: FastifyInstance, c: Container) {
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/signup', limited, async (req, reply) => {
    const result = await c.auth.signup(parseInput(SignupSchema, req.body));
    return reply.status(201).send(result);
  });

  app.post('/auth/login', limited, async (req) => c.auth.login(parseInput(LoginSchema, req.body)));

  app.get('/me', async (req) => {
    const auth = await requireUser(c, req);
    const me = await c.auth.me(auth.userId);
    return { ...me, currentOrganizationId: auth.orgId, role: auth.role, authMode: c.env.AUTH_MODE };
  });
}
