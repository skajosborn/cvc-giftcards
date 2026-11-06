# Restoring Hope Gift Cards

Database, Apps Script service, and employee register for Combat Veterans to Careers gift cards. Cards sold at one participating location can be redeemed at any other.

## Open the register

From this folder:

```bash
npm install --prefix web
npm run dev
```

Open `http://localhost:5173`. The sign-in screen is the live register. **Preview the layout** is only in local development. It is not a sign-in, and its buttons cannot change a gift card.

A real sign-in needs two values in `web/.env` (see `web/.env.example`):

- `VITE_GOOGLE_CLIENT_ID` — the same OAuth web client id stored as `GOOGLE_CLIENT_ID` in Apps Script
- `VITE_APPS_SCRIPT_URL` — the deployed web app URL ending in `/exec`

The register sends that Google ID token to Apps Script. It does not send an email address as proof of who is signed in. Deploy the web app as **Me**, and set access to your Workspace domain, or `ANYONE` if the account is not in a Workspace domain. The request uses `text/plain` so the browser can read the JSON response from Apps Script.

Participating locations are seeded as:

- Restoring Hope Thrift Store (`THRIFT`)
- Restoring Hope Boutique (`BOUTIQUE`)
- Honor Grounds Café (`CAFE`)

Addresses and phone numbers are left blank because none were provided. Add them later with `createLocation` for new sites, or edit those non-financial fields in the protected sheet only if you accept that a hand edit bypasses the service.

## Money

`initial_amount`, `current_balance`, `amount_cents`, `balance_before_cents`, and `balance_after_cents` are **integer cents**. `2500` is $25.00. The service rejects floats and numeric strings. Every API response that carries money includes `money_unit: "integer_cents"`.

## What the spreadsheet can and cannot guarantee

Google Sheets is not a database. It has no multi-row transactions and no unique constraints. The service uses the strongest practical controls Apps Script provides, and it does not pretend those controls are a real commit.

For every balance change the service:

1. Verifies a Google identity and an active employee role.
2. Validates the request, including an idempotency key.
3. Acquires `LockService.getScriptLock()`.
4. Re-reads the card while holding the lock.
5. Rejects the key if it was already used for a different payload.
6. Checks card status, pending repairs, and the integer-cent balance.
7. Appends a `PENDING` transaction that records the balance before and after.
8. Updates the card row.
9. Marks the transaction `COMPLETED`.
10. Calls `SpreadsheetApp.flush()` and releases the lock in a `finally` block.

Those spreadsheet writes are still separate. A crash or a timeout can leave a `PENDING` row, or a card that moved before the transaction was marked complete. `detectBalanceMismatches` compares each card with its completed ledger. `repairUnambiguousPendingTransactions` resolves only the case where that pending row is the card's latest transaction and the card still matches exactly one of the two expected states. Anything else stays pending for a person to review. The repair never deletes a row and never rewrites an amount.

`restoreCardBalanceFromLedger` is the manual-edit recovery. If someone changes a card balance by hand and the completed chain is intact, an admin can put the card row back to the ledger total. It refuses to guess when the chain itself is broken or a transaction is still pending.

Other limits, stated directly:

- The script lock serializes executions of this script. It does not stop a person typing in the sheet, and it does not coordinate with a second script project pointed at the same file.
- `LockService.getDocumentLock()` returns null for a standalone web app, so it is not used.
- Uniqueness of card numbers, QR tokens, emails, and idempotency keys is enforced by a scan under the lock. A hand edit can still insert a duplicate. The service then stops with `RECONCILIATION` instead of picking a row.
- The same execution cannot wait on its own lock. True overlap is across separate Apps Script executions. The tests assert the outcome that serialization is there to produce: two full-balance redemptions cannot both post, and a denied lock writes nothing.
- Completed amount columns are append-only. The only status changes are `PENDING` to `COMPLETED` or `FAILED`, and `COMPLETED` to `VOIDED` when an admin posts a compensating `VOID` row. Rows are never deleted.
- A void is the full reversal of one completed transaction. A transaction that already has a refund cannot be voided. Refund the remainder instead.
- This service does not take card payments. `paymentConfirmed: true` means the signed-in employee attests that payment was captured in the register. Activation and reload refuse any other value, including the string `"true"`.
- Anyone who can edit the Apps Script project can change these rules. Treat script editors as administrators.

## Identity

Cashiers do not get a password, and the sheet does not have a password column.

