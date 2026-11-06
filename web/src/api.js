/** Posts the Google ID token to Apps Script. The body email is never sent. */

export async function callRegister(action, fields, idToken) {
  const url = import.meta.env.VITE_APPS_SCRIPT_URL;
  if (!url) {
    throw new Error('Add the Apps Script web app URL before using the register.');
  }
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action, idToken: idToken }, fields || {}))
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('The gift card service did not return a readable response.');
  }
  if (!payload || payload.ok !== true) {
    const failure = new Error((payload && payload.message) || 'The register could not complete that.');
    failure.code = payload && payload.code ? payload.code : 'INTERNAL';
    throw failure;
  }
  return payload.result;
}
