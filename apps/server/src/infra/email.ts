import type { Logger } from '../lib/logger';

export interface EmailAttachment {
  filename: string;
  /** Base64-encoded content. */
  content: string;
  contentType?: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Display name for the configured From address, e.g. the business's name. The address itself never changes. */
  fromName?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** The provider sends one email per key (Resend keeps keys for 24 hours), so a retried send can't go out twice. */
  idempotencyKey?: string;
}

/** A send that failed. `permanent` ones (an invalid address, an unverified sending domain) aren't worth retrying. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ id: string | null }>;
}

export class LogEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  constructor(private readonly logger: Logger) {}

  async send(message: EmailMessage): Promise<{ id: string | null }> {
    this.sent.push(message);
    this.logger.info({ to: message.to, subject: message.subject }, 'email (log provider)');
    return { id: `log_${this.sent.length}` };
  }
}

export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<{ id: string | null }> {
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey.slice(0, 256) } : {}),
        },
        body: JSON.stringify({
          from: message.fromName ? withDisplayName(this.from, message.fromName) : this.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          reply_to: message.replyTo,
          attachments: message.attachments?.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new EmailSendError(`Resend unreachable: ${err instanceof Error ? err.message : String(err)}`, false);
    }
    if (!res.ok) {
      // Rate limits (429), idempotency clashes (409) and server errors are temporary; other client errors won't fix themselves.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 409;
      throw new EmailSendError(`Resend failed: ${res.status} ${(await res.text()).slice(0, 300)}`, permanent);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: json.id ?? null };
  }
}

/** `Omnichannel AI <notifications@x.com>` with "Bright Smile" → `"Bright Smile" <notifications@x.com>`. */
export function withDisplayName(from: string, name: string): string {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
  const clean = name.replace(/["<>\\\r\n]/g, '').trim().slice(0, 100);
  return clean ? `"${clean}" <${address}>` : from;
}
