/**
 * Reports read completed ledger rows. ISSUE is not treated as a sale.
 * VOIDED rows and VOID rows are excluded so a reversal is not counted twice.
 * Outstanding liability is reported from both the card rows and the ledger.
 */

function getGiftCardSalesReport(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN', 'MANAGER'], action: 'REPORT_SALES' });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var scope = rhReportScope_(ctx, actor, request);
    return rhBuildSalesReport_(ctx, scope);
  });
}

function getGiftCardRedemptionReport(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN', 'MANAGER'], action: 'REPORT_REDEMPTIONS' });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var scope = rhReportScope_(ctx, actor, request);
    return rhBuildRedemptionReport_(ctx, scope);
  });
}

function getOutstandingGiftCardBalance(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN', 'MANAGER'], action: 'REPORT_LIABILITY' });
  return rhWithLock_(function (ctx) {
    rhReloadActor_(ctx, actor);
    return rhOutstanding_(ctx);
  });
}

function detectBalanceMismatches(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN', 'MANAGER'], action: 'LEDGER_DETECT' });
  return rhWithLock_(function (ctx) {
    rhReloadActor_(ctx, actor);
    return rhDetectionReport_(ctx);
  });
}

function rhReportScope_(ctx, actor, request) {
  var start = rhOptionalIso_(request.start, 'start');
  var end = rhOptionalIso_(request.end, 'end');
  if (start && end && start >= end) throw rhFail_('VALIDATION', 'start must be before end');
  var locationId = '';
  if (actor.role === 'ADMIN') {
    if (request.locationId) locationId = rhRequireLocation_(ctx, request.locationId).location_id;
  } else if (actor.role === 'MANAGER') {
    if (!actor.location_id) throw rhFail_('FORBIDDEN', 'Access denied');
    if (request.locationId && request.locationId !== actor.location_id) {
      throw rhFail_('FORBIDDEN', 'Access denied');
    }
    locationId = actor.location_id;
  } else {
    throw rhFail_('FORBIDDEN', 'Access denied');
  }
  return { start: start, end: end, locationId: locationId };
}

function rhInWindow_(txn, start, end) {
  if (start && txn.created_at < start) return false;
  if (end && txn.created_at >= end) return false;
  return true;
}

function rhBuildSalesReport_(ctx, scope) {
  var txns = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  var byId = rhIndexById_(txns);
  var warnings = [];
  var totals = rhSaleBucket_();
  var byLocation = {};
  var byDay = {};
  var byEmployee = {};
  for (var i = 0; i < txns.length; i++) {
    var txn = txns[i];
    if (scope.locationId && txn.location_id !== scope.locationId) continue;
    if (!rhInWindow_(txn, scope.start, scope.end)) continue;
    var effect = rhSaleEffect_(txn, byId);
    if (effect === null) {
      warnings.push('A refund is missing its original transaction');
      continue;
    }
    var issued = txn.transaction_status === 'COMPLETED' && txn.transaction_type === 'ISSUE' ? 1 : 0;
    var activated = txn.transaction_status === 'COMPLETED' && txn.transaction_type === 'ACTIVATE' ? 1 : 0;
    if (!issued && !activated && effect === 0) continue;
    rhAddSale_(totals, issued, activated, effect);
    rhAddSale_(rhTakeBucket_(byLocation, txn.location_id, rhSaleBucket_), issued, activated, effect);
    rhAddSale_(rhTakeBucket_(byDay, rhReportDate_(txn.created_at), rhSaleBucket_), issued, activated, effect);
    rhAddSale_(rhTakeBucket_(byEmployee, txn.employee_id, rhSaleBucket_), issued, activated, effect);
  }
  return {
    money_unit: RH_MONEY_UNIT,
    location_id: scope.locationId,
    start: scope.start,
    end: scope.end,
    issued_count: totals.issued_count,
    activated_count: totals.activated_count,
    value_sold_cents: totals.value_sold_cents,
    by_location: rhSaleRows_(byLocation, 'location_id'),
    daily: rhSaleRows_(byDay, 'date'),
    employees: rhSaleRows_(byEmployee, 'employee_id'),
    warnings: warnings
  };
}

