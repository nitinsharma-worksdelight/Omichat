import { and, eq } from 'drizzle-orm';
import { notFound } from '../lib/errors';
import { schema, type Db } from './client';

/*
 * Foreign-key checks ignore row-level security, so an insert that points at another organization's row by id would
 * succeed. Writes that take an id from a caller check it belongs to the organization first.
 */

export async function assertContactInOrg(tx: Db, orgId: string, contactId: string): Promise<void> {
  const [row] = await tx
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, orgId)));
  if (!row) throw notFound('Contact');
}

export async function assertConversationInOrg(tx: Db, orgId: string, conversationId: string): Promise<void> {
  const [row] = await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.organizationId, orgId)));
  if (!row) throw notFound('Conversation');
}
