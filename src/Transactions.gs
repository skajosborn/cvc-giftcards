/**
 * Append-only financial ledger.
 *
 * A balance change writes a PENDING transaction first, then the card, then
 * marks the transaction COMPLETED. Those are separate spreadsheet writes.
 * repairUnambiguousPendingTransactions resolves only the cases where the
 * latest card row still matches one of the two expected states. Anything
 * else stays pending for a person to review.
 *
 * Completed amount columns are never edited. Voiding a completed transaction
 * appends a VOID row and changes only the original status to VOIDED.
 */

function redeemGiftCard(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'GIFT_CARD_REDEEM'
  });
  return rhWithLock_(function (ctx) {
    return rhBalanceChangeLocked_(ctx, actor, request, 'REDEEM');
  });
}

function reloadGiftCard(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'GIFT_CARD_RELOAD'
  });
  return rhWithLock_(function (ctx) {
    return rhBalanceChangeLocked_(ctx, actor, request, 'RELOAD');
  });
}

function refundGiftCardTransaction(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER'],
    action: 'GIFT_CARD_REFUND'
  });
  return rhWithLock_(function (ctx) {
    return rhRefundLocked_(ctx, actor, request);
  });
}

function voidGiftCardTransaction(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN'], action: 'GIFT_CARD_VOID' });
  return rhWithLock_(function (ctx) {
    return rhVoidLocked_(ctx, actor, request);
  });
}

function adjustGiftCardBalance(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN'], action: 'GIFT_CARD_ADJUST' });
  return rhWithLock_(function (ctx) {
    return rhAdjustLocked_(ctx, actor, request);
  });
}

function getTransactionHistory(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'TRANSACTION_HISTORY'
  });
  return rhWithLock_(function (ctx) {
    rhReloadActor_(ctx, actor);
    var card = rhFindCard_(ctx, request);
    return {
      money_unit: RH_MONEY_UNIT,
      card_id: card.card_id,
      transactions: rhTransactionsForCard_(ctx, card.card_id)
    };
  });
}

function getLocationTransactions(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER'],
    action: 'LOCATION_TRANSACTIONS'
  });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var scope = rhReportScope_(ctx, actor, request);
    if (!scope.locationId) throw rhFail_('VALIDATION', 'locationId is required');
    var limit = rhOptionalLimit_(request.limit);
    var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
    var selected = [];
    for (var i = 0; i < records.length; i++) {
      if (records[i].location_id !== scope.locationId) continue;
      if (!rhInWindow_(records[i], scope.start, scope.end)) continue;
      selected.push(records[i]);
    }
    selected.sort(function (a, b) { return b._row - a._row; });
    var page = [];
    for (var p = 0; p < selected.length && p < limit; p++) page.push(rhPublicTxn_(selected[p]));
    return {
      money_unit: RH_MONEY_UNIT,
      location_id: scope.locationId,
      transactions: page
    };
  });
}

function repairUnambiguousPendingTransactions(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN'], action: 'LEDGER_REPAIR' });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var outcome = rhRepairAllPending_(ctx);
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'PENDING_REPAIRED',
      entity_type: 'LEDGER',
      entity_id: '',
      details: {
        repaired_count: outcome.repaired.length,
        ambiguous_count: outcome.ambiguous.length
      }
    });
    return outcome;
  });
}

