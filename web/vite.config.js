import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function appsScriptProxy(scriptUrl) {
  return {
    name: 'apps-script-proxy',
    configureServer(server) {
      server.middlewares.use('/apps-script', async (req, res) => {
        if (!scriptUrl) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, code: 'INTERNAL', message: 'Add the Apps Script web app URL before using the register.' }));
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        try {
          const upstream = await forwardToScript(scriptUrl, body);
          const text = await upstream.text();
          if (upstream.status === 404) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ok: false,
              code: 'INTERNAL',
              message: 'Google could not find that web app. In Apps Script, edit the deployment and set Who has access to Anyone, then copy the new /exec URL.'
            }));
            return;
          }
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(text);
        } catch {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, code: 'INTERNAL', message: 'The gift card service did not respond.' }));
        }
      });
    }
  };
}

async function forwardToScript(scriptUrl, body) {
  const first = await fetch(scriptUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body
  });
  if (![301, 302, 303, 307, 308].includes(first.status)) return first;
  const next = first.headers.get('location');
  if (!next) return first;
  return fetch(next, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body
  });
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  return {
    plugins: [react(), appsScriptProxy(env.VITE_APPS_SCRIPT_URL)],
    server: {
      port: 5173,
      strictPort: true
    }
  };
});
