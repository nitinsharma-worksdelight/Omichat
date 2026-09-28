import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import { newId } from '../../lib/ids';

export const pk = () => uuid().primaryKey().$defaultFn(newId);
export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
export const ts = () => timestamp({ withTimezone: true });

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const EMBEDDING_DIMENSIONS = 1536;
