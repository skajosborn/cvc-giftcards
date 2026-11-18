let pending = null;

export function loadGoogleIdentity() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Google sign-in did not load.'));
  if (window.google && window.google.accounts && window.google.accounts.id) {
    return Promise.resolve(window.google.accounts.id);
  }
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        resolve(window.google.accounts.id);
        return;
      }
      pending = null;
      reject(new Error('Google sign-in did not load.'));
    };
    script.onerror = () => {
      pending = null;
      reject(new Error('Google sign-in did not load.'));
    };
    document.head.appendChild(script);
  });
  return pending;
}
