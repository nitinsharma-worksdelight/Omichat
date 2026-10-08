import { describe, expect, it } from 'vitest';
import { checkReply, slotsOf, timesIn, type ReplyFacts } from '../src/modules/ai/reply-check';

/**
 * BUG-03 — the last look at a booking bot's reply: no "booked" without a booking, and no times the calendar didn't
 * return. Pure text rules.
 */

// Monday 5 October 2026: 9:00, 9:30 and 10:00 (America/Toronto); the customer is in Kolkata.
const MONDAY = [
  { start: '2026-10-05T09:00', yourTime: 'Mon 5 Oct, 6:30 PM (Asia/Kolkata)' },
  { start: '2026-10-05T09:30' },
  { start: '2026-10-05T10:00' },
];
const facts = (f: Partial<ReplyFacts> = {}): ReplyFacts => ({ bookedThisTurn: false, hasUpcoming: false, offered: [], known: [], ...f });

describe('a booking it did not make', () => {
  it("is flagged (QA's reply)", () => {
    expect(checkReply('Your appointment for a general consultation has been successfully scheduled.', facts())).toContain("book_appointment didn't succeed");
    expect(checkReply("You're all booked for Tuesday at 3 PM!", facts())).toContain("book_appointment didn't succeed");
  });

  it('passes after a booking this turn, or when it can be about an existing appointment', () => {
    expect(checkReply("You're all booked for Monday at 9 AM!", facts({ bookedThisTurn: true, offered: MONDAY }))).toBeNull();
    expect(checkReply('Your appointment on Tue 6 Oct is confirmed.', facts({ hasUpcoming: true, known: ['Tue 6 Oct 2026, 3:00 PM'] }))).toBeNull();
  });

  it("isn't a claim when it says what will happen, or what didn't", () => {
    for (const text of [
      "Nothing is booked yet: the team will contact you to confirm.",
      "I haven't booked anything yet.",
      'Once it is booked, you will get an email.',
      'Would you like it booked?',
      "Our team will reach out to get it scheduled.",
    ]) {
      expect(checkReply(text, facts()), text).toBeNull();
    }
  });
});

describe('a booking that waits for the team (BUG-19)', () => {
  const waiting = (f: Partial<ReplyFacts> = {}) => facts({ waitingForTeam: true, ...f });

  it("flags 'scheduled' even when the same sentence says the team will confirm", () => {
    const problem = checkReply("I've scheduled your check-up for Thursday at 9:30, and a team member will confirm.", waiting());
    expect(problem).toContain("only waiting for the team's approval");
    // Without a pending approval, that wording isn't flagged (it can be about what will happen).
    expect(checkReply("I've scheduled your check-up for Thursday, and a team member will confirm.", facts())).toBeNull();
  });

  it('accepts saying it was requested or is pending', () => {
    for (const reply of [
      "I've asked the team about Thursday at 9:30. A team member will confirm it.",
      "Your request is pending: it isn't booked until the team approves it.",
      'Once the team approves, it will be booked.',
    ]) {
      expect(checkReply(reply, waiting()), reply).toBeNull();
    }
  });
});

describe('times the calendar did not return', () => {
  it('flags a time that was not offered', () => {
    expect(checkReply('Saturday at 11 AM is available. Shall I book it?', facts({ offered: MONDAY }))).toContain("11:00, which check_availability didn't return");
  });

  it('flags times offered without checking', () => {
    expect(checkReply('I can do 11 AM or 2 PM tomorrow. Which works?', facts())).toContain("haven't checked availability");
  });

  it('flags a day with no slots, even at a time that exists on another day', () => {
    expect(checkReply('Saturday at 9:00 AM is free if you like.', facts({ offered: MONDAY }))).toContain('day check_availability returned no slots for');
  });

  it("passes QA's own correct reply: no Saturday slots, Monday's listed one per line", () => {
    const reply =
      "I'm sorry, but there are no available slots for consultation this Saturday, October 3. The next available slots are on Monday, October 5, at:\n- 9:00 AM\n- 9:30 AM\n- 10:00 AM\nWould you like to book one of these times instead?";
    expect(checkReply(reply, facts({ offered: MONDAY }))).toBeNull();
    // The same list with a time the calendar didn't return.
    expect(checkReply(reply.replace('10:00 AM', '11:00 AM'), facts({ offered: MONDAY }))).toContain('11:00');
  });

  it("accepts the customer's own time for a slot, and an existing appointment's time", () => {
    expect(checkReply('Monday at 6:30 PM your time is available. Would you like it?', facts({ offered: MONDAY }))).toBeNull();
    expect(checkReply('How about Tuesday at 3 PM, like your current booking?', facts({ hasUpcoming: true, known: ['Tue 6 Oct 2026, 3:00 PM'], offered: MONDAY }))).toBeNull();
  });

  it("doesn't take opening hours for offers", () => {
    expect(checkReply("We're open Saturdays 10 AM to 2 PM, but appointments can't be booked on Saturdays.", facts({ offered: MONDAY }))).toBeNull();
    expect(checkReply('On Saturdays we open at 10 AM. Would you like a weekday appointment instead?', facts())).toBeNull();
  });
});

describe('helpers', () => {
  it('read clock times', () => {
    expect(timesIn('9 AM, 9:30 a.m., 2pm, 14:15 and 12 PM')).toEqual(['09:00', '09:30', '14:00', '12:00', '14:15']);
  });

  it("read a check_availability result's slots", () => {
    expect(slotsOf({ days: [{ date: '2026-10-05', times: [{ start: '2026-10-05T09:00', label: 'x', your_time: 'y' }] }] })).toEqual([{ start: '2026-10-05T09:00', yourTime: 'y' }]);
    expect(slotsOf({ available: false, next_available: [{ start: '2026-10-05T09:00' }] })).toEqual([{ start: '2026-10-05T09:00' }]);
    expect(slotsOf({ error: 'nope' })).toEqual([]);
  });
});
