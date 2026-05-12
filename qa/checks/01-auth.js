'use strict';
/**
 * Check 01 — Autenticação e endpoints básicos.
 */

module.exports = async function checkAuth({ api, runner }) {
  runner.setModule('Auth');

  // Token já foi obtido no createClient — se chegou aqui, login passou.
  runner.assert(!!api.token, 'POST /api/auth/login retorna JWT', {
    note: 'token=' + api.token.slice(0, 30) + '…',
  });

  // /api/auth/me — pode ou não existir; reporta como observação.
  const me = await api.get('/api/auth/me');
  if (me.status === 404) {
    runner.warn('GET /api/auth/me', { note: 'endpoint não existe (404) — token decodificado só no front' });
  } else if (me.ok) {
    runner.ok('GET /api/auth/me', { note: 'retorna ' + me.status });
  } else {
    runner.warn('GET /api/auth/me', { note: 'status inesperado: ' + me.status });
  }

  // Endpoint inválido deve dar 401 sem token (verifica middleware ativo).
  const noAuth = await fetch(api.baseUrl + '/api/consolidado/resumo');
  runner.expect(noAuth.status, '===', 401,
    'Endpoint protegido sem Authorization retorna 401',
    { note: 'middleware de auth ativo' }
  );
};