function restoreCardBalanceFromLedger(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN'], action: 'BALANCE_RESTORE' });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var card = rhRequireCardById_(ctx, rhRequireUuid_(request.cardId, 'cardId'));
    var txns = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
    var inspection = rhInspectCard_(card, txns);
    if (inspection.pending.length) {
      throw rhFail_('PARTIAL_FAILURE', 'Resolve pending transactions before restoring this balance');
    }
    if (inspection.issues.indexOf('CHAIN_BREAK') !== -1 || inspection.economic < 0) {
      throw rhFail_('RECONCILIATION', 'The ledger chain is not safe to restore automatically');
    }
    if (inspection.economic !== inspection.chainEnd) {
      throw rhFail_('RECONCILIATION', 'The ledger chain is not safe to restore automatically');
    }
    if (card.status === 'PENDING' || card.status === 'CANCELLED') {
      throw rhFail_('INVALID_STATE', 'This gift card status cannot be restored automatically');
    }
    if (inspection.economic === card.current_balance) {
      return { changed: false, card: rhPublicCard_(card, actor, 'staff') };
    }
    var status = card.status === 'SUSPENDED'
      ? 'SUSPENDED'
      : (inspection.economic === 0 ? 'DEPLETED' : 'ACTIVE');
    var updated = rhUpdateRecord_(ctx, RH_SHEET.GIFT_CARDS, card._row, card, {
      current_balance: inspection.economic,
      status: status,
      updated_at: rhNowIso_()
    });
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'BALANCE_RESTORED',
      entity_type: 'GIFT_CARD',
      entity_id: card.card_id,
      details: {
        card_number: card.card_number,
        balance_before: card.current_balance,
        balance_after: inspection.economic,
        status_before: card.status,
        status_after: status
      }
    });
    return { changed: true, card: rhPublicCard_(updated, actor, 'staff') };
  });
}

function rhBalanceChangeLocked_(ctx, actor, request, type) {
  actor = rhReloadActor_(ctx, actor);
  var location = rhResolveLocation_(ctx, actor, request.locationId);
  var amount = rhRequireCents_(request.amountCents, 'amountCents');
  if (type === 'RELOAD' && request.paymentConfirmed !== true) {
    throw rhFail_('VALIDATION', 'Reloads require paymentConfirmed to be true');
  }
  var card = rhFindCard_(ctx, request);
  var notes = rhOptionalNotes_(request.notes);
  var registerReference = rhOptionalReference_(request.registerReference);
  var idempotencyKey = rhRequireIdempotencyKey_(request.idempotencyKey);
  var requestHash = rhRequestHash_({
    op: type,
    cardId: card.card_id,
    amountCents: amount,
    locationId: location.location_id,
    paymentConfirmed: type === 'RELOAD' ? true : false,
    notes: notes,
    registerReference: registerReference
  });
  var gate = rhBeginIdempotent_(ctx, idempotencyKey, requestHash);
  if (gate.mode === 'replay') return rhReplayResult_(ctx, gate.transaction, actor);
  card = rhRequireCardById_(ctx, card.card_id);
  rhAssertNoPending_(ctx, card.card_id);
  var balanceAfter = rhNextBalance_(card, type, amount);
  var statusAfter = rhStatusForBalance_(card.status, balanceAfter);
  rhAssertAllowedStatus_(card, type);
  var posted = rhCommitMoney_(ctx, {
    actor: actor,
    card: card,
    location: location,
    type: type,
    amountCents: amount,
    balanceBefore: card.current_balance,
    balanceAfter: balanceAfter,
    statusBefore: card.status,
    statusAfter: statusAfter,
    idempotencyKey: idempotencyKey,
    requestHash: requestHash,
    notes: notes,
    registerReference: registerReference,
    metadata: { payment_confirmed: type === 'RELOAD' }
  });
  rhAudit_(ctx, {
    employee_id: actor.employee_id,
    action: type === 'REDEEM' ? 'GIFT_CARD_REDEEMED' : 'GIFT_CARD_RELOADED',
    entity_type: 'GIFT_CARD',
    entity_id: card.card_id,
    details: {
      card_number: card.card_number,
      amount_cents: amount,
      location_id: location.location_id,
      transaction_id: posted.transaction.transaction_id
    }
  });
  return rhPostedResult_(posted, actor, false);
}

