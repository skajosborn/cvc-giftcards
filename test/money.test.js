const assert = require('assert');

function memoryStorage() {
  const data = {};
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return part({ alg: 'RS256', typ: 'JWT' }) + '.' + part(payload) + '.signature';
}

async function main() {
  const register = await import('../web/src/register.js');
  assert.strictEqual(register.parseBatchCount('3'), 3);
  assert.strictEqual(register.parseBatchCount('25'), 25);
  assert.throws(() => register.parseBatchCount('0'), /1 to 25/);
  assert.throws(() => register.parseBatchCount('26'), /1 to 25/);
  assert.throws(() => register.parseBatchCount('2.5'), /1 to 25/);
  assert.strictEqual(register.dollarsToCents('25'), 2500);
  assert.strictEqual(register.dollarsToCents('25.50'), 2550);
  assert.strictEqual(register.dollarsToCents('$0.01'), 1);
  assert.strictEqual(register.dollarsToCents('10.5'), 1050);
  assert.throws(() => register.dollarsToCents('25.555'), /dollars and cents/);
  assert.throws(() => register.dollarsToCents('0'), /greater than zero/);
  assert.throws(() => register.dollarsToCents(''), /dollars and cents/);
  assert.strictEqual(register.formatCents(2500), '$25.00');
  assert.strictEqual(register.formatCents(5), '$0.05');
  assert.strictEqual(register.formatCents(0), '$0.00');
  assert.strictEqual(register.normalizeCardNumber('rh abcd efgh jklm'), 'RH-ABCD-EFGH-JKLM');
  assert.strictEqual(register.isCompleteCardNumber('RH-ABCD-EFGH-JKLM'), true);
  assert.strictEqual(register.isCompleteCardNumber('RH-ABCD'), false);
  const token = 'a'.repeat(64);
  assert.strictEqual(register.qrTokenFromScan('rhgc:v1:' + token), token);
  assert.strictEqual(register.qrTokenFromScan('not-a-token'), '');
  const start = register.startOfZonedDayIso('America/Chicago', new Date('2026-11-06T15:00:00.000Z'));
  assert.match(start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const shown = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(start));
  assert.ok(shown.endsWith('00:00'), shown);
  const startOfDay = '2026-11-18T06:00:00.000Z';
  assert.deepStrictEqual(register.todayReportFields('cafe-id', startOfDay), {
    start: startOfDay,
    locationId: 'cafe-id'
  });
  assert.deepStrictEqual(register.todayReportFields('', startOfDay), { start: startOfDay });
  assert.strictEqual(register.reloadTodayOnStoreChange('desk'), true);
  assert.strictEqual(register.reloadTodayOnStoreChange('home'), false);
  assert.strictEqual(register.reloadTodayOnStoreChange('cards'), false);
  assert.deepStrictEqual(register.storeScopeFields('cafe-id'), { locationId: 'cafe-id' });
  assert.deepStrictEqual(register.storeScopeFields(''), {});
  assert.strictEqual(register.reloadCardsOnStoreChange('cards'), true);
  assert.strictEqual(register.reloadCardsOnStoreChange('desk'), false);
  const thriftCard = { issued_location_id: 'thrift', card_number: 'A' };
  const cafeCard = { issued_location_id: 'cafe', card_number: 'B' };
  assert.deepStrictEqual(register.cardsForStore([thriftCard, cafeCard], 'thrift'), [thriftCard]);
  assert.deepStrictEqual(register.cardsForStore([thriftCard, cafeCard], ''), [thriftCard, cafeCard]);
  const kept = register.keepCardQr(
    { card_id: '1', qr_payload: 'rhgc:v1:abc', qr_token: 'abc' },
    { card_id: '1', current_balance: 1500 }
  );
  assert.strictEqual(kept.qr_payload, 'rhgc:v1:abc');
  assert.strictEqual(kept.qr_token, 'abc');
  assert.strictEqual(kept.current_balance, 1500);
  assert.strictEqual(register.keepCardQr(
    { card_id: '1', qr_payload: 'rhgc:v1:abc' },
    { card_id: '2', current_balance: 1500 }
  ).qr_payload, undefined);
  assert.strictEqual(register.keepCardQr(
    { card_id: '1', qr_payload: 'old' },
    { card_id: '1', qr_payload: 'new' }
  ).qr_payload, 'new');
  const storage = memoryStorage();
  const future = jwt({ exp: 2_000 });
  register.rememberIdToken(storage, future);
  assert.strictEqual(register.readStoredIdToken(storage, 1_000_000), future);
  const almostExpired = jwt({ exp: 1_050 });
  register.rememberIdToken(storage, almostExpired);
  assert.strictEqual(register.readStoredIdToken(storage, 1_000_000), '');
  assert.strictEqual(storage.getItem('rhgc.google-id-token'), null);
  register.rememberIdToken(storage, 'not-a-token');
  assert.strictEqual(register.readStoredIdToken(storage, 1_000_000), '');
  register.forgetIdToken(storage);
  assert.strictEqual(register.readStoredIdToken(storage, 1_000_000), '');
  assert.strictEqual(register.msUntilIdTokenRefresh(future, 1_000_000), 700_000);
  assert.strictEqual(register.msUntilIdTokenRefresh(future, 1_800_000), 0);
  assert.strictEqual(register.msUntilIdTokenRefresh('not-a-token', 1_000_000), null);
  console.log('register helpers passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
