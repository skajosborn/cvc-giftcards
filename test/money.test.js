const assert = require('assert');

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
  console.log('register helpers passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