function rhBuildRedemptionReport_(ctx, scope) {
  var txns = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  var byId = rhIndexById_(txns);
  var warnings = [];
  var total = 0;
  var count = 0;
  var byLocation = {};
  var byDay = {};
  var byEmployee = {};
  for (var i = 0; i < txns.length; i++) {
    var txn = txns[i];
    if (scope.locationId && txn.location_id !== scope.locationId) continue;
    if (!rhInWindow_(txn, scope.start, scope.end)) continue;
    var effect = rhRedeemEffect_(txn, byId);
    if (effect === null) {
      warnings.push('A refund is missing its original transaction');
      continue;
    }
    if (effect === 0) continue;
    total = rhExactSum_(total, effect);
    count++;
    rhAddRedeem_(rhTakeBucket_(byLocation, txn.location_id, rhRedeemBucket_), effect);
    rhAddRedeem_(rhTakeBucket_(byDay, rhReportDate_(txn.created_at), rhRedeemBucket_), effect);
    rhAddRedeem_(rhTakeBucket_(byEmployee, txn.employee_id, rhRedeemBucket_), effect);
  }
  return {
    money_unit: RH_MONEY_UNIT,
    location_id: scope.locationId,
    start: scope.start,
    end: scope.end,
    value_redeemed_cents: total,
    redemption_count: count,
    by_location: rhRedeemRows_(byLocation, 'location_id'),
    daily: rhRedeemRows_(byDay, 'date'),
    employees: rhRedeemRows_(byEmployee, 'employee_id'),
    warnings: warnings
  };
}

function rhSaleEffect_(txn, byId) {
  if (txn.transaction_status !== 'COMPLETED') return 0;
  if (txn.transaction_type === 'ACTIVATE' || txn.transaction_type === 'RELOAD') return txn.amount_cents;
  if (txn.transaction_type !== 'REFUND') return 0;
  var related = byId[txn.related_transaction_id];
  if (!related) return null;
  if (related.transaction_type === 'ACTIVATE' || related.transaction_type === 'RELOAD') return -txn.amount_cents;
  return 0;
}

function rhRedeemEffect_(txn, byId) {
  if (txn.transaction_status !== 'COMPLETED') return 0;
  if (txn.transaction_type === 'REDEEM') return txn.amount_cents;
  if (txn.transaction_type !== 'REFUND') return 0;
  var related = byId[txn.related_transaction_id];
  if (!related) return null;
  if (related.transaction_type === 'REDEEM') return -txn.amount_cents;
  return 0;
}

function rhOutstanding_(ctx) {
  var detection = rhDetectionReport_(ctx);
  var cards = rhReadSheet_(ctx, RH_SHEET.GIFT_CARDS).records;
  var activeBalance = 0;
  var suspendedBalance = 0;
  var activeCount = 0;
  var suspendedCount = 0;
  var stray = 0;
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    if (card.status === 'ACTIVE') {
      activeCount++;
      activeBalance = rhExactSum_(activeBalance, card.current_balance);
    } else if (card.status === 'SUSPENDED') {
      suspendedCount++;
      suspendedBalance = rhExactSum_(suspendedBalance, card.current_balance);
    } else if (card.current_balance !== 0) {
      stray = rhExactSum_(stray, card.current_balance);
    }
  }
  return {
    money_unit: RH_MONEY_UNIT,
    outstanding_liability_cents: rhExactSum_(activeBalance, suspendedBalance),
    active_balance_cents: activeBalance,
    suspended_balance_cents: suspendedBalance,
    active_card_count: activeCount,
    suspended_card_count: suspendedCount,
    stray_balance_cents: stray,
    computed_from_transactions_cents: detection.computed_from_transactions_cents,
    in_sync: detection.in_sync && stray === 0,
    mismatch_count: detection.mismatch_count,
    pending_count: detection.pending.length
  };
}