function rhRefundLocked_(ctx, actor, request) {
  actor = rhReloadActor_(ctx, actor);
  var location = rhResolveLocation_(ctx, actor, request.locationId);
  var amount = rhRequireCents_(request.amountCents, 'amountCents');
  var original = rhRequireSingle_(
    rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', rhRequireUuid_(request.transactionId, 'transactionId')),
    'Transaction was not found'
  );
  var notes = rhOptionalNotes_(request.notes);
  var registerReference = rhOptionalReference_(request.registerReference);
  var idempotencyKey = rhRequireIdempotencyKey_(request.idempotencyKey);
  var requestHash = rhRequestHash_({
    op: 'REFUND',
    transactionId: original.transaction_id,
    amountCents: amount,
    locationId: location.location_id,
    notes: notes,
    registerReference: registerReference
  });
  var gate = rhBeginIdempotent_(ctx, idempotencyKey, requestHash);
  if (gate.mode === 'replay') return rhReplayResult_(ctx, gate.transaction, actor);
  original = rhRequireSingle_(
    rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', original.transaction_id),
    'Transaction was not found'
  );
  rhAssertNoPending_(ctx, original.card_id);
  if (original.transaction_status !== 'COMPLETED') {
    throw rhFail_('INVALID_STATE', 'Only a completed transaction can be refunded');
  }
  if (['REDEEM', 'ACTIVATE', 'RELOAD'].indexOf(original.transaction_type) === -1) {
    throw rhFail_('INVALID_STATE', 'This transaction cannot be refunded');
  }
  var already = rhCompletedRefundTotal_(ctx, original.transaction_id);
  if (amount > original.amount_cents - already) {
    throw rhFail_('VALIDATION', 'Refund exceeds the remaining amount on the original transaction');
  }
  var card = rhRequireCardById_(ctx, original.card_id);
  if (request.cardId && rhRequireUuid_(request.cardId, 'cardId') !== card.card_id) {
    throw rhFail_('VALIDATION', 'The card identifiers do not match');
  }
  rhAssertCardAcceptsMoney_(card);
  var crediting = original.transaction_type === 'REDEEM';
  var balanceAfter = rhAddCents_(card.current_balance, crediting ? amount : -amount);
  rhAssertBalanceCap_(balanceAfter);
  var statusAfter = rhStatusForBalance_(card.status, balanceAfter);
  var posted = rhCommitMoney_(ctx, {
    actor: actor,
    card: card,
    location: location,
    type: 'REFUND',
    amountCents: amount,
    balanceBefore: card.current_balance,
    balanceAfter: balanceAfter,
    statusBefore: card.status,
    statusAfter: statusAfter,
    idempotencyKey: idempotencyKey,
    requestHash: requestHash,
    notes: notes,
    registerReference: registerReference,
    relatedTransactionId: original.transaction_id,
    metadata: { related_type: original.transaction_type }
  });
  rhAudit_(ctx, {
    employee_id: actor.employee_id,
    action: 'GIFT_CARD_REFUNDED',
    entity_type: 'TRANSACTION',
    entity_id: original.transaction_id,
    details: {
      card_id: card.card_id,
      amount_cents: amount,
      refund_transaction_id: posted.transaction.transaction_id,
      location_id: location.location_id
    }
  });
  return rhPostedResult_(posted, actor, false);
}

