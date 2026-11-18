/** Pure register helpers. Amounts stay in integer cents until display. */

export function parseBatchCount(input) {
  const text = String(input == null ? '' : input).trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error('Enter how many cards to make, from 1 to 25.');
  const count = Number(text);
  if (count > 25) throw new Error('Enter how many cards to make, from 1 to 25.');
  return count;
}

export function dollarsToCents(input) {
  if (typeof input !== 'string') throw new Error('Enter a dollar amount');
  const trimmed = input.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error('Enter dollars and cents, such as 25 or 25.50');
  }
  const parts = trimmed.split('.');
  const whole = parts[0];
  const fraction = parts[1] || '';
  if (whole.length > 1 && whole.charAt(0) === '0') {
    throw new Error('Enter dollars and cents, such as 25 or 25.50');
  }
  if (whole.length > 9) throw new Error('That amount is too large');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error('Enter an amount greater than zero');
  }
  return cents;
}

export function formatCents(cents) {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return '—';
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');
  return (negative ? '-$' : '$') + dollars.toLocaleString('en-US') + '.' + remainder;
}

export function normalizeCardNumber(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.indexOf('RH') === 0 ? raw.slice(2) : raw;
  const parts = [body.slice(0, 4), body.slice(4, 8), body.slice(8, 12)].filter(Boolean);
  if (!parts.length) return '';
  return 'RH-' + parts.join('-');
}

export function isCompleteCardNumber(value) {
  return /^RH-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value);
}

export function qrTokenFromScan(raw) {
  const value = String(raw || '').trim();
  const token = value.indexOf('rhgc:v1:') === 0 ? value.slice('rhgc:v1:'.length) : value;
  return /^[0-9a-f]{64}$/.test(token) ? token : '';
}

const ID_TOKEN_STORAGE_KEY = 'rhgc.google-id-token';
const ID_TOKEN_SKEW_MS = 60 * 1000;
const ID_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function idTokenExpiryMs(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[1]) return 0;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp <= 0) return 0;
    return exp * 1000;
  } catch (error) {
    return 0;
  }
}

export function rememberIdToken(storage, token) {
  try {
    storage.setItem(ID_TOKEN_STORAGE_KEY, token);
  } catch (error) {
    // Private browsing can refuse storage. The in-memory session still works.
  }
}

export function forgetIdToken(storage) {
  try {
    storage.removeItem(ID_TOKEN_STORAGE_KEY);
  } catch (error) {
    // Nothing stored to clear.
  }
}

export function readStoredIdToken(storage, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  let token = '';
  try {
    token = storage.getItem(ID_TOKEN_STORAGE_KEY) || '';
  } catch (error) {
    return '';
  }
  const exp = idTokenExpiryMs(token);
  if (!exp || exp <= now + ID_TOKEN_SKEW_MS) {
    forgetIdToken(storage);
    return '';
  }
  return token;
}

export function msUntilIdTokenRefresh(token, nowMs) {
  const exp = idTokenExpiryMs(token);
  if (!exp) return 0;
  return Math.max(0, exp - nowMs - ID_TOKEN_REFRESH_LEAD_MS);
}

export function newIdempotencyKey(prefix) {
  const uuid = globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  return (prefix + '-' + uuid).slice(0, 128);
}

export function todayReportFields(locationId, start) {
  const fields = { start: start };
  if (locationId) fields.locationId = locationId;
  return fields;
}

export function reloadTodayOnStoreChange(screen) {
  return screen === 'desk';
}

export function storeScopeFields(locationId) {
  if (!locationId) return {};
  return { locationId: locationId };
}

export function reloadCardsOnStoreChange(screen) {
  return screen === 'cards';
}

export function cardsForStore(cards, locationId) {
  if (!locationId) return cards;
  return cards.filter(function (card) {
    return card.issued_location_id === locationId;
  });
}

export function startOfZonedDayIso(timeZone, now) {
  const moment = now || new Date();
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(moment);
  const stamp = function (value) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(value);
  };
  let ms = moment.getTime();
  let guard = 0;
  while (stamp(new Date(ms)).slice(0, 10) === day && guard < 4000) {
    ms -= 60000;
    guard += 1;
  }
  ms += 60000;
  guard = 0;
  while (!stamp(new Date(ms)).endsWith('00:00') && guard < 4000) {
    ms -= 60000;
    guard += 1;
  }
  return new Date(ms).toISOString();
}
