import { useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { formatCents } from './register.js';

export function SignIn({ clientId, onCredential, onPreview }) {
  const host = useRef(null);

  useEffect(() => {
    if (!clientId || !host.current) return undefined;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      if (!window.google || !host.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          if (response && response.credential) onCredential(response.credential);
        }
      });
      host.current.replaceChildren();
      window.google.accounts.id.renderButton(host.current, {
        type: 'standard',
        theme: 'filled_black',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
        width: 320
      });
    };
    document.head.appendChild(script);
    return () => script.remove();
  }, [clientId, onCredential]);

  return (
    <section className="signin">
      <div>
        <p className="kicker">Combat Veterans to Careers</p>
        <h1>The register</h1>
        <p className="lede">Look up a gift card, take a payment, or redeem a balance. Google confirms the account. The employee list confirms the person works here.</p>
      </div>
      <div className="panel stack">
        <h2>Sign in</h2>
        <p className="quiet">Typing an email on this page does not sign you in.</p>
        {clientId ? <div ref={host} id="google-signin" /> : (
          <p className="note">Add <code>VITE_GOOGLE_CLIENT_ID</code> and <code>VITE_APPS_SCRIPT_URL</code> to <code>web/.env</code>, then restart the register.</p>
        )}
        {import.meta.env.DEV ? (
          <button className="link" type="button" onClick={onPreview}>Preview the layout</button>
        ) : null}
      </div>
    </section>
  );
}

export function Identity({ session, locations, locationId, onLocation, onSignOut, onHome, onDesk }) {
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
          <button className="link" type="button" onClick={onDesk}>Today</button>
        ) : null}
        <button className="link" type="button" onClick={onSignOut}>Sign out</button>
      </div>
    </aside>
  );
}

export function Home({ onLookup, onSell, onBlanks, canManage }) {
  return (
    <section className="panel stage stack">
      <div className="stage-head">
        <h2>What do you need?</h2>
      </div>
      <button type="button" onClick={onLookup}>Find a card</button>
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

export function CardView({ card, history, amount, onAmount, paymentChecked, onPayment, onRedeem, onReload, onAssign, onSuspend, canManage, busy, sample }) {
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

export function Today({ sales, redemptions, outstanding }) {
  return (
    <section className="panel stage">
      <div className="stage-head">
        <div>
          <p className="kicker">Completed transactions</p>
          <h2>Today</h2>
        </div>
      </div>
      <div className="figures">
        <div>
          <span>Sold</span>
          <strong>{sales ? formatCents(sales.value_sold_cents) : '—'}</strong>
        </div>
        <div>
          <span>Redeemed</span>
          <strong>{redemptions ? formatCents(redemptions.value_redeemed_cents) : '—'}</strong>
        </div>
        <div>
          <span>Still outstanding</span>
          <strong>{outstanding ? formatCents(outstanding.outstanding_liability_cents) : '—'}</strong>
        </div>
      </div>
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