function rhDetectionReport_(ctx) {
  var cards = rhReadSheet_(ctx, RH_SHEET.GIFT_CARDS).records;
  var txns = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  var problems = [];
  var pending = [];
  var computed = 0;
  for (var i = 0; i < cards.length; i++) {
    var inspection = rhInspectCard_(cards[i], txns);
    computed = rhExactSum_(computed, inspection.economic);
    for (var p = 0; p < inspection.pending.length; p++) {
      pending.push({
        transaction_id: inspection.pending[p].transaction_id,
        card_id: inspection.pending[p].card_id,
        transaction_type: inspection.pending[p].transaction_type,
        created_at: inspection.pending[p].created_at
      });
    }
    if (inspection.issues.length) {
      problems.push({
        card_id: cards[i].card_id,
        card_number: cards[i].card_number,
        status: cards[i].status,
        current_balance: cards[i].current_balance,
        computed_balance: inspection.economic,
        issues: inspection.issues
      });
    }
  }
  return {
    money_unit: RH_MONEY_UNIT,
    in_sync: problems.length === 0 && pending.length === 0,
    mismatch_count: problems.length,
    computed_from_transactions_cents: computed,
    cards: problems,
    pending: pending
  };
}

function rhInspectCard_(card, txns) {
  var relevant = [];
  var pending = [];
  for (var i = 0; i < txns.length; i++) {
    if (txns[i].card_id !== card.card_id) continue;
    relevant.push(txns[i]);
    if (txns[i].transaction_status === 'PENDING') pending.push(txns[i]);
  }
  relevant.sort(function (a, b) { return a._row - b._row; });
  var issues = [];
  if (!relevant.length) issues.push('MISSING_LEDGER');
  var expected = 0;
  var economic = 0;
  for (var r = 0; r < relevant.length; r++) {
    var txn = relevant[r];
    economic = rhExactSum_(economic, rhEconomicDelta_(txn));
    if (txn.transaction_status === 'FAILED' || txn.transaction_status === 'PENDING') continue;
    if (txn.balance_before_cents !== expected) issues.push('CHAIN_BREAK');
    expected = txn.balance_after_cents;
  }
  if (relevant.length && expected !== card.current_balance) issues.push('CHAIN_END_MISMATCH');
  if (economic !== card.current_balance) issues.push('BALANCE_MISMATCH');
  if (economic < 0) issues.push('NEGATIVE_LEDGER');
  if (card.status === 'PENDING' && card.current_balance !== 0) issues.push('PENDING_NONEMPTY');
  if (card.status === 'DEPLETED' && card.current_balance !== 0) issues.push('DEPLETED_NONEMPTY');
  if (card.status === 'CANCELLED' && card.current_balance !== 0) issues.push('CANCELLED_NONEMPTY');
  return { issues: issues, pending: pending, economic: economic, chainEnd: expected };
}

function rhEconomicDelta_(txn) {
  if (txn.transaction_status !== 'COMPLETED') return 0;
  if (txn.transaction_type === 'VOID') return 0;
  return txn.balance_after_cents - txn.balance_before_cents;
}

function rhIndexById_(records) {
  var byId = {};
  for (var i = 0; i < records.length; i++) byId[records[i].transaction_id] = records[i];
  return byId;
}

function rhSaleBucket_() {
  return { issued_count: 0, activated_count: 0, value_sold_cents: 0 };
}

function rhRedeemBucket_() {
  return { value_redeemed_cents: 0, transaction_count: 0 };
}

function rhTakeBucket_(map, key, factory) {
  if (!map[key]) map[key] = factory();
  return map[key];
}

function rhAddSale_(bucket, issued, activated, effect) {
  bucket.issued_count += issued;
  bucket.activated_count += activated;
  bucket.value_sold_cents = rhExactSum_(bucket.value_sold_cents, effect);
}

function rhAddRedeem_(bucket, effect) {
  bucket.transaction_count++;
  bucket.value_redeemed_cents = rhExactSum_(bucket.value_redeemed_cents, effect);
}

function rhSaleRows_(map, keyName) {
  var keys = Object.keys(map).sort();
  var rows = [];
  for (var i = 0; i < keys.length; i++) {
    rows.push({
      issued_count: map[keys[i]].issued_count,
      activated_count: map[keys[i]].activated_count,
      value_sold_cents: map[keys[i]].value_sold_cents
    });
    rows[rows.length - 1][keyName] = keys[i];
  }
  return rows;
}

function rhRedeemRows_(map, keyName) {
  var keys = Object.keys(map).sort();
  var rows = [];
  for (var i = 0; i < keys.length; i++) {
    var row = {
      value_redeemed_cents: map[keys[i]].value_redeemed_cents,
      transaction_count: map[keys[i]].transaction_count
    };
    row[keyName] = keys[i];
    rows.push(row);
  }
  return rows;
}