function rhVoidLocked_(ctx, actor, request) {
  actor = rhReloadActor_(ctx, actor);
  var location = rhResolveLocation_(ctx, actor, request.locationId);
  var original = rhRequireSingle_(
    rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', rhRequireUuid_(request.transactionId, 'transactionId')),
    'Transaction was not found'
  );
  var notes = rhRequireNotes_(request.notes);
  var idempotencyKey = rhRequireIdempotencyKey_(request.idempotencyKey);
  var requestHash = rhRequestHash_({
    op: 'VOID',
    transactionId: original.transaction_id,
    locationId: location.location_id,
    notes: notes
  });
  var gate = rhBeginIdempotent_(ctx, idempotencyKey, requestHash);
  if (gate.mode === 'replay') return rhReplayResult_(ctx, gate.transaction, actor);
  original = rhRequireSingle_(
    rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', original.transaction_id),
    'Transaction was not found'
  );
  rhAssertNoPending_(ctx, original.card_id);
  if (original.transaction_status !== 'COMPLETED') {
    throw rhFail_('INVALID_STATE', 'Only a completed transaction can be voided');
  }
  if (['ACTIVATE', 'REDEEM', 'RELOAD', 'REFUND', 'ADJUSTMENT'].indexOf(original.transaction_type) === -1) {
    throw rhFail_('INVALID_STATE', 'This transaction cannot be voided');
  }
  rhAssertNoReversal_(ctx, original.transaction_id);
  rhAssertNoRefund_(ctx, original.transaction_id);
  var card = rhRequireCardById_(ctx, original.card_id);
  rhAssertCardAcceptsMoney_(card);
  var delta = original.balance_after_cents - original.balance_before_cents;
  var balanceAfter = rhAddCents_(card.current_balance, -delta);
  rhAssertBalanceCap_(balanceAfter);
  var statusAfter = rhStatusForBalance_(card.status, balanceAfter);
  if (card.status !== 'SUSPENDED' && original.transaction_type === 'ACTIVATE' && balanceAfter === 0) {
    statusAfter = 'CANCELLED';
  }
  var posted = rhCommitMoney_(ctx, {
    actor: actor,
    card: card,
    location: location,
    type: 'VOID',
    amountCents: original.amount_cents,
    balanceBefore: card.current_balance,
    balanceAfter: balanceAfter,
    statusBefore: card.status,
    statusAfter: statusAfter,
    idempotencyKey: idempotencyKey,
    requestHash: requestHash,
    notes: notes,
    relatedTransactionId: original.transaction_id,
    voidOriginal: original,
    metadata: { related_type: original.transaction_type }
  });
  rhAudit_(ctx, {
    employee_id: actor.employee_id,
    action: 'GIFT_CARD_VOIDED',
    entity_type: 'TRANSACTION',
    entity_id: original.transaction_id,
    details: {
      card_id: card.card_id,
      void_transaction_id: posted.transaction.transaction_id,
      amount_cents: original.amount_cents
    }
  });
  return rhPostedResult_(posted, actor, false);
}

function rhAdjustLocked_(ctx, actor, request) {
  actor = rhReloadActor_(ctx, actor);
  var location = rhResolveLocation_(ctx, actor, request.locationId);
  var amount = rhRequireCents_(request.amountCents, 'amountCents');
  var direction = rhRequireEnum_(request.direction, ['CREDIT', 'DEBIT'], 'direction');
  var card = rhFindCard_(ctx, request);
  var notes = rhRequireNotes_(request.notes);
  var idempotencyKey = rhRequireIdempotencyKey_(request.idempotencyKey);
  var requestHash = rhRequestHash_({
    op: 'ADJUSTMENT',
    cardId: card.card_id,
    amountCents: amount,
    direction: direction,
    locationId: location.location_id,
    notes: notes
  });
  var gate = rhBeginIdempotent_(ctx, idempotencyKey, requestHash);
  if (gate.mode === 'replay') return rhReplayResult_(ctx, gate.transaction, actor);
  card = rhRequireCardById_(ctx, card.card_id);
  rhAssertNoPending_(ctx, card.card_id);
  rhAssertCardAcceptsMoney_(card);
  var balanceAfter = rhAddCents_(card.current_balance, direction === 'CREDIT' ? amount : -amount);
  rhAssertBalanceCap_(balanceAfter);
  var statusAfter = rhStatusForBalance_(card.status, balanceAfter);
  var posted = rhCommitMoney_(ctx, {
    actor: actor,
    card: card,
    location: location,
    type: 'ADJUSTMENT',
    amountCents: amount,
    balanceBefore: card.current_balance,
    balanceAfter: balanceAfter,
    statusBefore: card.status,
    statusAfter: statusAfter,
    idempotencyKey: idempotencyKey,
    requestHash: requestHash,
    notes: notes,
    metadata: { direction: direction }
  });
  rhAudit_(ctx, {
    employee_id: actor.employee_id,
    action: 'GIFT_CARD_ADJUSTED',
    entity_type: 'GIFT_CARD',
    entity_id: card.card_id,
    details: {
      card_number: card.card_number,
      direction: direction,
      amount_cents: amount,
      transaction_id: posted.transaction.transaction_id
    }
  });
  return rhPostedResult_(posted, actor, false);
}

