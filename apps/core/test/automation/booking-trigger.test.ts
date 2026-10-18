import { describe, expect, it } from 'vitest';
import { triggerMatches } from '../../src/automation/goals';
import { TRIGGER_EVENTS } from '../../src/automation/graph';

const at = '2026-10-18T10:00:00.000Z';

describe('appointment_booked trigger', () => {
  it('listens to the event a public booking actually emits', () => {
    expect(TRIGGER_EVENTS.appointment_booked).toContain('appointment.booked');
    const booked = { id: 'e1', type: 'appointment.booked', occurredAt: at, payload: { contactId: 'c1', eventTypeId: 'et_1' } };
    expect(triggerMatches({ type: 'appointment_booked' }, booked)).toBe(true);
    expect(triggerMatches({ type: 'appointment_booked', event_type_ids: ['et_1'] }, booked)).toBe(true);
    expect(triggerMatches({ type: 'appointment_booked', event_type_ids: ['et_2'] }, booked)).toBe(false);
  });

  it('counts a booking once, even when CRM appointments are included', () => {
    const trigger = { type: 'appointment_booked' as const, include_crm_appointments: true };
    const created = (source: string) => ({
      id: `e_${source}`,
      type: 'appointment.created',
      occurredAt: at,
      payload: { appointmentId: 'a1', contactId: 'c1', ownerId: null, source },
    });
    expect(triggerMatches(trigger, created('manual'))).toBe(true);
    expect(triggerMatches(trigger, created('booking'))).toBe(false);
    expect(triggerMatches({ type: 'appointment_booked' }, created('manual'))).toBe(false);
  });
});
