import { and, eq, sql } from 'drizzle-orm';
import type { Container } from '../container';
import { schema } from './client';

export const DEMO_EMAIL = 'demo@example.com';
export const DEMO_PASSWORD = 'demo-password-123';

/**
 * A realistic demo tenant: a dental clinic whose website assistant answers FAQs from its knowledge
 * base, captures leads, qualifies them, and books consultations.
 */
export async function seedDemo(c: Container, opts: { timezone?: string } = {}) {
  const [existing] = await c.db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${DEMO_EMAIL}`);
  if (existing) {
    const memberships = await c.tenancy.membershipsForUser(existing.id);
    const orgId = memberships[0]!.organizationId;
    const channels = await c.channels.list({ orgId });
    return { orgId, created: false, widgetKey: channels.find((ch) => ch.channel === 'webchat')?.publicKey ?? null };
  }
  const signup = await c.auth.signup({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    name: 'Demo Owner',
    organizationName: 'Bright Smile Dental',
    timezone: opts.timezone ?? 'America/Toronto',
  });
  const orgId = signup.organization.id;
  const scope = { orgId };
  await c.tenancy.updateOrganization(orgId, { settings: { notificationEmails: ['frontdesk@example.com'], defaultCountry: 'CA' } });

  await c.contacts.createFieldDef(scope, {
    key: 'service_interest',
    label: 'Service of interest',
    type: 'select',
    options: ['Cleaning', 'Whitening', 'Invisalign', 'Implants', 'Emergency', 'Other'],
    description: 'The treatment the person is asking about',
    aiWritable: true,
  });
  await c.contacts.createFieldDef(scope, {
    key: 'insurance_provider',
    label: 'Insurance provider',
    type: 'text',
    options: [],
    description: 'Dental insurance company, if they mention one',
    aiWritable: true,
  });
  for (const name of ['new-patient', 'existing-patient', 'invisalign', 'implants', 'emergency', 'price-shopper']) {
    await c.contacts.createTag(scope, { name });
  }

  const kbs = await c.knowledge.listKnowledgeBases(scope);
  const kbId = kbs[0]!.id;
  await c.knowledge.createFaqDocument(scope, kbId, {
    title: 'Frequently asked questions',
    category: 'faq',
    faq: [
      { question: 'What are your opening hours?', answer: 'Monday to Friday 9am–5pm, Saturday 10am–2pm by appointment. Closed Sundays and statutory holidays.' },
      { question: 'Where are you located?', answer: '123 Queen Street West, Suite 400, Toronto. Street parking and Osgoode subway station nearby.' },
      { question: 'Do you accept new patients?', answer: 'Yes, we welcome new patients of all ages. Your first visit includes an exam, cleaning and X-rays.' },
      { question: 'Do you direct-bill insurance?', answer: 'Yes, we direct-bill most major insurance providers including Sun Life, Manulife, Canada Life and Green Shield.' },
      { question: 'What should I do in a dental emergency?', answer: 'Call us at (416) 555-0123. We keep same-day emergency slots every weekday morning.' },
    ],
  });
  await c.knowledge.createTextDocument(scope, kbId, {
    title: 'Services and pricing',
    category: 'pricing',
    content: [
      '# Services and pricing',
      '## New patient exam',
      'Comprehensive exam, cleaning and full X-rays: $180. Most insurance plans cover this in full.',
      '## Teeth whitening',
      'In-office whitening (one 90-minute visit): $450. Take-home whitening kit with custom trays: $300.',
      '## Invisalign clear aligners',
      'Invisalign treatment ranges from $3,500 to $6,500 depending on complexity. Free consultation with 3D scan. Monthly payment plans from $150/month.',
      '## Dental implants',
      'Single implant including crown: from $4,200. Free implant consultation with CT scan review.',
    ].join('\n\n'),
  });
  await c.knowledge.createTextDocument(scope, kbId, {
    title: 'Policies',
    category: 'policies',
    content: [
      '# Cancellation policy',
      'Please give at least 24 hours notice to cancel or reschedule. Late cancellations and missed appointments are charged $75.',
      '# Payment',
      'We accept Visa, Mastercard, debit and e-transfer. Payment plans are available for treatments over $1,000 through our financing partner.',
    ].join('\n\n'),
  });

  const bots = await c.bots.list(scope);
  const bot = bots[0]!;
  await c.bots.update(scope, bot.id, {
    name: 'Website Assistant',
    config: {
      persona: {
        assistantName: 'Maya',
        companyName: 'Bright Smile Dental',
        role: 'patient coordinator',
        tone: 'friendly',
        responseLength: 'short',
        language: 'auto',
        useEmojis: false,
        greeting: "Hi, I'm Maya from Bright Smile Dental. How can I help you today?",
      },
      business: {
        description: 'Family and cosmetic dental clinic in downtown Toronto.',
        services: 'Check-ups and cleanings, whitening, Invisalign, implants, emergency dentistry.',
        hours: 'Mon–Fri 9am–5pm, Sat 10am–2pm by appointment',
        location: '123 Queen Street West, Suite 400, Toronto',
        website: 'https://brightsmile.example.com',
        phone: '(416) 555-0123',
        email: 'hello@brightsmile.example.com',
        extraFacts: '',
      },
      instructions:
        'When someone asks about Invisalign or implants, mention the free consultation. If someone describes severe pain, swelling or bleeding, treat it as an emergency: give the clinic phone number and offer the earliest slot.',
      leadCapture: {
        enabled: true,
        fields: [
          { field: 'name', required: true, timing: 'natural' },
          { field: 'phone', required: true, timing: 'before_booking' },
          { field: 'email', required: false, timing: 'natural' },
          { field: 'service_interest', required: false, timing: 'natural' },
        ],
        consentNotice: '',
      },
      qualification: {
        enabled: true,
        questions: [
          { key: 'treatment', question: 'Which treatment are you interested in?', type: 'select', options: ['Cleaning', 'Whitening', 'Invisalign', 'Implants', 'Emergency', 'Other'], required: true, saveToCustomField: 'service_interest' },
          { key: 'timeline', question: 'When would you like to start?', type: 'select', options: ['As soon as possible', 'Within a month', 'In 1-3 months', 'Just researching'], required: true, saveToCustomField: null },
          { key: 'insured', question: 'Do you have dental insurance?', type: 'boolean', options: [], required: false, saveToCustomField: null },
        ],
        rules: [
          { questionKey: 'treatment', operator: 'in', value: ['Invisalign', 'Implants'], points: 40, disqualify: false },
          { questionKey: 'treatment', operator: 'in', value: ['Cleaning', 'Whitening', 'Emergency'], points: 25, disqualify: false },
          { questionKey: 'timeline', operator: 'in', value: ['As soon as possible', 'Within a month'], points: 40, disqualify: false },
          { questionKey: 'timeline', operator: 'equals', value: 'In 1-3 months', points: 20, disqualify: false },
          { questionKey: 'insured', operator: 'equals', value: true, points: 10, disqualify: false },
        ],
        thresholds: { hot: 70, warm: 40 },
        qualifyAt: 45,
        onQualified: { tags: ['new-patient'], lifecycleStage: 'qualified', notifyTeam: true },
        onDisqualified: { tags: [], lifecycleStage: 'engaged', notifyTeam: false },
        qualifiedNextStep: 'offer_booking',
        disqualifiedMessage: '',
      },
      booking: {
        enabled: true,
        calendarId: (await c.scheduling.listCalendars(scope))[0]!.id,
        appointmentTitle: 'Consultation',
        requiredFields: ['name', 'phone'],
        requireQualification: false,
        allowReschedule: true,
        allowCancel: true,
      },
      actions: {
        disabledTools: [],
        allowedTags: ['new-patient', 'existing-patient', 'invisalign', 'implants', 'emergency', 'price-shopper'],
        allowCreateTags: false,
        workflowKeys: [],
      },
    },
  });

  // Saturday mornings too, and a 15-minute buffer between consultations.
  const calendar = (await c.scheduling.listCalendars(scope))[0]!;
  await c.scheduling.updateCalendar(scope, calendar.id, {
    name: 'Consultations',
    slotMinutes: 30,
    bufferMinutes: 15,
    minNoticeMinutes: 120,
    weeklyHours: { ...calendar.weeklyHours, sat: [{ start: '10:00', end: '14:00' }] },
  });

  const [webchat] = await c.db
    .select({ key: schema.channelAccounts.publicKey })
    .from(schema.channelAccounts)
    .where(and(eq(schema.channelAccounts.organizationId, orgId), eq(schema.channelAccounts.channel, 'webchat')));
  return { orgId, created: true, widgetKey: webchat?.key ?? null };
}