function rhNextBalance_(card, type, amount) {
  if (type === 'REDEEM') return rhAddCents_(card.current_balance, -amount);
  if (type === 'RELOAD') {
    var reloaded = rhAddCents_(card.current_balance, amount);
    rhAssertBalanceCap_(reloaded);
    return reloaded;
  }
  throw rhFail_('VALIDATION', 'Unsupported balance change');
}

function rhAssertAllowedStatus_(card, type) {
  if (type === 'REDEEM' && card.status !== 'ACTIVE') {
    throw rhFail_('INVALID_STATE', 'Only an active gift card can be redeemed');
  }
  if (type === 'RELOAD' && card.status !== 'ACTIVE' && card.status !== 'DEPLETED') {
    throw rhFail_('INVALID_STATE', 'Only an active or depleted gift card can be reloaded');
  }
}

function rhAssertCardAcceptsMoney_(card) {
  if (['ACTIVE', 'DEPLETED', 'SUSPENDED'].indexOf(card.status) === -1) {
    throw rhFail_('INVALID_STATE', 'The gift card cannot accept this balance change');
  }
}

function rhStatusForBalance_(currentStatus, balance) {
  if (currentStatus === 'SUSPENDED') return 'SUSPENDED';
  if (currentStatus === 'PENDING' || currentStatus === 'CANCELLED') {
    throw rhFail_('INVALID_STATE', 'The gift card cannot accept this balance change');
  }
  return balance === 0 ? 'DEPLETED' : 'ACTIVE';
}

function rhCompletedRefundTotal_(ctx, transactionId) {
  rhAssertNoReversal_(ctx, transactionId);
  var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  var total = 0;
  for (var i = 0; i < records.length; i++) {
    var txn = records[i];
    if (txn.related_transaction_id !== transactionId || txn.transaction_type !== 'REFUND') continue;
    if (txn.transaction_status === 'PENDING') {
      throw rhFail_('PARTIAL_FAILURE', 'A refund for this transaction is unresolved');
    }
    if (txn.transaction_status === 'COMPLETED') total = rhExactSum_(total, txn.amount_cents);
  }
  return total;
}

function rhAssertNoReversal_(ctx, transactionId) {
  var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  for (var i = 0; i < records.length; i++) {
    var txn = records[i];
    if (txn.related_transaction_id !== transactionId || txn.transaction_type !== 'VOID') continue;
    if (txn.transaction_status !== 'FAILED') {
      throw rhFail_('INVALID_STATE', 'The original transaction already has a void');
    }
  }
}

function rhAssertNoRefund_(ctx, transactionId) {
  var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  for (var i = 0; i < records.length; i++) {
    var txn = records[i];
    if (txn.related_transaction_id !== transactionId || txn.transaction_type !== 'REFUND') continue;
    if (txn.transaction_status !== 'FAILED') {
      throw rhFail_('INVALID_STATE', 'A refunded transaction has to be corrected with another refund, not a void');
    }
  }
}

function rhAssertNoPending_(ctx, cardId) {
  var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  for (var i = 0; i < records.length; i++) {
    if (records[i].card_id === cardId && records[i].transaction_status === 'PENDING') {
      throw rhFail_(
        'PARTIAL_FAILURE',
        'This gift card has an unresolved transaction and must be reviewed before another balance change'
      );
    }
  }
}

