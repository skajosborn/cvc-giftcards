import { useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { loadGoogleIdentity } from './googleIdentity.js';
import { formatCents } from './register.js';
import cvcLogo from './CVC Logo.png';

function TagIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M24 18c.2-3.4.3-5.4 2.2-6.8 2.3-1.7 5.4-.1 4.7 2.6" />
      <path d="M8 32 24 18l16 14H8" />
    </svg>
  );
}

function BagIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M15 21h18v13.5a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V21z" />
      <path d="M19.5 21v-3a4.5 4.5 0 0 1 9 0v3" />
      <path d="M15 27.5h18" />
      <circle cx="24" cy="31.5" r="1.5" />
    </svg>
  );
}

function CupIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M14 16h16v8a8 8 0 0 1-16 0V16z" />
      <path d="M30 18h4a5 5 0 0 1 0 10h-4" />
      <path d="M20 10c0 2-2 2-2 4M26 8c0 2-2 2-2 4" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg className="gift-box" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="8" y="28" width="48" height="28" rx="2" />
      <rect x="6" y="20" width="52" height="12" rx="2" />
      <path d="M32 20v36M32 20c-6-12-20-8-14 0M32 20c6-12 20-8 14 0" />
    </svg>
  );
}

export function SignIn({ clientId, onCredential, onPreview, restoring }) {
  const host = useRef(null);

  useEffect(() => {
    if (restoring || !clientId || !host.current) return undefined;
    let cancelled = false;
    loadGoogleIdentity().then((gis) => {
      if (cancelled || !host.current) return;
      gis.initialize({
        client_id: clientId,
        auto_select: true,
        button_auto_select: true,
        callback: (response) => {
          if (response && response.credential) onCredential(response.credential);
        }
      });
      host.current.replaceChildren();
      gis.renderButton(host.current, {
        type: 'standard',
        theme: 'filled_black',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
        width: 320
      });
      gis.prompt();
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [clientId, onCredential, restoring]);

  return (
    <section className="signin">
      <header className="signin-top">
        <div className="brand">
          <img className="brand-logo" src={cvcLogo} alt="" />
          <div className="brand-lockup">
            <p className="brand-name">Combat Veterans<br />to Careers</p>
            <p className="brand-rule"><i /><span>★</span><i /></p>
            <p className="brand-hope">Restoring Hope</p>
          </div>
        </div>
        <p className="scene-label">Gift card management</p>
      </header>
      <div className="signin-layout">
        <div className="signin-copy">
          <h1>Gift Card Management</h1>
          <span className="accent-rule" />
          <p className="lede">Manage gift cards for the thrift store, boutique, and café — all in one place.</p>
          <ul className="shops">
            <li><BagIcon /> Thrift store</li>
            <li><TagIcon /> Boutique</li>
            <li><CupIcon /> Café</li>
          </ul>
        </div>
        <div className="signin-card">
          <div className="signin-body stack">
            <h2>{restoring ? 'Welcome back' : 'Sign In'}</h2>
            <p className="quiet">{restoring ? 'Signing you back in.' : 'Use the Google account on the employee list.'}</p>
            {restoring ? null : clientId ? <div className="signin-google" ref={host} id="google-signin" /> : (
              <p className="setup-hint">
                Google sign-in is not connected on this computer yet.
                <code>VITE_GOOGLE_CLIENT_ID</code>
                <code>VITE_APPS_SCRIPT_URL</code>
              </p>
            )}
            {!restoring && import.meta.env.DEV ? (
              <button className="signin-preview" type="button" onClick={onPreview}>Preview the layout</button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="gift-slip" aria-hidden="true">
        <GiftIcon />
        <div className="gift-slip-copy">
          <span className="gift-slip-kicker">Gift card</span>
          <span className="gift-slip-bars" />
          <span className="gift-slip-rule" />
          <span className="gift-slip-name">Restoring Hope</span>
        </div>
      </div>
    </section>
  );
}

export function Identity({ session, locations, locationId, onLocation, onSignOut, onHome, onDesk, onStaff, onCards }) {
  const place = session.location ? session.location.location_name : 'All stores';
  return (
    <aside className="panel identity stack">
      <div>
        <p className="kicker">{session.employee.role}</p>
        <p className="person">{session.employee.full_name}</p>
        <p className="quiet">{place}</p>
      </div>
      {session.employee.role === 'ADMIN' && !session.preview ? (
        <label>
          Store for this sale
          <select value={locationId} onChange={(event) => onLocation(event.target.value)}>
            <option value="">Choose a store</option>
            {locations.map((location) => (
              <option key={location.location_id} value={location.location_id}>{location.location_name}</option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="identity-links">
        <button className="link" type="button" onClick={onHome}>Counter</button>
        {session.employee.role !== 'EMPLOYEE' ? (
          <button className="link" type="button" onClick={onCards}>Cards</button>
        ) : null}
        {session.employee.role !== 'EMPLOYEE' ? (
          <button className="link" type="button" onClick={onDesk}>Today</button>
        ) : null}
        {session.employee.role === 'ADMIN' ? (
          <button className="link" type="button" onClick={onStaff}>Staff</button>
        ) : null}
        <button className="link" type="button" onClick={onSignOut}>Sign out</button>
      </div>
    </aside>
  );
}

export function Home({ onLookup, onCards, onSell, onBlanks, canManage }) {
  return (
    <section className="panel stage stack">
      <div className="stage-head">
        <h2>What do you need?</h2>
      </div>
      <button type="button" onClick={onLookup}>Find a card</button>
      {canManage ? <button className="secondary" type="button" onClick={onCards}>See all cards</button> : null}
      {canManage ? <button className="secondary" type="button" onClick={onBlanks}>Make blank cards</button> : null}
      <button className="secondary" type="button" onClick={onSell}>Sell a new card</button>
      <p className="quiet">Printed cards stay at $0 until someone buys one.</p>
    </section>
  );
}

export function Lookup({ cardNumber, onCardNumber, onFind, onScan, scanning, scannerNote, busy }) {
  return (
    <section className="panel stage stack">
      <div className="stage-head">
        <h2>Find a card</h2>
      </div>
      <label>
        Card number
        <input
          value={cardNumber}
          onChange={(event) => onCardNumber(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck="false"
          placeholder="RH-ABCD-EFGH-JKLM"
        />
      </label>
      <div className="actions">
        <button type="button" onClick={onFind} disabled={busy}>Look up</button>
        <button className="secondary" type="button" onClick={onScan} disabled={busy || scanning}>Scan QR code</button>
      </div>
      {scanning ? <ScannerNote note={scannerNote} /> : null}
    </section>
  );
}

function ScannerNote({ note }) {
  return (
    <div className="scanner stack">
      <video id="qr-video" muted playsInline />
      <p className="quiet">{note || 'Point the camera at the gift card code.'}</p>
    </div>
  );
}

export function CardView({ card, history, amount, onAmount, buyerName, onBuyerName, paymentChecked, onPayment, onRedeem, onReload, onAssign, onSuspend, canManage, busy, sample }) {
  const unsold = card.status === 'PENDING';
  const openValue = unsold && !card.initial_amount;
  return (
    <section className="panel stage">
      <div className="stage-head">
        <div>
          {sample ? <span className="sample-mark">Sample</span> : null}
          <p className="status-label">{statusLabel(card.status)}</p>
          <p className="balance">{formatCents(card.current_balance)}</p>
        </div>
      </div>
      <p className="card-number">{card.card_number}</p>
      {card.customer_name ? <p className="quiet">{card.customer_name}</p> : null}
      {unsold ? (
        <div className="stack">
          <p className="quiet">
            {openValue
              ? 'This card has no balance yet. Enter what the customer paid.'
              : 'This card is for ' + formatCents(card.initial_amount) + ' and is waiting for payment.'}
          </p>
          {openValue ? (
            <label>
              Amount
              <span className="money-input">
                <span aria-hidden="true">$</span>
                <input inputMode="decimal" value={amount} onChange={(event) => onAmount(event.target.value)} placeholder="0.00" />
              </span>
            </label>
          ) : null}
          <label>
            Name on the card
            <input value={buyerName} onChange={(event) => onBuyerName(event.target.value)} autoComplete="name" />
          </label>
          <label className="check">
            <input type="checkbox" checked={paymentChecked} onChange={(event) => onPayment(event.target.checked)} />
            Payment is in the register
          </label>
          <button type="button" onClick={onAssign} disabled={busy || sample || !paymentChecked}>
            {openValue ? 'Put this balance on the card' : 'Activate ' + formatCents(card.initial_amount)}
          </button>
        </div>
      ) : (
        <div className="stack">
          <label>
            Amount
            <span className="money-input">
              <span aria-hidden="true">$</span>
              <input inputMode="decimal" value={amount} onChange={(event) => onAmount(event.target.value)} placeholder="0.00" />
            </span>
          </label>
          <div className="actions">
            <button type="button" onClick={onRedeem} disabled={busy || sample || card.status !== 'ACTIVE'}>Redeem</button>
            <button className="secondary" type="button" onClick={onReload} disabled={busy || sample || (card.status !== 'ACTIVE' && card.status !== 'DEPLETED')}>Add value</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={paymentChecked} onChange={(event) => onPayment(event.target.checked)} />
            Payment for added value is in the register
          </label>
          {canManage && (card.status === 'ACTIVE' || card.status === 'DEPLETED') ? (
            <button className="link" type="button" onClick={onSuspend} disabled={busy || sample}>Suspend this card</button>
          ) : null}
        </div>
      )}
      <History rows={history} />
    </section>
  );
}

export function BlankSeries({ count, onCount, onCreate, cards, onSampleSale, busy, sample }) {
  if (cards && cards.length) {
    return (
      <section className="panel stage stack">
        <div className="stage-head no-print">
          <h2>Cards to print</h2>
        </div>
        <p className="quiet no-print">Each card is $0 until someone buys it. Print the code and the number onto the card. When it sells, look it up and enter the payment.</p>
        <div className="print-sheet">
          {cards.map((card) => (
            <article className="print-card" key={card.card_number}>
              {card.qr_payload ? (
                <QRCodeSVG value={card.qr_payload} size={148} level="M" marginSize={4} title={card.card_number} />
              ) : null}
              <p className="card-number">{card.card_number}</p>
              {sample ? (
                <button className="link no-print" type="button" onClick={() => onSampleSale(card)}>Preview the sale</button>
              ) : null}
            </article>
          ))}
        </div>
        <button className="no-print" type="button" onClick={() => window.print()}>Print</button>
      </section>
    );
  }
  return (
    <section className="panel stage stack">
      <div className="stage-head">
        <h2>Make blank cards</h2>
      </div>
      <p className="quiet">Each card gets its own number and a $0 balance. You choose the amount when a customer pays.</p>
      <label>
        How many
        <input inputMode="numeric" value={count} onChange={(event) => onCount(event.target.value)} placeholder="10" />
      </label>
      <button type="button" onClick={onCreate} disabled={busy}>Make the cards</button>
    </section>
  );
}

export function Sell({ draft, issued, onDraft, onCreate, onActivate, paymentChecked, onPayment, busy, sample }) {
  if (issued) {
    return (
      <section className="panel stage stack">
        <div>
          {sample ? <span className="sample-mark">Sample</span> : null}
          <p className="kicker">Write this on the card</p>
          <p className="card-number">{issued.card.card_number}</p>
        </div>
        <p className="quiet">The balance stays at {formatCents(0)} until the payment is in the register.</p>
        <label className="check">
          <input type="checkbox" checked={paymentChecked} onChange={(event) => onPayment(event.target.checked)} />
          Payment is in the register
        </label>
        <button type="button" onClick={onActivate} disabled={busy || sample || !paymentChecked}>Activate {formatCents(issued.card.initial_amount)}</button>
      </section>
    );
  }
  return (
    <section className="panel stage stack">
      <div className="stage-head"><h2>Sell a card</h2></div>
      <label>
        Amount
        <span className="money-input">
          <span aria-hidden="true">$</span>
          <input inputMode="decimal" value={draft.amount} onChange={(event) => onDraft({ amount: event.target.value })} placeholder="25.00" />
        </span>
      </label>
      <fieldset className="choice">
        <legend className="meta">Card</legend>
        <label>
          <input type="radio" name="cardType" checked={draft.cardType === 'PHYSICAL'} onChange={() => onDraft({ cardType: 'PHYSICAL' })} />
          Physical
        </label>
        <label>
          <input type="radio" name="cardType" checked={draft.cardType === 'DIGITAL'} onChange={() => onDraft({ cardType: 'DIGITAL' })} />
          Digital
        </label>
      </fieldset>
      <label>
        Customer name, if you have it
        <input value={draft.customerName} onChange={(event) => onDraft({ customerName: event.target.value })} />
      </label>
      <button type="button" onClick={onCreate} disabled={busy}>{sample ? 'Preview stops here' : 'Create the card'}</button>
    </section>
  );
}

function roleLabel(role) {
  if (role === 'MANAGER') return 'Manager';
  if (role === 'ADMIN') return 'Admin';
  return 'Cashier';
}

export function Staff({ people, locations, draft, onDraft, onCreate, onToggle, busy, sample }) {
  const storeName = (locationId) => {
    const match = locations.find((location) => location.location_id === locationId);
    return match ? match.location_name : 'All stores';
  };
  return (
    <section className="panel stage stack">
      <div className="stage-head">
        <h2>Staff</h2>
      </div>
      <p className="quiet">Use the Google account they will sign in with. They can open the register as soon as this is saved.</p>
      <label>
        Name
        <input value={draft.fullName} onChange={(event) => onDraft({ fullName: event.target.value })} autoComplete="name" />
      </label>
      <label>
        Google email
        <input value={draft.email} onChange={(event) => onDraft({ email: event.target.value })} autoComplete="off" inputMode="email" />
      </label>
      <label>
        Role
        <select value={draft.role} onChange={(event) => onDraft({ role: event.target.value })}>
          <option value="EMPLOYEE">Cashier</option>
          <option value="MANAGER">Manager</option>
          <option value="ADMIN">Admin</option>
        </select>
      </label>
      {draft.role === 'ADMIN' ? null : (
        <label>
          Store
          <select value={draft.locationId} onChange={(event) => onDraft({ locationId: event.target.value })}>
            <option value="">Choose a store</option>
            {locations.map((location) => (
              <option key={location.location_id} value={location.location_id}>{location.location_name}</option>
            ))}
          </select>
        </label>
      )}
      <button type="button" onClick={onCreate} disabled={busy || sample}>{sample ? 'Preview stops here' : 'Add this person'}</button>
      <ul className="people">
        {people.map((person) => (
          <li key={person.employee_id}>
            <div>
              <p className="person">{person.full_name}</p>
              <p className="quiet">{person.email}</p>
              <p className="meta">{roleLabel(person.role)} · {storeName(person.location_id)}{person.is_active ? '' : ' · No access'}</p>
            </div>
            <button className="secondary" type="button" onClick={() => onToggle(person)} disabled={busy || sample}>
              {person.is_active ? 'Remove access' : 'Restore access'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CardList({ cards, onOpen, storeName, pending }) {
  const intro = storeName
    ? 'Cards sold at ' + storeName + ', the person each one was sold to, and the balance left on it.'
    : 'Every card, the person it was sold to, and the balance left on it.';
  return (
    <section className="panel stage stack">
      <div className="stage-head">
        <h2>Cards</h2>
      </div>
      <p className="quiet">{intro}</p>
      {pending ? <p className="quiet">Loading this store... Please wait.</p> : null}
      {!pending && cards.length ? cards.map((card) => (
        <button className="card-row" type="button" key={card.card_id} onClick={() => onOpen(card)}>
          <span>
            <span className="card-number">{card.card_number}</span>
            <span className="quiet">{card.customer_name || 'No customer yet'}</span>
            <span className="meta">{statusLabel(card.status)} · {card.issued_location_name || 'Store not recorded'}</span>
          </span>
          <span className="card-balance">{formatCents(card.current_balance)}</span>
        </button>
      )) : null}
      {!pending && !cards.length ? (
        <p className="quiet">{storeName ? 'No cards at this store yet.' : 'No cards yet.'}</p>
      ) : null}
    </section>
  );
}

export function Today({ sales, redemptions, outstanding, storeName, pending }) {
  const where = storeName ? ' at ' + storeName : '';
  return (
    <section className="panel stage">
      <div className="stage-head">
        <div>
          <p className="kicker">Completed transactions</p>
          <h2>Today</h2>
        </div>
      </div>
      {pending ? <p className="quiet">Loading this store... Please wait.</p> : null}
      <div className="figures">
        <div>
          <span>Sold today{where}</span>
          <strong>{sales ? formatCents(sales.value_sold_cents) : '—'}</strong>
        </div>
        <div>
          <span>Redeemed today{where}</span>
          <strong>{redemptions ? formatCents(redemptions.value_redeemed_cents) : '—'}</strong>
        </div>
        <div>
          <span>Still on cards{where}</span>
          <strong>{outstanding ? formatCents(outstanding.outstanding_liability_cents) : '—'}</strong>
        </div>
      </div>
      <p className="quiet">
        {storeName
          ? 'Still on cards is the money left on cards sold at this store. It is not today’s sales minus today’s redemptions.'
          : 'Still on cards is the money left on every card, at every store. It is not today’s sales minus today’s redemptions.'}
      </p>
      {outstanding && outstanding.in_sync === false ? (
        <p className="note error">The card balances and the ledger do not match. Ask an admin to review the mismatch report.</p>
      ) : null}
    </section>
  );
}

export function Notice({ message, tone }) {
  if (!message) return null;
  return <p className={tone === 'error' ? 'note error' : 'note'} role="status">{message}</p>;
}

function History({ rows }) {
  if (!rows || !rows.length) return <p className="quiet">No transactions on this card yet.</p>;
  return (
    <ul className="history">
      {rows.slice().reverse().map((row) => (
        <li key={row.transaction_id}>
          <span>{labelFor(row)}</span>
          <span>{formatCents(signedAmount(row))}</span>
        </li>
      ))}
    </ul>
  );
}

function statusLabel(status) {
  if (status === 'PENDING') return 'Waiting for payment';
  if (status === 'ACTIVE') return 'Ready';
  if (status === 'SUSPENDED') return 'Suspended';
  if (status === 'DEPLETED') return 'Empty';
  if (status === 'CANCELLED') return 'Cancelled';
  return status || 'Card';
}

function labelFor(row) {
  const names = {
    ISSUE: 'Issued',
    ACTIVATE: 'Activated',
    REDEEM: 'Redeemed',
    RELOAD: 'Added value',
    REFUND: 'Refund',
    VOID: 'Void',
    ADJUSTMENT: 'Adjustment'
  };
  const name = names[row.transaction_type] || row.transaction_type;
  return row.transaction_status === 'COMPLETED' ? name : name + ' · ' + row.transaction_status;
}

function signedAmount(row) {
  if (row.transaction_type === 'REDEEM') return -row.amount_cents;
  if (row.transaction_type === 'REFUND') return row.balance_after_cents - row.balance_before_cents;
  if (row.transaction_type === 'ISSUE') return 0;
  return row.amount_cents;
}
