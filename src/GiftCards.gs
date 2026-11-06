/**
 * Gift card issuance and status. A priced card stays PENDING with a zero
 * balance until activateGiftCard records that payment was confirmed.
 * A blank card from createBlankGiftCards also stays at zero until the
 * purchase amount is supplied at activation.
 * The QR token identifies the card. It does not authorize a transaction.
 */

function createGiftCard(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'GIFT_CARD_CREATE'
  });
  return rhWithLock_(function (ctx) {
    return rhCreateGiftCardLocked_(ctx, actor, request);
  });
}

function createBlankGiftCards(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER'],
    action: 'GIFT_CARD_BLANK_BATCH'
  });
  return rhWithLock_(function (ctx) {
    return rhCreateBlankGiftCardsLocked_(ctx, actor, request);
  });
}

function activateGiftCard(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'GIFT_CARD_ACTIVATE'
  });
  return rhWithLock_(function (ctx) {
    return rhActivateGiftCardLocked_(ctx, actor, request);
  });
}

function cancelGiftCard(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER'],
    action: 'GIFT_CARD_CANCEL'
  });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var card = rhFindCard_(ctx, request);
    if (card.status === 'CANCELLED') return { changed: false, card: rhPublicCard_(card, actor, 'staff') };
    if (card.status !== 'PENDING' || card.current_balance !== 0) {
      throw rhFail_('INVALID_STATE', 'Only a pending gift card with a zero balance can be cancelled');
    }
    var updated = rhUpdateRecord_(ctx, RH_SHEET.GIFT_CARDS, card._row, card, {
      status: 'CANCELLED',
      updated_at: rhNowIso_()
    });
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'GIFT_CARD_CANCELLED',
      entity_type: 'GIFT_CARD',
      entity_id: card.card_id,
      details: { card_number: card.card_number }
    });
    return { changed: true, card: rhPublicCard_(updated, actor, 'staff') };
  });
}

function getGiftCardById(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'GIFT_CARD_READ'
  });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var card = rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'card_id', rhRequireUuid_(request.cardId, 'cardId')),
      'Gift card was not found'
    );
    return rhWithOptionalQr_(rhPublicCard_(card, actor, 'staff'), card, actor, request);
  });
}

function getGiftCardByQRToken(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'GIFT_CARD_READ_QR'
  });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var token = rhRequireQrToken_(request.qrToken);
    var card = rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'qr_token', token),
      'Gift card was not found'
    );
    return rhPublicCard_(card, actor, 'staff');
  });
}

function checkGiftCardBalance(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'GIFT_CARD_BALANCE'
  });
  return rhWithLock_(function (ctx) {
    rhReloadActor_(ctx, actor);
    var card = rhFindCard_(ctx, request);
    return {
      money_unit: RH_MONEY_UNIT,
      card_id: card.card_id,
      card_number: card.card_number,
      status: card.status,
      current_balance: card.current_balance
    };
  });
}

function suspendGiftCard(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER'],
    action: 'GIFT_CARD_SUSPEND'
  });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var card = rhFindCard_(ctx, request);
    if (card.status === 'SUSPENDED') return { changed: false, card: rhPublicCard_(card, actor, 'staff') };
    if (card.status !== 'ACTIVE' && card.status !== 'DEPLETED') {
      throw rhFail_('INVALID_STATE', 'Only an active or depleted gift card can be suspended');
    }
    var updated = rhUpdateRecord_(ctx, RH_SHEET.GIFT_CARDS, card._row, card, {
      status: 'SUSPENDED',
      updated_at: rhNowIso_()
    });
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'GIFT_CARD_SUSPENDED',
      entity_type: 'GIFT_CARD',
      entity_id: card.card_id,
      details: { card_number: card.card_number, balance: card.current_balance }
    });
    return { changed: true, card: rhPublicCard_(updated, actor, 'staff') };
  });
}

