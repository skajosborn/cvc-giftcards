import { useCallback, useEffect, useRef, useState } from 'react';
import { callRegister } from './api.js';
import { loadGoogleIdentity } from './googleIdentity.js';
import {
  dollarsToCents,
  forgetIdToken,
  formatCents,
  isCompleteCardNumber,
  msUntilIdTokenRefresh,
  newIdempotencyKey,
  normalizeCardNumber,
  parseBatchCount,
  cardsForStore,
  qrTokenFromScan,
  readStoredIdToken,
  reloadCardsOnStoreChange,
  reloadTodayOnStoreChange,
  rememberIdToken,
  startOfZonedDayIso,
  storeScopeFields,
  todayReportFields
} from './register.js';
import { BlankSeries, CardList, CardView, Home, Identity, Lookup, Notice, Sell, SignIn, Staff, Today } from './screens.jsx';
import cvcLogo from './CVC Logo.png';

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

const previewSession = {
  preview: true,
  employee: { full_name: 'Preview cashier', role: 'MANAGER', email: '', location_id: '' },
  location: { location_name: 'Restoring Hope Thrift Store', location_type: 'THRIFT', location_id: '' }
};

const sampleCard = {
  card_id: 'sample',
  card_number: 'RH-SAMP-LEAB-CDEF',
  status: 'ACTIVE',
  current_balance: 2500,
  initial_amount: 2500,
  customer_name: 'Sample only'
};

const sampleBlanks = [
  { card_number: 'RH-SAMP-LEAB-CDEF', qr_payload: 'rhgc:v1:' + 'ab'.repeat(32) },
  { card_number: 'RH-SAMP-LEBB-CDEF', qr_payload: 'rhgc:v1:' + 'cd'.repeat(32) }
];

