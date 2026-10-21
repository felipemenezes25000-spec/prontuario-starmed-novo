import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NOTIFICATION_PREFS, canNotify, mergeNotificationPrefs, normalizeNotificationPrefs, toNotificationPrefsResponse } from './portal';

// Portal do paciente (ST-P1-008) — só funções PURAS de preferências de
// notificação (migração 024): merge/validação do JSONB de notification_prefs,
// fallback de default e permissão de envio por canal. Nenhum teste toca banco.

test('normalizeNotificationPrefs falls back to the 024 defaults for null/garbage', () => {
  assert.deepEqual(normalizeNotificationPrefs(null), DEFAULT_NOTIFICATION_PREFS);
  assert.deepEqual(normalizeNotificationPrefs(undefined), DEFAULT_NOTIFICATION_PREFS);
  assert.deepEqual(normalizeNotificationPrefs('nope'), DEFAULT_NOTIFICATION_PREFS);
  assert.deepEqual(normalizeNotificationPrefs([1, 2]), DEFAULT_NOTIFICATION_PREFS);
  // Chave inválida volta ao default; chave booleana válida é preservada.
  assert.deepEqual(normalizeNotificationPrefs({ email: 'yes', sms: false }), { ...DEFAULT_NOTIFICATION_PREFS, sms: false });
});

test('mergeNotificationPrefs: partial patch preserves the rest (extra keys survive)', () => {
  const atual = { whatsapp: false, email: true, sms: true, marketing_opt_in: true, future_channel: 'keep-me' };
  const merged = mergeNotificationPrefs(atual, { sms: false });
  assert.equal(merged.sms, false);           // patch aplicado
  assert.equal(merged.whatsapp, false);      // resto preservado
  assert.equal(merged.marketing_opt_in, true);
  assert.equal((merged as unknown as Record<string, unknown>).future_channel, 'keep-me');
});

test('mergeNotificationPrefs: marketingOptIn normalizes to marketing_opt_in', () => {
  const merged = mergeNotificationPrefs(null, { marketingOptIn: true });
  assert.equal(merged.marketing_opt_in, true);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'marketingOptIn'), false);
  // Opt-in explícito pode ser revertido: marketingOptIn:false → false.
  assert.equal(mergeNotificationPrefs({ marketing_opt_in: true }, { marketingOptIn: false }).marketing_opt_in, false);
});

test('mergeNotificationPrefs: any service channel true→false is accepted (opt-out obrigatório)', () => {
  const merged = mergeNotificationPrefs({ whatsapp: true, email: true, sms: true, marketing_opt_in: false },
    { whatsapp: false, email: false, sms: false });
  assert.deepEqual([merged.whatsapp, merged.email, merged.sms], [false, false, false]);
});

test('mergeNotificationPrefs: non-boolean patch value throws', () => {
  assert.throws(() => mergeNotificationPrefs(null, { email: 'yes' } as unknown as { email?: unknown }),
    /deve ser verdadeira ou falsa/);
  assert.throws(() => mergeNotificationPrefs(null, { sms: 1 } as unknown as { sms?: unknown }),
    /deve ser verdadeira ou falsa/);
});

test('mergeNotificationPrefs: empty patch throws (controller vira 400)', () => {
  assert.throws(() => mergeNotificationPrefs({ whatsapp: true }, {}), /ao menos uma preferência/);
  // Chave só com valor undefined não conta como campo.
  assert.throws(() => mergeNotificationPrefs(null, { whatsapp: undefined }), /ao menos uma preferência/);
});

test('mergeNotificationPrefs: unknown key throws', () => {
  assert.throws(() => mergeNotificationPrefs(null, { push: true } as unknown as Parameters<typeof mergeNotificationPrefs>[1]),
    /desconhecida: push/);
});

test('canNotify: service channels follow the stored prefs with default ON', () => {
  assert.equal(canNotify(null, 'whatsapp'), true);   // default 024: serviço ligado
  assert.equal(canNotify({ whatsapp: false }, 'whatsapp'), false);
  assert.equal(canNotify({ whatsapp: false }, 'sms'), true); // canal não citado → default
  assert.equal(canNotify({ sms: 'nope' }, 'sms'), true);     // valor inválido → default
  assert.equal(canNotify({ marketing_opt_in: false }, 'email'), true); // marketing não é canal de serviço
});

test('toNotificationPrefsResponse exposes camelCase marketingOptIn', () => {
  assert.deepEqual(toNotificationPrefsResponse({ whatsapp: false, email: true, sms: true, marketing_opt_in: true }),
    { whatsapp: false, email: true, sms: true, marketingOptIn: true });
});