function rhCommitMoney_(ctx, spec) {
  var metadata = spec.metadata || {};
  metadata.request_hash = spec.requestHash;
  metadata.status_before = spec.statusBefore;
  metadata.status_after = spec.statusAfter;
  var txn = rhAppendRecord_(ctx, RH_SHEET.TRANSACTIONS, {
    transaction_id: rhNewId_(),
    card_id: spec.card.card_id,
    transaction_type: spec.type,
    amount_cents: spec.amountCents,
    balance_before_cents: spec.balanceBefore,
    balance_after_cents: spec.balanceAfter,
    location_id: spec.location.location_id,
    employee_id: spec.actor.employee_id,
    register_reference: spec.registerReference || '',
    idempotency_key: spec.idempotencyKey,
    related_transaction_id: spec.relatedTransactionId || '',
    transaction_status: 'PENDING',
    notes: spec.notes || '',
    created_at: rhNowIso_(),
    metadata_json: JSON.stringify(metadata)
  });
  rhMaybeFailWrite_('after_pending_append');
  var patch = {
    current_balance: spec.balanceAfter,
    status: spec.statusAfter,
    updated_at: rhNowIso_()
  };
  var extra = spec.cardPatch || {};
  var extraKeys = Object.keys(extra);
  for (var i = 0; i < extraKeys.length; i++) patch[extraKeys[i]] = extra[extraKeys[i]];
  rhUpdateRecord_(ctx, RH_SHEET.GIFT_CARDS, spec.card._row, spec.card, patch);
  rhMaybeFailWrite_('after_card_update');
  if (spec.voidOriginal) {
    rhTransitionTxnStatus_(ctx, spec.voidOriginal, 'VOIDED');
    rhMaybeFailWrite_('after_original_voided');
  }
  rhTransitionTxnStatus_(ctx, txn, 'COMPLETED');
  return {
    card: rhRequireCardById_(ctx, spec.card.card_id),
    transaction: rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', txn.transaction_id),
      'Transaction was not found'
    )
  };
}

function rhTransitionTxnStatus_(ctx, txn, nextStatus) {
  var current = txn.transaction_status;
  var allowed = (current === 'PENDING' &&
      (nextStatus === 'COMPLETED' || nextStatus === 'FAILED' || nextStatus === 'VOIDED')) ||
    (current === 'COMPLETED' && nextStatus === 'VOIDED');
  if (!allowed) {
    throw rhFail_('INVALID_STATE', 'Transaction status cannot change from ' + current + ' to ' + nextStatus);
  }
  rhUpdateRecord_(ctx, RH_SHEET.TRANSACTIONS, txn._row, txn, { transaction_status: nextStatus });
  txn.transaction_status = nextStatus;
  return txn;
}

function rhBeginIdempotent_(ctx, key, requestHash) {
  var existing = rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'idempotency_key', key);
  if (existing.length > 1) throw rhFail_('RECONCILIATION', 'Duplicate idempotency key found. Refusing to continue.');
  if (!existing.length) return { mode: 'apply' };
  var txn = existing[0];
  var meta = rhReadMetadata_(txn);
  if (meta.request_hash !== requestHash) {
    throw rhFail_('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request');
  }
  if (txn.transaction_status === 'COMPLETED' || txn.transaction_status === 'VOIDED') {
    return { mode: 'replay', transaction: txn };
  }
  if (txn.transaction_status === 'FAILED') {
    throw rhFail_('IDEMPOTENCY_EXHAUSTED', 'This idempotency key already finished without posting. Submit a new idempotency key.');
  }
  if (txn.transaction_status === 'PENDING') {
    rhRepairSinglePending_(ctx, txn);
    var refreshed = rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', txn.transaction_id),
      'Transaction was not found'
    );
    if (refreshed.transaction_status === 'COMPLETED') return { mode: 'replay', transaction: refreshed };
    if (refreshed.transaction_status === 'FAILED') {
      throw rhFail_('IDEMPOTENCY_EXHAUSTED', 'This idempotency key already finished without posting. Submit a new idempotency key.');
    }
    throw rhFail_('PARTIAL_FAILURE', 'A matching transaction is still unresolved and must be reviewed');
  }
  throw rhFail_('INVALID_STATE', 'Unsupported transaction status');
}

