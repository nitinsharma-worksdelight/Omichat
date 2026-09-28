import type { schema } from '../../db/client';
import type { ChannelType } from '../../db/schema';
import type { MessageView } from '../conversations/service';

export interface OutboundDelivery {
  orgId: string;
  conversation: typeof schema.conversations.$inferSelect;
  message: MessageView;
}

/**
 * The only channel-specific code in the system. Inbound parsing lives in each channel's routes
 * (webhook verification → NormalizedInboundMessage); outbound delivery lives here.
 * Phase 2 adds WhatsApp / Messenger / Instagram adapters that call the provider APIs.
 */
export interface ChannelAdapter {
  readonly channel: ChannelType;
  /** Whether replies can be streamed token-by-token (widget) or must be sent whole (WhatsApp, SMS). */
  readonly streaming: boolean;
  deliver(delivery: OutboundDelivery): Promise<void>;
}

/** Website widget, dashboard playground and the public API read replies from our own realtime stream. */
export class RealtimeChannelAdapter implements ChannelAdapter {
  constructor(
    readonly channel: ChannelType,
    readonly streaming: boolean,
  ) {}

  async deliver(): Promise<void> {
    // Nothing to push to a third party: the message is stored and published on the realtime bus.
  }
}

export class ChannelRegistry {
  private readonly adapters = new Map<ChannelType, ChannelAdapter>();

  constructor() {
    this.register(new RealtimeChannelAdapter('webchat', true));
    this.register(new RealtimeChannelAdapter('playground', true));
    this.register(new RealtimeChannelAdapter('api', false));
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  get(channel: ChannelType): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new Error(`No adapter registered for channel "${channel}"`);
    return adapter;
  }
}
