'use strict';
/**
 * qa/lib/api.js
 * Cliente HTTP com autenticação JWT para o sistema Montana.
 *
 * Uso:
 *   const api = await createClient({ baseUrl, usuario, senha });
 *   const r = await api.get('/api/consolidado/resumo');
 *   if (!r.ok) console.error(r.status, r.text);
 *   console.log(r.json);
 */

async function login(baseUrl, usuario, senha) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || !json?.token) {
    throw new Error(`Login falhou (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return json.token;
}

async function createClient({ baseUrl, usuario, senha, timeoutMs = 15000 }) {
  if (!baseUrl) throw new Error('baseUrl é obrigatório');
  if (!usuario || !senha) throw new Error('usuario/senha são obrigatórios');
  const token = await login(baseUrl, usuario, senha);

  async function request(method, path, { body, headers = {} } = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const ms = Date.now() - t0;
      return {
        ok: res.ok,
        status: res.status,
        ms,
        url,
        method,
        text,
        json,
        contentType: res.headers.get('content-type') || '',
      };
    } catch (e) {
      const ms = Date.now() - t0;
      return {
        ok: false,
        status: 0,
        ms,
        url,
        method,
        error: e.message,
        text: null,
        json: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    token,
    baseUrl,
    get:  (p, opts)       => request('GET',    p, opts),
    post: (p, body, opts) => request('POST',   p, { ...opts, body }),
    put:  (p, body, opts) => request('PUT',    p, { ...opts, body }),
    del:  (p, opts)       => request('DELETE', p, opts),
  };
}

module.exports = { createClient, login };
