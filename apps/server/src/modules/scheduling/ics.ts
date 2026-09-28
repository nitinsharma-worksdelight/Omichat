/**
 * An iCalendar (.ics) file for one appointment (RFC 5545). The UID stays the same for the life of the booking and
 * SEQUENCE goes up with each change, so calendar apps can update or remove the entry the customer added.
 */
export interface CalendarEvent {
  uid: string;
  sequence: number;
  /** PUBLISH: add or update the event; CANCEL: remove it. */
  method: 'PUBLISH' | 'CANCEL';
  start: Date;
  end: Date;
  summary: string;
  location?: string;
  description?: string;
  stamp: Date;
}

export function calendarFile(e: CalendarEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Omnichannel AI//Bookings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.method}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${utc(e.stamp)}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    e.location ? `LOCATION:${escapeText(e.location)}` : null,
    e.description ? `DESCRIPTION:${escapeText(e.description)}` : null,
    `STATUS:${e.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines
    .filter((l): l is string => l !== null)
    .map(fold)
    .join('\r\n')}\r\n`;
}

/** 20260929T140000Z */
function utc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets continue on the next line after a space, without splitting a UTF-8 character. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = parts.length ? 74 : 75; // continuation lines start with a space
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
