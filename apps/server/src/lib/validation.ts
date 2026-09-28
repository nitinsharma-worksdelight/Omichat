import { z } from 'zod';
import { AppError } from './errors';

/** Parse untrusted input; throws a 400 with field-level issues. */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      400,
      'validation_error',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/**
 * For PATCH bodies: validate, then keep only the keys the client actually sent. Zod applies
 * `.default()` values even inside `.partial()`, which would silently reset omitted fields.
 */
export function parsePatch<S extends z.ZodType>(schema: S, data: unknown): Partial<z.infer<S>> {
  const parsed = parseInput(schema, data) as Record<string, unknown>;
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => key in raw)) as Partial<z.infer<S>>;
}

/** Query-string boolean: "true"/"1" → true, "false"/"0" → false (z.coerce.boolean treats "false" as true). */
export const queryBool = z.preprocess((v) => {
  if (v === 'true' || v === '1' || v === true) return true;
  if (v === 'false' || v === '0' || v === false) return false;
  return v;
}, z.boolean());
