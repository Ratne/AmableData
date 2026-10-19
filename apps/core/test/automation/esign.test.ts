import { describe, expect, it } from 'vitest';
import { triggerMatches } from '../../src/automation/goals';
import { TRIGGER_EVENTS } from '../../src/automation/graph';
import { validateGraph, type EsignTemplateCatalog } from '../../src/automation/validate';
import { createEngineHarness, edge, goal, graph, seq, type EngineHarness } from './helpers';

const at = '2026-10-18T10:00:00.000Z';
const SHA = 'a'.repeat(64);

function activeTemplate(h: EngineHarness, parties: string[]): string {
  const created = h.tenant.op('esign.templates.create', {
    data: { name: 'Contratto', parties: parties.map((id) => ({ id, name: id })) },
  });
  h.tenant.op('esign.templates.setSource', {
    id: created.id,
    r2_key: 'k/source.pdf',
    filename: 'contratto.pdf',
    size: 1000,
    sha256: SHA,
    pages: [{ width: 595, height: 842 }],
  });
  h.tenant.op('esign.templates.setPageImage', {
    id: created.id,
    page: 0,
    image_key: 'k/page-0.png',
    image_type: 'image/png',
    source_sha256: SHA,
  });
  h.tenant.op('esign.templates.update', {
    id: created.id,
    data: {
      status: 'active',
      fields: parties.map((party, i) => ({
        id: `sig_${party}`,
        type: 'signature',
        party_id: party,
        page: 0,
        x: 0.1,
        y: 0.1 + i * 0.2,
        w: 0.3,
        h: 0.06,
      })),
    },
  });
  return created.id;
}

describe('document triggers', () => {
  const event = (type: string, templateId: string) => ({
    id: `e_${type}`,
    type,
    occurredAt: at,
    payload: { requestId: 'r1', templateId, signerId: 's1', contactId: 'c1', partyId: 'client' },
  });

  it('listen to completed and declined requests, optionally per template', () => {
    expect(TRIGGER_EVENTS.document_completed).toEqual(['esign.request_completed']);
    expect(TRIGGER_EVENTS.document_declined).toEqual(['esign.request_declined']);
    const completed = event('esign.request_completed', 'tpl_1');
    expect(triggerMatches({ type: 'document_completed' }, completed)).toBe(true);
    expect(triggerMatches({ type: 'document_completed', template_ids: ['tpl_1'] }, completed)).toBe(
      true,
    );
    expect(triggerMatches({ type: 'document_completed', template_ids: ['tpl_2'] }, completed)).toBe(
      false,
    );
    expect(
      triggerMatches(
        { type: 'document_declined', template_ids: ['tpl_1'] },
        event('esign.request_declined', 'tpl_1'),
      ),
    ).toBe(true);
  });
});

describe('send_signature_request validation', () => {
  const catalog: EsignTemplateCatalog = {
    tpl_two: { parties: ['client', 'agency'], sendable: true },
    tpl_draft: { parties: ['client'], sendable: false },
  };
  const issues = (step: Record<string, unknown>) =>
    validateGraph(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: ['t1'] }]),
          seq('s', [{ id: 'sign', type: 'send_signature_request', ...step } as never]),
        ],
        [edge('g', 's')],
      ),
      {},
      { automationId: 'a1', lookup: () => null, esignTemplates: catalog },
    ).issues.map((i) => `${i.severity}:${i.code}`);

  it('checks the template and that every party has a signer', () => {
    expect(issues({ template_id: 'missing' })).toContain('error:unknown_signature_template');
    expect(issues({ template_id: 'tpl_two' })).toContain('error:signature_parties_missing');
    expect(issues({ template_id: 'tpl_two', party_id: 'nope' })).toContain(
      'error:unknown_signature_party',
    );
    expect(
      issues({ template_id: 'tpl_two', others: [{ party_id: 'client', email: 'a@b.example' }] }),
    ).toContain('error:invalid_signature_party');
    expect(
      issues({
        template_id: 'tpl_two',
        others: [{ party_id: 'agency', email: 'anna@agency.example' }],
      }).filter((i) => i.includes('signature')),
    ).toEqual([]);
    expect(issues({ template_id: 'tpl_draft' })).toEqual(['warning:signature_template_inactive']);
  });
});

describe('send_signature_request step', () => {
  it('sends one request per enrollment to the contact and the fixed parties', async () => {
    const h = createEngineHarness();
    const templateId = activeTemplate(h, ['client', 'agency']);
    const t = h.tag('Contract');
    await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'sign',
              type: 'send_signature_request',
              template_id: templateId,
              party_id: 'client',
              others: [{ party_id: 'agency', email: 'anna@agency.example', name: 'Anna' }],
              message: 'Firma qui',
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact('Ada');
    h.loseResponse('automation.once', 1);
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    await h.advance(60 * 60 * 1000);

    const requests = h.tenant.op('esign.requests.list', { limit: 50 }).data;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      template_id: templateId,
      origin: 'automation',
      status: 'sent',
    });
    const detail = h.tenant.op('esign.requests.detail', { id: requests[0]!.id });
    expect(detail.signers.map((s) => [s.party_id, s.email, s.contact_id])).toEqual([
      ['client', expect.stringMatching(/^ada\d+@example\.com$/), ada],
      ['agency', 'anna@agency.example', expect.any(String)],
    ]);
    expect(detail.signers[1]?.contact_id).not.toBe(ada);
    expect(h.db.all(`SELECT status FROM eng_enrollments`)).toEqual([{ status: 'completed' }]);
  });
});