function rhRepairAllPending_(ctx) {
  var repaired = [];
  var guard = 0;
  while (guard < 100) {
    guard++;
    var pending = rhPendingTransactions_(ctx);
    if (!pending.length) return { repaired: repaired, ambiguous: [] };
    var progressed = false;
    for (var i = 0; i < pending.length; i++) {
      var outcome = rhRepairSinglePending_(ctx, pending[i]);
      if (outcome === 'COMPLETED' || outcome === 'FAILED') {
        repaired.push({
          transaction_id: pending[i].transaction_id,
          card_id: pending[i].card_id,
          result: outcome
        });
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      var ambiguous = [];
      for (var a = 0; a < pending.length; a++) {
        ambiguous.push({
          transaction_id: pending[a].transaction_id,
          card_id: pending[a].card_id,
          transaction_type: pending[a].transaction_type,
          created_at: pending[a].created_at
        });
      }
      return { repaired: repaired, ambiguous: ambiguous };
    }
  }
  throw rhFail_('RECONCILIATION', 'Repair stopped after too many passes');
}

function rhPendingTransactions_(ctx) {
  var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  var pending = [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].transaction_status === 'PENDING') pending.push(records[i]);
  }
  pending.sort(function (a, b) { return b._row - a._row; });
  return pending;
}

function rhRepairSinglePending_(ctx, txn) {
  var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  var latestRow = 0;
  for (var i = 0; i < records.length; i++) {
    if (records[i].card_id === txn.card_id && records[i]._row > latestRow) latestRow = records[i]._row;
  }
  if (txn._row !== latestRow) return 'AMBIGUOUS';
  var meta = rhReadMetadata_(txn);
  var cards = rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'card_id', txn.card_id);
  if (cards.length > 1) return 'AMBIGUOUS';
  var card = cards.length ? cards[0] : null;
  if (txn.transaction_type === 'ISSUE') return rhRepairIssue_(ctx, txn, meta, card);
  if (!card || !meta.status_before || !meta.status_after) return 'AMBIGUOUS';
  if (txn.transaction_type === 'VOID') return rhRepairVoid_(ctx, txn, meta, card);
  if (card.current_balance === txn.balance_before_cents && card.status === meta.status_before) {
    rhTransitionTxnStatus_(ctx, txn, 'FAILED');
    return 'FAILED';
  }
  if (card.current_balance === txn.balance_after_cents && card.status === meta.status_after) {
    rhTransitionTxnStatus_(ctx, txn, 'COMPLETED');
    return 'COMPLETED';
  }
  return 'AMBIGUOUS';
}

function rhRepairIssue_(ctx, txn, meta, card) {
  if (!meta.card_id || !meta.card_number || !meta.qr_token || typeof meta.initial_amount !== 'number') {
    return 'AMBIGUOUS';
  }
  if (!card) {
    if (rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'card_number', meta.card_number).length) return 'AMBIGUOUS';
    if (rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'qr_token', meta.qr_token).length) return 'AMBIGUOUS';
    var now = rhNowIso_();
    rhAppendRecord_(ctx, RH_SHEET.GIFT_CARDS, {
      card_id: meta.card_id,
      card_number: meta.card_number,
      qr_token: meta.qr_token,
      initial_amount: meta.initial_amount,
      current_balance: 0,
      status: 'PENDING',
      card_type: meta.card_type,
      issued_at: txn.created_at || now,
      activated_at: '',
      issued_location_id: meta.issued_location_id,
      issued_by_employee_id: meta.issued_by_employee_id,
      customer_name: meta.customer_name || '',
      customer_email: meta.customer_email || '',
      created_at: txn.created_at || now,
      updated_at: now
    });
    rhTransitionTxnStatus_(ctx, txn, 'COMPLETED');
    return 'COMPLETED';
  }
  if (card.card_number !== meta.card_number || card.qr_token !== meta.qr_token) return 'AMBIGUOUS';
  if (card.current_balance !== 0 || card.status !== 'PENDING') return 'AMBIGUOUS';
  if (card.initial_amount !== meta.initial_amount) return 'AMBIGUOUS';
  rhTransitionTxnStatus_(ctx, txn, 'COMPLETED');
  return 'COMPLETED';
}

