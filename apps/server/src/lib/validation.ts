import { z } from 'zod';
import { AppError } from './errors';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Plain-words versions of the validation library's own messages, for people reading them in a form. A message a
 * schema sets itself always wins: this map is only asked about issues without one. Undefined keeps the default.
 */
export const friendlyError: z.core.$ZodErrorMap = (iss) => {
  switch (iss.code) {
    case 'invalid_type':
      if (iss.input === undefined || iss.input === null) return 'Required';
      return iss.expected === 'date' ? 'Enter a valid date' : iss.expected === 'number' ? 'Enter a number' : undefined;
    case 'too_small': {
      const min = Number(iss.minimum);
      if (iss.origin === 'number' || iss.origin === 'int' || iss.origin === 'bigint') {
        if (min === 0) return iss.inclusive ? "Can't be negative" : 'Must be more than 0';
        return iss.inclusive ? `Must be at least ${min}` : `Must be more than ${min}`;
      }
      if (iss.origin === 'string') return min <= 1 ? 'Required' : `Must be at least ${plural(min, 'character')}`;
      if (iss.origin === 'array' || iss.origin === 'set') return `Add at least ${min}`;
      return undefined;
    }
    case 'too_big': {
      const max = Number(iss.maximum);
      if (iss.origin === 'number' || iss.origin === 'int' || iss.origin === 'bigint') return iss.inclusive ? `Must be at most ${max}` : `Must be less than ${max}`;
      if (iss.origin === 'string') return `Must be at most ${plural(max, 'character')}`;
      if (iss.origin === 'array' || iss.origin === 'set') return `At most ${plural(max, 'item')}`;
      return undefined;
    }
    case 'invalid_format':
      if (iss.format === 'email') return 'Enter a valid email address';
      if (iss.format === 'url') return 'Enter a valid web address';
      if (iss.format === 'uuid') return 'Not a valid id';
      if (iss.format === 'regex') return "Contains characters that aren't allowed";
      if (iss.format === 'date' || iss.format === 'datetime') return 'Enter a valid date';
      return undefined;
    case 'invalid_value':
      return iss.values.length <= 8 ? `Must be one of: ${iss.values.map(String).join(', ')}` : 'Not an allowed value';
    default:
      return undefined;
  }
};

/** Parse untrusted input; throws a 400 with field-level issues. */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data, { error: friendlyError });
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