function reinstateGiftCard(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER'],
    action: 'GIFT_CARD_REINSTATE'
  });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var card = rhFindCard_(ctx, request);
    if (card.status !== 'SUSPENDED') throw rhFail_('INVALID_STATE', 'Only a suspended gift card can be reinstated');
    var status = card.current_balance === 0 ? 'DEPLETED' : 'ACTIVE';
    var updated = rhUpdateRecord_(ctx, RH_SHEET.GIFT_CARDS, card._row, card, {
      status: status,
      updated_at: rhNowIso_()
    });
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'GIFT_CARD_REINSTATED',
      entity_type: 'GIFT_CARD',
      entity_id: card.card_id,
      details: { card_number: card.card_number, status: status }
    });
    return { changed: true, card: rhPublicCard_(updated, actor, 'staff') };
  });
}

function rhCreateBlankGiftCardsLocked_(ctx, actor, request) {
  actor = rhReloadActor_(ctx, actor);
  var count = rhRequireBatchCount_(request.count);
  var batchKey = rhRequireIdempotencyKey_(request.idempotencyKey);
  if (batchKey.length > 124) {
    throw rhFail_('VALIDATION', 'idempotencyKey must be at most 124 characters for a series of cards');
  }
  var location = rhResolveLocation_(ctx, actor, request.locationId);
  var cardType = rhRequireEnum_(request.cardType || 'PHYSICAL', RH_CARD_TYPES, 'cardType');
  var cards = [];
  var replayed = 0;
  for (var index = 0; index < count; index++) {
    var issued = rhCreateGiftCardLocked_(ctx, actor, {
      locationId: location.location_id,
      cardType: cardType,
      idempotencyKey: batchKey + ':' + index
    }, { count: count, index: index });
    cards.push(issued.card);
    if (issued.replayed) replayed++;
  }
  return {
    money_unit: RH_MONEY_UNIT,
    replayed: replayed === count,
    count: cards.length,
    cards: cards
  };
}

function rhCreateGiftCardLocked_(ctx, actor, request, blank) {
  actor = rhReloadActor_(ctx, actor);
  var location = rhResolveLocation_(ctx, actor, request.locationId);
  var amount = blank ? 0 : rhRequireCents_(request.initialAmountCents, 'initialAmountCents');
  var cardType = rhRequireEnum_(request.cardType, RH_CARD_TYPES, 'cardType');
  var customerName = blank ? '' : rhOptionalText_(request.customerName, 'customerName', 120);
  var customerEmail = blank ? '' : rhOptionalEmail_(request.customerEmail);
  var idempotencyKey = rhRequireIdempotencyKey_(request.idempotencyKey);
  var registerReference = rhOptionalReference_(request.registerReference);
  var notes = rhOptionalNotes_(request.notes);
  var hashPayload = {
    op: blank ? 'ISSUE_BLANK' : 'ISSUE',
    locationId: location.location_id,
    initialAmountCents: amount,
    cardType: cardType,
    customerName: customerName,
    customerEmail: customerEmail,
    registerReference: registerReference,
    notes: notes
  };
  if (blank) {
    hashPayload.batchCount = blank.count;
    hashPayload.batchIndex = blank.index;
  }
  var requestHash = rhRequestHash_(hashPayload);
  var gate = rhBeginIdempotent_(ctx, idempotencyKey, requestHash);
  if (gate.mode === 'replay') return rhReplayResult_(ctx, gate.transaction, actor);

  var now = rhNowIso_();
  var cardId = rhNewId_();
  var cardNumber = rhGenerateCardNumber_(ctx);
  var qrToken = rhGenerateQrToken_(ctx);
  var txn = rhAppendRecord_(ctx, RH_SHEET.TRANSACTIONS, {
    transaction_id: rhNewId_(),
    card_id: cardId,
    transaction_type: 'ISSUE',
    amount_cents: amount,
    balance_before_cents: 0,
    balance_after_cents: 0,
    location_id: location.location_id,
    employee_id: actor.employee_id,
    register_reference: registerReference,
    idempotency_key: idempotencyKey,
    related_transaction_id: '',
    transaction_status: 'PENDING',
    notes: notes,
    created_at: now,
    metadata_json: JSON.stringify({
      request_hash: requestHash,
      status_before: 'PENDING',
      status_after: 'PENDING',
      card_id: cardId,
      card_number: cardNumber,
      qr_token: qrToken,
      initial_amount: amount,
      card_type: cardType,
      customer_name: customerName,
      customer_email: customerEmail,
      issued_location_id: location.location_id,
      issued_by_employee_id: actor.employee_id
    })
  });
  rhMaybeFailWrite_('after_pending_append');
  rhAppendRecord_(ctx, RH_SHEET.GIFT_CARDS, {
    card_id: cardId,
    card_number: cardNumber,
    qr_token: qrToken,
    initial_amount: amount,
    current_balance: 0,
    status: 'PENDING',
    card_type: cardType,
    issued_at: now,
    activated_at: '',
    issued_location_id: location.location_id,
    issued_by_employee_id: actor.employee_id,
    customer_name: customerName,
    customer_email: customerEmail,
    created_at: now,
    updated_at: now
  });
  rhMaybeFailWrite_('after_card_update');
  rhTransitionTxnStatus_(ctx, txn, 'COMPLETED');
  rhAudit_(ctx, {
    employee_id: actor.employee_id,
    action: 'GIFT_CARD_CREATED',
    entity_type: 'GIFT_CARD',
    entity_id: cardId,
    details: {
      card_number: cardNumber,
      qr_fingerprint: rhFingerprint_(qrToken),
      initial_amount: amount,
      card_type: cardType,
      location_id: location.location_id,
      customer_present: customerName !== '' || customerEmail !== ''
    }
  });
  return rhOperationResult_(ctx, actor, cardId, txn.transaction_id, false, 'issue');
}