function rhRepairVoid_(ctx, txn, meta, card) {
  var original = rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', txn.related_transaction_id);
  if (original.length !== 1) return 'AMBIGUOUS';
  original = original[0];
  var beforeMatches = card.current_balance === txn.balance_before_cents && card.status === meta.status_before;
  var afterMatches = card.current_balance === txn.balance_after_cents && card.status === meta.status_after;
  if (beforeMatches && original.transaction_status === 'COMPLETED') {
    rhTransitionTxnStatus_(ctx, txn, 'FAILED');
    return 'FAILED';
  }
  if (afterMatches && original.transaction_status === 'COMPLETED') {
    rhTransitionTxnStatus_(ctx, original, 'VOIDED');
    rhTransitionTxnStatus_(ctx, txn, 'COMPLETED');
    return 'COMPLETED';
  }
  if (afterMatches && original.transaction_status === 'VOIDED') {
    rhTransitionTxnStatus_(ctx, txn, 'COMPLETED');
    return 'COMPLETED';
  }
  return 'AMBIGUOUS';
}

function rhReadMetadata_(txn) {
  if (!txn.metadata_json) return {};
  var parsed;
  try {
    parsed = JSON.parse(txn.metadata_json);
  } catch (err) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  return {
    request_hash: parsed.request_hash || '',
    status_before: parsed.status_before || '',
    status_after: parsed.status_after || '',
    card_id: parsed.card_id || '',
    card_number: parsed.card_number || '',
    qr_token: parsed.qr_token || '',
    initial_amount: typeof parsed.initial_amount === 'number' ? parsed.initial_amount : null,
    card_type: parsed.card_type || '',
    customer_name: parsed.customer_name || '',
    customer_email: parsed.customer_email || '',
    issued_location_id: parsed.issued_location_id || '',
    issued_by_employee_id: parsed.issued_by_employee_id || '',
    related_type: parsed.related_type || '',
    direction: parsed.direction || ''
  };
}

function rhTransactionsForCard_(ctx, cardId) {
  var records = rhReadSheet_(ctx, RH_SHEET.TRANSACTIONS).records;
  var selected = [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].card_id === cardId) selected.push(records[i]);
  }
  selected.sort(function (a, b) { return a._row - b._row; });
  var publicRows = [];
  for (var r = 0; r < selected.length; r++) publicRows.push(rhPublicTxn_(selected[r]));
  return publicRows;
}

function rhPublicTxn_(txn) {
  return {
    transaction_id: txn.transaction_id,
    card_id: txn.card_id,
    transaction_type: txn.transaction_type,
    amount_cents: txn.amount_cents,
    balance_before_cents: txn.balance_before_cents,
    balance_after_cents: txn.balance_after_cents,
    location_id: txn.location_id,
    employee_id: txn.employee_id,
    register_reference: txn.register_reference,
    idempotency_key: txn.idempotency_key,
    related_transaction_id: txn.related_transaction_id,
    transaction_status: txn.transaction_status,
    notes: txn.notes,
    created_at: txn.created_at,
    money_unit: RH_MONEY_UNIT
  };
}

function rhPostedResult_(posted, actor, replayed) {
  return {
    money_unit: RH_MONEY_UNIT,
    replayed: replayed,
    card: rhPublicCard_(posted.card, actor, 'staff'),
    transaction: rhPublicTxn_(posted.transaction)
  };
}

function rhOperationResult_(ctx, actor, cardId, transactionId, replayed, mode) {
  return {
    money_unit: RH_MONEY_UNIT,
    replayed: replayed,
    card: rhPublicCard_(rhRequireCardById_(ctx, cardId), actor, mode),
    transaction: rhPublicTxn_(rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.TRANSACTIONS, 'transaction_id', transactionId),
      'Transaction was not found'
    ))
  };
}

function rhReplayResult_(ctx, txn, actor) {
  var card = rhRequireCardById_(ctx, txn.card_id);
  return {
    money_unit: RH_MONEY_UNIT,
    replayed: true,
    later_voided: txn.transaction_status === 'VOIDED',
    card: rhPublicCard_(card, actor, txn.transaction_type === 'ISSUE' ? 'issue' : 'staff'),
    transaction: rhPublicTxn_(txn)
  };
}

function rhOptionalLimit_(value) {
  if (value === undefined || value === null || value === '') return 200;
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < 1 || value > 500) {
    throw rhFail_('VALIDATION', 'limit must be an integer from 1 to 500');
  }
  return value;
}