The web app is deployed to **execute as the person who deployed it**. That is what keeps the spreadsheet private. In that mode `Session.getActiveUser().getEmail()` is the deployer, or blank. It is not the cashier. The API therefore ignores `email` and `employeeId` on the request. A verified Google ID token is the only web identity:

- The token is checked with Google's tokeninfo endpoint.
- `aud` must equal the `GOOGLE_CLIENT_ID` script property.
- `email_verified` must be true.
- `iss` must be `accounts.google.com` or `https://accounts.google.com`.
- `exp` must be in the future.
- If `ALLOWED_EMAIL_DOMAIN` is set, the email domain must match.
- The verified email must belong to one active employee.

A missing token, an unverified email, a wrong audience, or an unknown person is denied. Denied attempts are written to `AUDIT_LOG` without the token. Audit rows also omit raw QR tokens and customer email addresses. A failed audit write does not turn the denial into an approval.

tokeninfo is a live call to Google. It checks the signature on Google's side, which is what makes the token an identity rather than a decoded blob. It also adds a network dependency, and Google documents that endpoint as a convenience rather than the library-based verifier used in other platforms. Apps Script has no built-in RSA verification against Google's published certificates. Do not replace this check with a base64 decode of the token body.

The first admin is the exception that stays inside the editor. `initializeDatabase({ bootstrapAdmin: { fullName, email } })` creates that admin only when `email` matches `Session.getActiveUser().getEmail()`. A blank email is refused. Run `showSignedInEmail` first and use exactly the address it prints.

Test tokens are HMAC values that exist only in memory during `runAllTests`. They are rejected unless `ALLOW_TEST_TOKENS` is `true`, the open spreadsheet is `TEST_SPREADSHEET_ID`, and that id is different from production. Do not set `ALLOW_TEST_TOKENS` on the production script.

## Roles

| Action | Admin | Manager | Employee |
| --- | --- | --- | --- |
| Locations, employees, access changes | Yes | No | No |
| Make a series of blank cards | Yes | Home location | No |
| Issue, activate, redeem, reload, check balance | All locations | Home location | Home location |
| Refund, suspend, reinstate, cancel a pending card | Yes | Yes | No |
| Void, balance adjustment, ledger repair, restore | Yes | No | No |
| Sales, redemptions, location transaction feed | All locations, or one | Home location only | No |
| Outstanding liability and mismatch detection | Organization | Organization | No |

Gift cards are valid at every active location. The transaction stores the location of the employee who performed it. A thrift-store employee cannot pass the café's location id. A café employee can redeem a card that was sold at the thrift store, and that redemption is attributed to the café.

Outstanding liability is organizational because an unredeemed card is an obligation of the program, not of the store that sold it. Sales and redemptions stay scoped to the manager's location.

The last active admin cannot be deactivated or demoted.

## Ledger rules

| Type | Effect on balance | Counts as |
| --- | --- | --- |
| `ISSUE` | None. Card is `PENDING` and the balance stays 0. | A card was created. Not a sale. |
| `ACTIVATE` | Balance becomes the sale amount. Card becomes `ACTIVE`. | Value sold. |
| `REDEEM` | Balance decreases. `0` becomes `DEPLETED`. | Value redeemed. |
| `RELOAD` | Balance increases. `DEPLETED` returns to `ACTIVE`. Requires payment confirmation. | Additional value sold. |
| `REFUND` | Reverses part or all of a redeem, activation, or reload. | Reduces the original category. |
| `VOID` | Appends the opposite balance movement and marks the original `VOIDED`. | Removes the original from reports. The void itself is not a new sale or redemption. |
| `ADJUSTMENT` | Admin credit or debit with a written reason. | Neither sales nor redemptions. It remains in the ledger and the audit log. |

`SUSPENDED` cards keep their balance, so they remain part of the liability, and they cannot be redeemed or reloaded. `cancelGiftCard` applies only to a pending card with a zero balance.

Reports total completed rows only. An activation plus its issue row is one sale, not two. A voided redemption is not left in the redemption total.

## QR codes

The server generates both identifiers. The client cannot choose them.