function rhActivateGiftCardLocked_(ctx, actor, request) {
  actor = rhReloadActor_(ctx, actor);
  var location = rhResolveLocation_(ctx, actor, request.locationId);
  if (request.paymentConfirmed !== true) {
    throw rhFail_('VALIDATION', 'Gift cards activate only after paymentConfirmed is true');
  }
  var card = rhFindCard_(ctx, request);
  var notes = rhOptionalNotes_(request.notes);
  var registerReference = rhOptionalReference_(request.registerReference);
  var idempotencyKey = rhRequireIdempotencyKey_(request.idempotencyKey);
  var amount = rhActivationAmount_(card, request);
  var requestHash = rhRequestHash_({
    op: 'ACTIVATE',
    cardId: card.card_id,
    locationId: location.location_id,
    paymentConfirmed: true,
    amountCents: amount,
    notes: notes,
    registerReference: registerReference
  });
  var gate = rhBeginIdempotent_(ctx, idempotencyKey, requestHash);
  if (gate.mode === 'replay') return rhReplayResult_(ctx, gate.transaction, actor);
  card = rhRequireCardById_(ctx, card.card_id);
  rhAssertNoPending_(ctx, card.card_id);
  if (card.status !== 'PENDING') throw rhFail_('INVALID_STATE', 'Only a pending gift card can be activated');
  if (card.current_balance !== 0) throw rhFail_('RECONCILIATION', 'Pending gift card balance is not zero');
  if (card.initial_amount !== 0 && card.initial_amount !== amount) {
    throw rhFail_('RECONCILIATION', 'Gift card amount is invalid');
  }
  rhAssertBalanceCap_(amount);
  var activatedAt = rhNowIso_();
  var posted = rhCommitMoney_(ctx, {
    actor: actor,
    card: card,
    location: location,
    type: 'ACTIVATE',
    amountCents: amount,
    balanceBefore: 0,
    balanceAfter: amount,
    statusBefore: 'PENDING',
    statusAfter: 'ACTIVE',
    idempotencyKey: idempotencyKey,
    requestHash: requestHash,
    notes: notes,
    registerReference: registerReference,
    cardPatch: { activated_at: activatedAt, initial_amount: amount },
    metadata: { payment_confirmed: true }
  });
  rhAudit_(ctx, {
    employee_id: actor.employee_id,
    action: 'GIFT_CARD_ACTIVATED',
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

function rhActivationAmount_(card, request) {
  var face = card.initial_amount;
  if (typeof face !== 'number' || Math.floor(face) !== face || face < 0) {
    throw rhFail_('RECONCILIATION', 'Gift card amount is invalid');
  }
  var supplied = request.amountCents !== undefined && request.amountCents !== null && request.amountCents !== '';
  if (face === 0) {
    if (!supplied) throw rhFail_('VALIDATION', 'amountCents is required when the card has no amount yet');
    return rhRequireCents_(request.amountCents, 'amountCents');
  }
  if (supplied && request.amountCents !== face) {
    throw rhFail_('VALIDATION', 'This card already has an amount');
  }
  return face;
}

function rhFindCard_(ctx, request) {
  var card = null;
  if (request.cardId) {
    card = rhRequireCardById_(ctx, rhRequireUuid_(request.cardId, 'cardId'));
  }
  if (request.qrToken) {
    var byToken = rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'qr_token', rhRequireQrToken_(request.qrToken)),
      'Gift card was not found'
    );
    if (card && card.card_id !== byToken.card_id) {
      throw rhFail_('VALIDATION', 'The card identifiers do not match');
    }
    card = byToken;
  }
  if (request.cardNumber) {
    var byNumber = rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'card_number', rhRequireCardNumber_(request.cardNumber)),
      'Gift card was not found'
    );
    if (card && card.card_id !== byNumber.card_id) {
      throw rhFail_('VALIDATION', 'The card identifiers do not match');
    }
    card = byNumber;
  }
  if (!card) throw rhFail_('VALIDATION', 'A gift card id, number, or QR token is required');
  return card;
}

