/**
 * Montana ERP — Sentry SDK integration (opcional)
 *
 * Instalação:
 *   npm install --save @sentry/node @sentry/profiling-node
 *
 * Configuração:
 *   SENTRY_DSN=https://...@sentry.io/...
 *   SENTRY_ENV=production|staging|development  (default: NODE_ENV)
 *   SENTRY_TRACES_SAMPLE_RATE=0.1               (10% das requests)
 *
 * Uso em src/server.js (logo após criar o app, ANTES de qualquer middleware):
 *   const sentry = require('./sentry');
 *   sentry.init();
 *   sentry.attachRequestHandler(app);   // primeiro middleware
 *   ...
 *   sentry.attachErrorHandler(app);     // ANTES do error handler global
 *
 * Sem SENTRY_DSN o módulo vira no-op (não quebra dev local).
 */
let Sentry = null;
let initialized = false;

function init() {
  if (initialized) return Sentry;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('  ℹ Sentry desabilitado (SENTRY_DSN não definido)');
    return null;
  }
  try {
    Sentry = require('@sentry/node');
  } catch (e) {
    console.warn('  ⚠ @sentry/node não instalado — `npm install @sentry/node`');
    return null;
  }

  let profiling = null;
  try { profiling = require('@sentry/profiling-node'); } catch (_) {}

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || (() => {
      try { return require('../package.json').version; } catch { return 'unknown'; }
    })(),
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE || '0.1'),
    integrations: profiling ? [profiling.nodeProfilingIntegration()] : [],

    // Ignora erros conhecidos / ruído
    ignoreErrors: [
      'EPIPE',
      'ECONNRESET',
      'Token inválido',
      'Token expirado',
      /^Não autorizado/i
    ],

    // Sanitiza dados sensíveis antes de enviar
    beforeSend(event, hint) {
      try {
        if (event.request) {
          // Remove headers de auth
          if (event.request.headers) {
            delete event.request.headers.authorization;
            delete event.request.headers.cookie;
          }
          // Remove campos sensíveis do body
          if (event.request.data && typeof event.request.data === 'object') {
            const SENSITIVE = ['password','senha','token','secret','client_secret','app_key','PG_PASSWORD','jwt'];
            for (const k of Object.keys(event.request.data)) {
              if (SENSITIVE.some(s => k.toLowerCase().includes(s))) {
                event.request.data[k] = '[REDACTED]';
              }
            }
          }
        }
      } catch (_) {}
      return event;
    }
  });

  initialized = true;
  console.log(`  📡 Sentry ativo (env=${process.env.SENTRY_ENV || process.env.NODE_ENV})`);
  return Sentry;
}

function attachRequestHandler(app) {
  if (!Sentry || !initialized) return;
  // Sentry v8+ usa setupExpressErrorHandler / requestHandler conforme versão
  if (typeof Sentry.Handlers?.requestHandler === 'function') {
    app.use(Sentry.Handlers.requestHandler());
    if (Sentry.Handlers.tracingHandler) app.use(Sentry.Handlers.tracingHandler());
  }
}

function attachErrorHandler(app) {
  if (!Sentry || !initialized) return;
  if (typeof Sentry.setupExpressErrorHandler === 'function') {
    Sentry.setupExpressErrorHandler(app);
  } else if (typeof Sentry.Handlers?.errorHandler === 'function') {
    app.use(Sentry.Handlers.errorHandler());
  }
}

function captureException(err, ctx) {
  if (!Sentry || !initialized) return;
  try { Sentry.captureException(err, ctx); } catch (_) {}
}

function captureMessage(msg, level) {
  if (!Sentry || !initialized) return;
  try { Sentry.captureMessage(msg, level || 'info'); } catch (_) {}
}

module.exports = {
  init,
  attachRequestHandler,
  attachErrorHandler,
  captureException,
  captureMessage,
  get instance() { return Sentry; }
};