- `card_number` is a human-readable `RH-XXXX-XXXX-XXXX` value. It is not a secret.
- `qr_token` is 64 hex characters from two UUID v4 values. Apps Script draws those from `Utilities.getUuid()`, which is Java's `UUID.randomUUID()` and uses `SecureRandom`. It is not a sequential number.
- The printable payload is `rhgc:v1:<token>`. It has no balance, name, or email.
- Scanning the code does nothing financial by itself. The future app sends the token to an authenticated employee endpoint. The service then checks the employee before it returns a balance or posts a redemption.
- `createBlankGiftCards` makes 1 to 25 unsold cards. Each card has its own number, a secret scan token, and a balance of zero. The response returns every `qr_payload` so those codes can be printed before any sale. A repeated call with the same idempotency key and the same count returns the same cards. An employee cannot create the series.
- When a printed card is sold, `activateGiftCard` takes `amountCents` because the card does not have an amount yet. A card that was issued with an amount already keeps that amount.
- `createGiftCard` still issues one card with a chosen amount and returns its token once. A later read returns a token only to an admin, a manager, or the issuing employee while the card is still pending, and only when `includeQrToken` is true. Balance checks never return it.
- The issue transaction's `metadata_json` keeps the token and optional customer details so a crashed create can be rebuilt. That column is why the transactions sheet stays as private as the card sheet. It is not included in API responses or audit details.

## Workbook

`initializeDatabase` creates these sheets.

`LOCATIONS`: `location_id`, `location_name`, `location_type`, `address`, `phone`, `is_active`, `created_at`, `updated_at`

`EMPLOYEES`: `employee_id`, `full_name`, `email`, `role`, `location_id`, `is_active`, `created_at`, `updated_at`

`GIFT_CARDS`: `card_id`, `card_number`, `qr_token`, `initial_amount`, `current_balance`, `status`, `card_type`, `issued_at`, `activated_at`, `issued_location_id`, `issued_by_employee_id`, `customer_name`, `customer_email`, `created_at`, `updated_at`

`TRANSACTIONS`: `transaction_id`, `card_id`, `transaction_type`, `amount_cents`, `balance_before_cents`, `balance_after_cents`, `location_id`, `employee_id`, `register_reference`, `idempotency_key`, `related_transaction_id`, `transaction_status`, `notes`, `created_at`, `metadata_json`

`AUDIT_LOG`: `audit_id`, `employee_id`, `action`, `entity_type`, `entity_id`, `details`, `timestamp`

`META` records the schema version, the cents unit, and the financial limits above.

`metadata_json` is the extra column the pending-write recovery needs. Sheets cannot attach a hidden constraint to the other fields.

Header notes on the money and secret columns say the units and the handling rules. Sheets are protected so editors other than the deploying account are removed. Protection is a courtesy against casual edits. It is not a transaction system.

Default caps are $1,000.00 per operation and $5,000.00 on one card. Override them with script properties `MAX_SINGLE_AMOUNT_CENTS` and `MAX_BALANCE_CENTS` if the program needs different limits. `LOCK_TIMEOUT_MS` defaults to 30000.

## Project files

```
src/appsscript.json
src/Config.gs
src/Database.gs
src/Auth.gs
src/Validation.gs
src/Audit.gs
src/Locations.gs
src/Employees.gs
src/GiftCards.gs
src/Transactions.gs
src/Reports.gs
src/WebApp.gs
src/Tests.gs
test/gas-mocks.js
test/run-tests.js
```

`WebApp.gs` is the JSON endpoint the future React app will call. `initializeDatabase`, `showSignedInEmail`, and `runAllTests` are editor functions and are not web actions.

## Connect the sheet to Apps Script