export default function App() {
  const [idToken, setIdToken] = useState(() => readStoredIdToken(window.localStorage));
  const [session, setSession] = useState(null);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [screen, setScreen] = useState('home');
  const [cardNumber, setCardNumber] = useState('');
  const [bundle, setBundle] = useState(null);
  const [amount, setAmount] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [paymentChecked, setPaymentChecked] = useState(false);
  const [draft, setDraft] = useState({ amount: '', cardType: 'PHYSICAL', customerName: '' });
  const [issued, setIssued] = useState(null);
  const [blankCount, setBlankCount] = useState('10');
  const [blanks, setBlanks] = useState(null);
  const blankKey = useRef('');
  const deskRequest = useRef(0);
  const [desk, setDesk] = useState(null);
  const [people, setPeople] = useState([]);
  const [issuedCards, setIssuedCards] = useState([]);
  const [cardsLocationId, setCardsLocationId] = useState(null);
  const cardsRequest = useRef(0);
  const [hire, setHire] = useState({ fullName: '', email: '', role: 'EMPLOYEE', locationId: '' });
  const [scanning, setScanning] = useState(false);
  const [scannerNote, setScannerNote] = useState('');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('');
  const [busy, setBusy] = useState(false);

  const preview = Boolean(session && session.preview);
  const canManage = session && (session.employee.role === 'ADMIN' || session.employee.role === 'MANAGER');

  const report = useCallback((text, nextTone) => {
    setMessage(text);
    setTone(nextTone || '');
  }, []);

  const acceptCredential = useCallback((token) => {
    if (!token) return;
    rememberIdToken(window.localStorage, token);
    setIdToken(token);
  }, []);

  useEffect(() => {
    if (!idToken) return undefined;
    let cancelled = false;
    setBusy(true);
    callRegister('getSession', {}, idToken)
      .then((result) => {
        if (cancelled) return;
        setSession(result);
        setLocationId(result.location ? result.location.location_id : '');
        if (result.employee.role === 'ADMIN') {
          return callRegister('listLocations', {}, idToken).then((listed) => {
            if (!cancelled) setLocations(listed.locations || []);
          });
        }
        return null;
      })
      .catch((error) => {
        if (!cancelled) {
          forgetIdToken(window.localStorage);
          setIdToken('');
          report(error.message, 'error');
        }
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [idToken, report]);

  useEffect(() => {
    if (!clientId || !idToken) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      loadGoogleIdentity().then((gis) => {
        if (cancelled) return;
        gis.initialize({
          client_id: clientId,
          auto_select: true,
          callback: (response) => {
            if (response && response.credential) acceptCredential(response.credential);
          }
        });
        gis.prompt();
      }).catch(() => {});
    }, msUntilIdTokenRefresh(idToken, Date.now()));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [clientId, idToken, acceptCredential]);

  function actingLocation() {
    if (preview) return '';
    return locationId;
  }

  function requireLocation() {
    if (session.employee.role === 'ADMIN' && !locationId) {
      throw new Error('Choose the store you are standing in.');
    }
    if (session.employee.role !== 'ADMIN' && !locationId) {
      throw new Error('Your employee record has no store. Ask an admin to assign one.');
    }
  }

  async function openCard(query) {
    const card = query.qrToken
      ? await callRegister('getGiftCardByQRToken', { qrToken: query.qrToken }, idToken)
      : await (async () => {
        const balance = await callRegister('checkGiftCardBalance', { cardNumber: query.cardNumber }, idToken);
        return callRegister('getGiftCardById', { cardId: balance.card_id }, idToken);
      })();
    const history = await callRegister('getTransactionHistory', { cardId: card.card_id }, idToken);
    setBundle({ card: card, history: history.transactions || [] });
    setAmount('');
    setBuyerName(card.customer_name || '');
    setPaymentChecked(false);
    setScreen('card');
  }

  async function run(work) {
    setBusy(true);
    report('');
    try {
      await work();
    } catch (error) {
      report(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function findCard() {
    if (preview) {
      setBundle({ card: sampleCard, history: [] });
      setScreen('card');
      report('Sample card. Nothing was looked up.');
      return;
    }
    const number = normalizeCardNumber(cardNumber);
    if (!isCompleteCardNumber(number)) {
      report('Enter the full card number from the gift card.', 'error');
      return;
    }
    await run(() => openCard({ cardNumber: number }));
  }

  async function scan() {
    if (preview) {
      report('The preview cannot use the camera. Sign in to scan a real card.');
      return;
    }
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
      report('This browser cannot scan QR codes. Type the card number instead.', 'error');
      return;
    }
    setScanning(true);
    setScannerNote('Point the camera at the gift card code.');
    let stream;
    try {
      const video = await waitForVideo();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const started = Date.now();
      while (Date.now() - started < 20000) {
        const codes = await detector.detect(video);
        const token = codes.length ? qrTokenFromScan(codes[0].rawValue) : '';
        if (token) {
          setScanning(false);
          stream.getTracks().forEach((track) => track.stop());
          await run(() => openCard({ qrToken: token }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      report('No gift card code was found. Type the card number.', 'error');
    } catch (error) {
      report(error.message || 'The camera could not be opened.', 'error');
    } finally {
      setScanning(false);
      if (stream) stream.getTracks().forEach((track) => track.stop());
    }
  }

  async function redeem() {
    await run(async () => {
      const cents = dollarsToCents(amount);
      if (bundle.card.current_balance < cents) throw new Error('That amount is more than the balance.');
      requireLocation();
      const result = await callRegister('redeemGiftCard', {
        cardId: bundle.card.card_id,
        amountCents: cents,
        locationId: actingLocation(),
        idempotencyKey: newIdempotencyKey('redeem')
      }, idToken);
      setBundle({ card: result.card, history: bundle.history });
      setAmount('');
      const refreshed = await refreshHistory(result.card);
      report(refreshed ? 'Redeemed ' + formatCents(cents) + '.' : 'The balance changed, but the history could not be refreshed.', refreshed ? '' : 'error');
    });
  }

  async function reload() {
    await run(async () => {
      if (!paymentChecked) throw new Error('Confirm that the payment is in the register before adding value.');
      const cents = dollarsToCents(amount);
      requireLocation();
      const result = await callRegister('reloadGiftCard', {
        cardId: bundle.card.card_id,
        amountCents: cents,
        locationId: actingLocation(),
        paymentConfirmed: true,
        idempotencyKey: newIdempotencyKey('reload')
      }, idToken);
      setBundle({ card: result.card, history: bundle.history });
      setAmount('');
      setPaymentChecked(false);
      const refreshed = await refreshHistory(result.card);
      report(refreshed ? 'Added ' + formatCents(cents) + '.' : 'The balance changed, but the history could not be refreshed.', refreshed ? '' : 'error');
    });
  }

  async function refreshHistory(card) {
    try {
      const history = await callRegister('getTransactionHistory', { cardId: card.card_id }, idToken);
      setBundle({ card: card, history: history.transactions || [] });
      return true;
    } catch (error) {
      return false;
    }
  }

  async function suspend() {
    await run(async () => {
      const result = await callRegister('suspendGiftCard', { cardId: bundle.card.card_id }, idToken);
      setBundle(Object.assign({}, bundle, { card: result.card }));
      report(result.changed ? 'Card suspended.' : 'The card was already suspended.');
    });
  }

  async function createCard() {
    if (preview) {
      report('The preview cannot create a card.');
      return;
    }
    await run(async () => {
      const cents = dollarsToCents(draft.amount);
      requireLocation();
      const result = await callRegister('createGiftCard', {
        initialAmountCents: cents,
        cardType: draft.cardType,
        customerName: draft.customerName,
        locationId: actingLocation(),
        idempotencyKey: newIdempotencyKey('issue')
      }, idToken);
      setIssued(result);
      setPaymentChecked(false);
      report('Card created. It has no balance until you activate it.');
    });
  }

  async function makeBlanks() {
    if (preview) {
      setBlanks(sampleBlanks);
      setScreen('blanks');
      report('Sample numbers. The preview did not create cards.');
      return;
    }
    if (!blankKey.current) blankKey.current = newIdempotencyKey('blanks');
    await run(async () => {
      const count = parseBatchCount(blankCount);
      requireLocation();
      const result = await callRegister('createBlankGiftCards', {
        count: count,
        cardType: 'PHYSICAL',
        locationId: actingLocation(),
        idempotencyKey: blankKey.current
      }, idToken);
      blankKey.current = '';
      setBlanks(result.cards || []);
      setScreen('blanks');
      report(result.replayed ? 'This series was already created.' : 'Made ' + result.count + (result.count === 1 ? ' card' : ' cards') + ' at $0.');
    });
  }

  function previewSale(card) {
    setBundle({
      card: {
        card_id: card.card_number,
        card_number: card.card_number,
        status: 'PENDING',
        current_balance: 0,
        initial_amount: 0,
        customer_name: 'Sample only'
      },
      history: []
    });
    setAmount('');
    setBuyerName('');
    setPaymentChecked(false);
    setScreen('card');
    report('Sample unsold card. The preview cannot put a balance on it.');
  }

  async function assignBalance() {
    if (preview) {
      report('The preview cannot put a balance on a card.');
      return;
    }
    await run(async () => {
      if (!paymentChecked) throw new Error('Confirm that the payment is in the register before putting a balance on this card.');
      requireLocation();
      const openValue = !bundle.card.initial_amount;
      const cents = openValue ? dollarsToCents(amount) : bundle.card.initial_amount;
      const fields = {
        cardId: bundle.card.card_id,
        locationId: actingLocation(),
        paymentConfirmed: true,
        idempotencyKey: newIdempotencyKey('activate')
      };
      if (openValue) fields.amountCents = cents;
      if (buyerName.trim()) fields.customerName = buyerName.trim();
      const result = await callRegister('activateGiftCard', fields, idToken);
      setBundle({ card: result.card, history: bundle.history });
      setAmount('');
      setBuyerName('');
      setPaymentChecked(false);
      const refreshed = await refreshHistory(result.card);
      report(refreshed
        ? 'Balance is now ' + formatCents(cents) + '.'
        : 'The balance was added, but the history could not be refreshed.', refreshed ? '' : 'error');
    });
  }

  async function activate() {
    if (!issued || !paymentChecked) return;
    await run(async () => {
      const result = await callRegister('activateGiftCard', {
        cardId: issued.card.card_id,
        locationId: actingLocation(),
        paymentConfirmed: true,
        idempotencyKey: newIdempotencyKey('activate')
      }, idToken);
      setIssued(null);
      setDraft({ amount: '', cardType: 'PHYSICAL', customerName: '' });
      setBundle({ card: result.card, history: [] });
      setScreen('card');
      const refreshed = await refreshHistory(result.card);
      report(refreshed ? 'Card activated.' : 'The card is active, but the history could not be refreshed.', refreshed ? '' : 'error');
    });
  }

  function openCardList() {
    loadCards(locationId);
  }

  function openListedCard(card) {
    if (preview) {
      setBundle({ card: sampleCard, history: [] });
      setScreen('card');
      report('Sample card. Nothing was looked up.');
      return;
    }
    run(() => openCard({ cardNumber: card.card_number }));
  }

  function openStaff() {
    setScreen('staff');
    if (preview) {
      setLocations([
        { location_id: 'thrift', location_name: 'Restoring Hope Thrift Store' },
        { location_id: 'boutique', location_name: 'Restoring Hope Boutique' },
        { location_id: 'cafe', location_name: 'Honor Grounds Café' }
      ]);
      setPeople([{
        employee_id: 'preview-admin',
        full_name: 'Preview cashier',
        email: 'preview@restoringhope.test',
        role: 'ADMIN',
        location_id: '',
        is_active: true
      }]);
      report('Sample staff. The preview cannot add a person.');
      return;
    }
    if (!hire.locationId && locationId) {
      setHire(Object.assign({}, hire, { locationId: locationId }));
    }
    run(async () => {
      const listed = await callRegister('listEmployees', {}, idToken);
      setPeople(listed.employees || []);
    });
  }

  async function addEmployee() {
    if (preview) {
      report('Preview stops here. You are not signed in.');
      return;
    }
    const fullName = hire.fullName.trim();
    const email = hire.email.trim();
    if (!fullName || !email) {
      report('Enter a name and the Google email.', 'error');
      return;
    }
    if (hire.role !== 'ADMIN' && !hire.locationId) {
      report('Choose the store for this person.', 'error');
      return;
    }
    await run(async () => {
      const fields = { fullName: fullName, email: email, role: hire.role };
      if (hire.role !== 'ADMIN') fields.locationId = hire.locationId;
      await callRegister('createEmployee', fields, idToken);
      const listed = await callRegister('listEmployees', {}, idToken);
      setPeople(listed.employees || []);
      setHire({ fullName: '', email: '', role: 'EMPLOYEE', locationId: hire.locationId });
      report(fullName + ' can sign in.');
    });
  }

  async function toggleEmployee(person) {
    if (preview) {
      report('Preview stops here. You are not signed in.');
      return;
    }
    await run(async () => {
      await callRegister('updateEmployeeAccess', {
        employeeId: person.employee_id,
        isActive: person.is_active !== true
      }, idToken);
      const listed = await callRegister('listEmployees', {}, idToken);
      setPeople(listed.employees || []);
      report(person.is_active === true
        ? person.full_name + ' can no longer sign in.'
        : person.full_name + ' can sign in again.');
    });
  }

  function changeStore(nextLocationId) {
    setLocationId(nextLocationId);
    if (reloadTodayOnStoreChange(screen)) loadDesk(nextLocationId);
    if (reloadCardsOnStoreChange(screen)) loadCards(nextLocationId);
  }

  async function loadCards(nextLocationId) {
    const chosen = typeof nextLocationId === 'string' ? nextLocationId : locationId;
    setScreen('cards');
    if (preview) {
      setIssuedCards(cardsForStore([
        {
          card_id: 'sample-active',
          card_number: 'RH-SAMP-LEAB-CDEF',
          customer_name: 'Jordan Customer',
          current_balance: 3150,
          status: 'ACTIVE',
          issued_location_id: 'cafe',
          issued_location_name: 'Honor Grounds Café'
        },
        {
          card_id: 'sample-pending',
          card_number: 'RH-SAMP-LEBB-CDEF',
          customer_name: '',
          current_balance: 0,
          status: 'PENDING',
          issued_location_id: 'boutique',
          issued_location_name: 'Restoring Hope Boutique'
        }
      ], chosen));
      setCardsLocationId(chosen);
      report('Sample cards. The preview is not the live list.');
      return;
    }
    const requestId = cardsRequest.current + 1;
    cardsRequest.current = requestId;
    setBusy(true);
    report('');
    try {
      const listed = await callRegister('listGiftCards', storeScopeFields(chosen), idToken);
      if (cardsRequest.current !== requestId) return;
      setIssuedCards(cardsForStore(listed.cards || [], chosen));
      setCardsLocationId(chosen);
    } catch (error) {
      if (cardsRequest.current !== requestId) return;
      report(error.message, 'error');
    } finally {
      if (cardsRequest.current === requestId) setBusy(false);
    }
  }

  async function loadDesk(nextLocationId) {
    const chosen = typeof nextLocationId === 'string' ? nextLocationId : locationId;
    if (preview) {
      setDesk({
        sales: { value_sold_cents: 0 },
        redemptions: { value_redeemed_cents: 0 },
        outstanding: { outstanding_liability_cents: 0, in_sync: true },
        forLocationId: chosen
      });
      setScreen('desk');
      report('Sample totals. The preview is not connected.');
      return;
    }
    const requestId = deskRequest.current + 1;
    deskRequest.current = requestId;
    setBusy(true);
    report('');
    try {
      const fields = todayReportFields(chosen, startOfZonedDayIso('America/Chicago'));
      const [sales, redemptions, outstanding] = await Promise.all([
        callRegister('getGiftCardSalesReport', fields, idToken),
        callRegister('getGiftCardRedemptionReport', fields, idToken),
        callRegister('getOutstandingGiftCardBalance', storeScopeFields(chosen), idToken)
      ]);
      if (deskRequest.current !== requestId) return;
      setDesk({
        sales: sales,
        redemptions: redemptions,
        outstanding: outstanding,
        forLocationId: chosen
      });
      setScreen('desk');
    } catch (error) {
      if (deskRequest.current !== requestId) return;
      report(error.message, 'error');
    } finally {
      if (deskRequest.current === requestId) setBusy(false);
    }
  }

  async function signOut() {
    forgetIdToken(window.localStorage);
    try {
      const gis = await loadGoogleIdentity();
      gis.disableAutoSelect();
    } catch (error) {
      // Sign-out still clears this register when Google is unreachable.
    }
    setIdToken('');
    setSession(null);
    setLocations([]);
    setBundle(null);
    setIssued(null);
    setDesk(null);
    setIssuedCards([]);
    setCardsLocationId(null);
    setScreen('home');
    report('');
  }

  if (!session) {
    return (
      <main className="register landing">
        <Notice message={message} tone={tone} />
        <SignIn clientId={clientId} restoring={Boolean(idToken)} onCredential={acceptCredential} onPreview={() => { setSession(previewSession); report(''); }} />
      </main>
    );
  }

  return (
    <>
      {preview ? <p className="preview-banner">Layout preview. You are not signed in. These controls cannot change a gift card.</p> : null}
      <main className="register">
        <header className="mast">
          <div className="brand">
            <img className="brand-logo" src={cvcLogo} alt="" />
            <div className="brand-lockup">
              <p className="brand-name">Combat Veterans<br />to Careers</p>
              <p className="brand-hope">Restoring Hope</p>
            </div>
          </div>
          <p className="scene-label">Gift card management</p>
        </header>
        <Notice message={message} tone={tone} />
        <div className="workspace">
          <Identity
            session={session}
            locations={locations}
            locationId={locationId}
            onLocation={changeStore}
            onSignOut={signOut}
            onHome={() => { setScreen('home'); setIssued(null); report(''); }}
            onDesk={loadDesk}
            onStaff={openStaff}
            onCards={openCardList}
          />
          {screen === 'home' ? (
            <Home
              onLookup={() => setScreen('lookup')}
              onCards={openCardList}
              onSell={() => { setIssued(null); setScreen('sell'); }}
              onBlanks={() => { setBlanks(null); setScreen('blanks'); report(''); }}
              canManage={canManage}
            />
          ) : null}
          {screen === 'lookup' ? (
            <Lookup
              cardNumber={cardNumber}
              onCardNumber={(value) => setCardNumber(normalizeCardNumber(value))}
              onFind={findCard}
              onScan={scan}
              scanning={scanning}
              scannerNote={scannerNote}
              busy={busy}
            />
          ) : null}
          {screen === 'card' && bundle ? (
            <CardView
              card={bundle.card}
              history={bundle.history}
              amount={amount}
              onAmount={setAmount}
              buyerName={buyerName}
              onBuyerName={setBuyerName}
              paymentChecked={paymentChecked}
              onPayment={setPaymentChecked}
              onRedeem={redeem}
              onReload={reload}
              onAssign={assignBalance}
              onSuspend={suspend}
              canManage={canManage}
              busy={busy}
              sample={preview}
            />
          ) : null}
          {screen === 'blanks' ? (
            <BlankSeries
              count={blankCount}
              onCount={setBlankCount}
              onCreate={makeBlanks}
              cards={blanks}
              onSampleSale={previewSale}
              busy={busy}
              sample={preview}
            />
          ) : null}
          {screen === 'sell' ? (
            <Sell
              draft={draft}
              issued={issued}
              onDraft={(patch) => setDraft(Object.assign({}, draft, patch))}
              onCreate={createCard}
              onActivate={activate}
              paymentChecked={paymentChecked}
              onPayment={setPaymentChecked}
              busy={busy}
              sample={preview}
            />
          ) : null}
          {screen === 'desk' && desk ? (
            <Today
              sales={desk.forLocationId === locationId ? desk.sales : null}
              redemptions={desk.forLocationId === locationId ? desk.redemptions : null}
              outstanding={desk.forLocationId === locationId ? desk.outstanding : null}
              pending={desk.forLocationId !== locationId}
              storeName={(locations.find((location) => location.location_id === locationId) || {}).location_name || ''}
            />
          ) : null}
          {screen === 'cards' ? (
            <CardList
              cards={cardsLocationId === locationId ? issuedCards : []}
              storeName={(locations.find((location) => location.location_id === locationId) || {}).location_name || ''}
              pending={cardsLocationId !== locationId}
              onOpen={openListedCard}
            />
          ) : null}
          {screen === 'staff' ? (
            <Staff
              people={people}
              locations={locations}
              draft={hire}
              onDraft={(patch) => setHire(Object.assign({}, hire, patch))}
              onCreate={addEmployee}
              onToggle={toggleEmployee}
              busy={busy}
              sample={preview}
            />
          ) : null}
        </div>
      </main>
    </>
  );
}

function waitForVideo() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const video = document.getElementById('qr-video');
      if (video) resolve(video);
      else if (tries > 30) reject(new Error('The camera view is not on the page.'));
      else {
        tries += 1;
        requestAnimationFrame(tick);
      }
    };
    tick();
  });
}
