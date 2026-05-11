'use strict';
/**
 * qa/lib/checks.js
 * Runner de checks com soft-assert: nunca quebra a execução; acumula
 * resultados (OK / WARN / FAIL) para o relatório final.
 */

const STATUS = Object.freeze({
  OK:   'OK',
  WARN: 'WARN',
  FAIL: 'FAIL',
});

function createRunner({ logger = console } = {}) {
  const results = [];
  let currentModule = null;

  function setModule(name) { currentModule = name; }

  function record(status, name, details = {}) {
    const entry = {
      module: currentModule || 'general',
      status,
      name,
      details,
      ts: new Date().toISOString(),
    };
    results.push(entry);
    const icon = status === STATUS.OK ? '✅' : status === STATUS.WARN ? '⚠️ ' : '❌';
    const ctx = currentModule ? `[${currentModule}] ` : '';
    logger.log(`${icon} ${ctx}${name}${details.note ? ' — ' + details.note : ''}`);
    return entry;
  }

  function ok(name, details)   { return record(STATUS.OK, name, details); }
  function warn(name, details) { return record(STATUS.WARN, name, details); }
  function fail(name, details) { return record(STATUS.FAIL, name, details); }

  // Helper: roda uma função de check protegida — qualquer throw vira FAIL.
  async function step(name, fn) {
    try {
      const out = await fn();
      // Se a função já registrou explicitamente, não duplica.
      if (out && out._recorded) return out;
      return ok(name);
    } catch (e) {
      return fail(name, { error: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
    }
  }

  // Asserções soft — registram WARN/FAIL sem interromper execução.
  function assert(cond, name, details = {}) {
    if (cond) return ok(name, details);
    return fail(name, details);
  }

  function expect(actual, op, expected, name, opts = {}) {
    const ops = {
      '===':       (a, b) => a === b,
      'gt':        (a, b) => a > b,
      'gte':       (a, b) => a >= b,
      'lt':        (a, b) => a < b,
      'lte':       (a, b) => a <= b,
      'includes':  (a, b) => Array.isArray(a) ? a.includes(b) : String(a).includes(b),
      'matches':   (a, b) => b.test(a),
      'truthy':    (a)    => !!a,
      'falsy':     (a)    => !a,
    };
    const f = ops[op];
    if (!f) throw new Error(`expect: operador desconhecido "${op}"`);
    const passed = expected === undefined ? f(actual) : f(actual, expected);
    const details = {
      actual: typeof actual === 'object' ? JSON.stringify(actual).slice(0, 200) : actual,
      expected,
      op,
      ...opts,
    };
    return passed
      ? ok(name, details)
      : (opts.softFail ? warn(name, details) : fail(name, details));
  }

  function summary() {
    const counts = { OK: 0, WARN: 0, FAIL: 0 };
    for (const r of results) counts[r.status]++;
    const total = results.length;
    return {
      total,
      counts,
      pct: {
        OK:   total ? +(counts.OK   / total * 100).toFixed(1) : 0,
        WARN: total ? +(counts.WARN / total * 100).toFixed(1) : 0,
        FAIL: total ? +(counts.FAIL / total * 100).toFixed(1) : 0,
      },
      passed: counts.FAIL === 0,
    };
  }

  return {
    STATUS,
    setModule,
    ok,
    warn,
    fail,
    step,
    assert,
    expect,
    results,
    summary,
  };
}

module.exports = { createRunner, STATUS };
