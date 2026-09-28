import { schema } from '../../db/client';
import type { Interval } from './availability';

type CalendarRow = typeof schema.calendars.$inferSelect;
type AppointmentRow = typeof schema.appointments.$inferSelect;

/**
 * Where a calendar's truth lives. `internal` = our own appointments table (nothing external).
 * Google Calendar / GHL providers (Phase 5) add external busy time and mirror bookings as events.
 */
export interface CalendarProvider {
  busy(calendar: CalendarRow, from: Date, to: Date): Promise<Interval[]>;
  onBooked?(calendar: CalendarRow, appointment: AppointmentRow): Promise<void>;
  onRescheduled?(calendar: CalendarRow, appointment: AppointmentRow): Promise<void>;
  onCancelled?(calendar: CalendarRow, appointment: AppointmentRow): Promise<void>;
}

export class InternalCalendarProvider implements CalendarProvider {
  async busy(): Promise<Interval[]> {
    return [];
  }
}

export class CalendarProviderRegistry {
  private readonly providers = new Map<string, CalendarProvider>([['internal', new InternalCalendarProvider()]]);

  register(key: string, provider: CalendarProvider): void {
    this.providers.set(key, provider);
  }

  get(key: string): CalendarProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Calendar provider "${key}" is not configured`);
    return provider;
  }
}
