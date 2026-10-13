/**
 * "Stop Bot": while a conversation is stopped the assistant stays silent, though the conversation itself is still
 * the AI's (nobody was asked to take over). It is kept in `conversations.metadata.aiStop` and ends when `until`
 * passes, or when staff resume the conversation. `until` is null for a stop that lasts until staff resume it.
 */
export interface AiStop {
  scenarioId: string;
  scenarioName: string;
  /** When the assistant stopped (ISO). */
  at: string;
  /** When it starts again (ISO), or null: only staff can restart it. */
  until: string | null;
}

/** The stop recorded on a conversation, if any (expired or not). */
export function aiStopOf(metadata: Record<string, unknown> | null | undefined): AiStop | null {
  const raw = metadata?.aiStop;
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AiStop>;
  if (typeof s.scenarioName !== 'string' || typeof s.at !== 'string') return null;
  return { scenarioId: typeof s.scenarioId === 'string' ? s.scenarioId : '', scenarioName: s.scenarioName, at: s.at, until: typeof s.until === 'string' ? s.until : null };
}

/** The stop that is in force right now, or null (none, or its time is up). */
export function activeStop(metadata: Record<string, unknown> | null | undefined, now: Date): AiStop | null {
  const stop = aiStopOf(metadata);
  if (!stop) return null;
  return stop.until === null || Date.parse(stop.until) > now.getTime() ? stop : null;
}

/**
 * Whether a customer message arrived while the assistant was stopped. Such a message is never answered later, not even
 * once the stop ends: the customer wrote it knowing the assistant was quiet (a "thanks, bye" isn't worth a reply a day on).
 */
export function arrivedWhileStopped(stop: AiStop, messageAt: Date): boolean {
  return stop.until === null || messageAt.getTime() <= Date.parse(stop.until);
}

/** The id of the stop "Pause bot responses after booking" records (it isn't one of the business's Stop Bot scenarios). */
export const BOOKED_STOP_ID = 'appointment_booked';