1. Create a Google spreadsheet named `Restoring Hope Gift Cards`. Leave it empty.
2. Copy the spreadsheet id from the URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
3. Share the spreadsheet only with the account that will deploy the script. Do not share it with cashiers. They will use the app, and the script will read the sheet as the deployer.
4. Go to [script.google.com](https://script.google.com) and create a standalone project named `Restoring Hope Gift Cards`. A container-bound script from Extensions, Apps Script also works. The explicit id below is the setup to use either way.
5. Install [clasp](https://github.com/google/clasp) if you want to push from this repo:

   ```bash
   npm install -g @google/clasp
   clasp login
   cp .clasp.json.example .clasp.json
   ```

   Put the Apps Script id in `.clasp.json`, then run `clasp push`. You can also paste each `src/*.gs` file and `src/appsscript.json` into the editor.
6. In the Apps Script project, open Project Settings, then Script properties, and set:

   | Property | Value |
   | --- | --- |
   | `SPREADSHEET_ID` | The spreadsheet id from the URL |
   | `GOOGLE_CLIENT_ID` | OAuth web client id that the future React app will use as the ID-token audience |
   | `ALLOWED_EMAIL_DOMAIN` | Optional. Example: `yourdomain.org` |

   Leave `ALLOW_TEST_TOKENS` unset. Leave `TEST_SPREADSHEET_ID` unset on production.
7. Set the script timezone in `src/appsscript.json` if `America/Chicago` is wrong. Daily reports use that timezone.
8. Select `showSignedInEmail` and run it. Approve the spreadsheets, email, and external-request scopes. Copy the address it logs.
9. Select `initializeDatabase` and run it with this argument, using that same address:

   ```javascript
   function setupRestoringHope() {
     initializeDatabase({
       bootstrapAdmin: {
         fullName: 'Your Name',
         email: 'you@your-domain.org'
       }
     });
   }
   ```

   The workbook then has the six sheets, the three locations, and one admin. Running it again does not duplicate the locations or the admin.
10. Deploy, New deployment, Web app. Execute as **Me** (User deploying). Who has access: the Workspace domain. The manifest requests `DOMAIN`. If this Google account is not in a Workspace domain, change `webapp.access` in `appsscript.json` to `ANYONE` before deploying. Anyone who can reach the URL still has to present a verified token for an active employee. `ANYONE_ANONYMOUS` is not required and should not be used.
11. Copy the web app URL ending in `/exec`.

In the associated Google Cloud project, create an OAuth client of type Web application. Put its client id in `GOOGLE_CLIENT_ID`. The future React host's origin belongs on that client. The ID token's audience must be that client id, or the service will deny it.

### Calling the service from React later

`POST` JSON to the `/exec` URL:

```json
{
  "action": "redeemGiftCard",
  "idToken": "<Google ID token>",
  "cardId": "<uuid>",
  "amountCents": 1250,
  "locationId": "<uuid>",
  "idempotencyKey": "register-42-2026-11-05-0001"
}
```

Generate a new idempotency key for each attempt, and send that same key again if the response is lost. A replay of the same payload returns the original transaction with `replayed: true` and does not move the balance again. The same key with a different amount, card, or location returns `IDEMPOTENCY_CONFLICT`.

The response is JSON: `{ "ok": true, "result": { ... } }` or `{ "ok": false, "code": "INSUFFICIENT_FUNDS", "message": "..." }`.

Apps Script cannot set CORS headers. A browser on another origin will not be able to read this response directly. Put a small same-origin proxy in front of `/exec` when the React app is added. The proxy must forward the ID token and must not substitute an email address.

`doGet` returns only the service name and the money unit. It does not return cards.

## Tests

The automated suite is `src/Tests.gs`. Locally it runs against an in-memory spreadsheet:

```bash
npm test
```

That command does not call Google and does not open the production spreadsheet. The mock throws if any code path tries to open the production id.

Covered cases include creation, activation, payment confirmation, redemption, insufficient funds, idempotent replays, conflicting replays, reloads, refunds of redemptions and sales, suspended cards, spoofed email, forged and unverified Google tokens, cross-location redemption, a second full redemption after the balance is gone, lock denial, both partial-write stages, an ambiguous partial write that is left untouched, tamper detection and ledger restore, report totals, and voids.

To run `runAllTests` inside Apps Script, use a separate test script project and a disposable spreadsheet:

- `ALLOW_TEST_TOKENS` = `true`
- `TEST_SPREADSHEET_ID` = that disposable spreadsheet
- `SPREADSHEET_ID` = a different id, or blank
- `GOOGLE_CLIENT_ID` = any non-empty test audience

The runner refuses to start when the test id and the production id are the same.

## Operations the future app will call

`createLocation`, `listLocations`, `createEmployee`, `updateEmployeeAccess`, `createGiftCard`, `createBlankGiftCards`, `activateGiftCard`, `cancelGiftCard`, `getGiftCardById`, `getGiftCardByQRToken`, `checkGiftCardBalance`, `redeemGiftCard`, `reloadGiftCard`, `refundGiftCardTransaction`, `voidGiftCardTransaction`, `adjustGiftCardBalance`, `suspendGiftCard`, `reinstateGiftCard`, `getTransactionHistory`, `getLocationTransactions`, `getOutstandingGiftCardBalance`, `getGiftCardSalesReport`, `getGiftCardRedemptionReport`, `detectBalanceMismatches`, `repairUnambiguousPendingTransactions`, `restoreCardBalanceFromLedger`

Idempotency keys are 12 to 128 characters and may contain letters, numbers, and `. _ : -`. Amounts are positive integers. `locationId` is required for an admin. For everyone else it must be their own location, or omitted so the service uses that location.