function rhRequireCardById_(ctx, cardId) {
  return rhRequireSingle_(rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'card_id', cardId), 'Gift card was not found');
}

function rhRequireQrToken_(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw rhFail_('VALIDATION', 'qrToken is invalid');
  }
  return value;
}

function rhRequireCardNumber_(value) {
  if (typeof value !== 'string') throw rhFail_('VALIDATION', 'cardNumber is invalid');
  var cardNumber = value.trim().toUpperCase();
  if (!/^RH-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(cardNumber)) {
    throw rhFail_('VALIDATION', 'cardNumber is invalid');
  }
  return cardNumber;
}

function rhPublicCard_(card, actor, mode) {
  var view = {
    card_id: card.card_id,
    card_number: card.card_number,
    initial_amount: card.initial_amount,
    current_balance: card.current_balance,
    status: card.status,
    card_type: card.card_type,
    issued_at: card.issued_at,
    activated_at: card.activated_at,
    issued_location_id: card.issued_location_id,
    issued_by_employee_id: card.issued_by_employee_id,
    customer_name: card.customer_name,
    created_at: card.created_at,
    updated_at: card.updated_at,
    money_unit: RH_MONEY_UNIT
  };
  if (actor && actor.role !== 'EMPLOYEE') view.customer_email = card.customer_email || '';
  if (mode === 'issue') {
    view.qr_token = card.qr_token;
    view.qr_payload = RH_QR_PAYLOAD_PREFIX + card.qr_token;
  }
  return view;
}

function rhWithOptionalQr_(view, card, actor, request) {
  if (!request || request.includeQrToken !== true) return view;
  var allowed = actor.role === 'ADMIN' || actor.role === 'MANAGER' ||
    (card.status === 'PENDING' && card.issued_by_employee_id === actor.employee_id);
  if (!allowed) return view;
  view.qr_token = card.qr_token;
  view.qr_payload = RH_QR_PAYLOAD_PREFIX + card.qr_token;
  return view;
}
