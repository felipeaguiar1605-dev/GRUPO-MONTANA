#!/usr/bin/env node
/**
 * Cliente CDP (Chrome DevTools Protocol) minimal — sem dependências externas.
 * Conecta numa instância do Chrome rodando com --remote-debugging-port=9222
 * pra ler/navegar/capturar páginas já abertas no browser do usuário.
 *
 * Requisito: Node 21+ (WebSocket nativo).
 *
 * Uso:
 *   node scripts/webiss-cdp.js list
 *   node scripts/webiss-cdp.js screenshot <substring-url> [output.png]
 *   node scripts/webiss-cdp.js fullshot   <substring-url> [output.png]   (página inteira)
 *   node scripts/webiss-cdp.js text       <substring-url>
 *   node scripts/webiss-cdp.js html       <substring-url>
 *   node scripts/webiss-cdp.js scroll     <substring-url> <pixels>       (positivo = baixo)
 *   node scripts/webiss-cdp.js scrollend  <substring-url>                (vai pro fim da página)
 *   node scripts/webiss-cdp.js eval       <substring-url> <js-expr>
 *   node scripts/webiss-cdp.js pdf        <substring-url> [output.pdf]
 *   node scripts/webiss-cdp.js click      <substring-url> <css-selector>
 *   node scripts/webiss-cdp.js navigate   <substring-url> <new-url>
 *   node scripts/webiss-cdp.js fetch      <substring-tab> <url> <output-file>  (faz fetch no contexto da aba e salva localmente)
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const CDP_HOST = process.env.WEBISS_CDP_HOST || '127.0.0.1';
const CDP_PORT = parseInt(process.env.WEBISS_CDP_PORT || '9222', 10);

// ---------- HTTP helpers ----------
function httpGetJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try { res(JSON.parse(body)); } catch (e) { rej(new Error(`JSON parse: ${e.message}\nBody: ${body.slice(0,200)}`)); }
      });
    }).on('error', rej);
  });
}

async function listTabs() {
  return httpGetJson(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
}

async function findTab(substring) {
  const tabs = await listTabs();
  const filter = (substring || '').toLowerCase();
  const matches = tabs.filter(t =>
    t.type === 'page' && (t.url || '').toLowerCase().includes(filter)
  );
  if (matches.length === 0) {
    const all = tabs.filter(t => t.type === 'page').map(t => t.url).join('\n  ');
    throw new Error(`Nenhuma aba contendo "${substring}". Abas abertas:\n  ${all}`);
  }
  if (matches.length > 1) {
    console.error(`⚠ ${matches.length} abas batem em "${substring}" — usando a primeira:`);
    for (const m of matches) console.error(`  - ${m.url}`);
  }
  return matches[0];
}

// ---------- CDP Session ----------
class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
    this.ws.addEventListener('error', ev => {
      // Rejeita todas as pending pra não pendurar
      for (const { reject } of this.pending.values()) reject(new Error('WebSocket erro'));
      this.pending.clear();
    });
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error(`Falhou conectar em ${this.wsUrl}`)), { once: true });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      // Timeout de 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try { this.ws?.close(); } catch (_) {}
  }
}

async function openSession(tab) {
  if (!tab.webSocketDebuggerUrl) throw new Error('Aba não tem webSocketDebuggerUrl (provavelmente outra extensão devtools já anexou)');
  const session = new CdpSession(tab.webSocketDebuggerUrl);
  await session.open();
  // Habilita o que costuma ser necessário
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  return session;
}

// ---------- Comandos de alto nível ----------
async function cmdList() {
  const tabs = await listTabs();
  const pages = tabs.filter(t => t.type === 'page');
  console.log(`${pages.length} aba(s) tipo page:`);
  for (const t of pages) {
    console.log(`  [${t.id}] ${t.title}`);
    console.log(`        ${t.url}`);
  }
}

async function cmdScreenshot(substring, outPath, fullPage = false) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    if (fullPage) {
      // Pega altura total da página e ajusta viewport
      const { result } = await s.send('Runtime.evaluate', {
        expression: 'JSON.stringify({w:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth), h:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)})',
        returnByValue: true,
      });
      const { w, h } = JSON.parse(result.value);
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: Math.min(w, 1920),
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    const { data } = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    if (fullPage) await s.send('Emulation.clearDeviceMetricsOverride');
    const buf = Buffer.from(data, 'base64');
    const out = outPath || path.join(os.tmpdir(), `webiss-${Date.now()}.png`);
    await fs.writeFile(out, buf);
    console.log(`OK: ${out} (${buf.length} bytes)`);
    console.log(`URL: ${tab.url}`);
  } finally { s.close(); }
}

async function cmdText(substring) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    const { result } = await s.send('Runtime.evaluate', {
      expression: 'document.body.innerText',
      returnByValue: true,
    });
    process.stdout.write(`URL: ${tab.url}\nTITLE: ${tab.title}\n\n`);
    process.stdout.write(result.value || '');
    process.stdout.write('\n');
  } finally { s.close(); }
}

async function cmdHtml(substring) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    const { result } = await s.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    process.stdout.write(result.value || '');
  } finally { s.close(); }
}

async function cmdScroll(substring, pixels) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    await s.send('Runtime.evaluate', {
      expression: `window.scrollBy(0, ${Number(pixels) || 0}); ({y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight})`,
      returnByValue: true,
    });
    console.log(`Scrolled ${pixels}px em ${tab.url}`);
  } finally { s.close(); }
}

async function cmdScrollEnd(substring) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    await s.send('Runtime.evaluate', {
      expression: `window.scrollTo(0, document.documentElement.scrollHeight)`,
    });
    console.log(`Scroll até o fim em ${tab.url}`);
  } finally { s.close(); }
}

async function cmdEval(substring, expr) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    const { result, exceptionDetails } = await s.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      console.error('Exception:', exceptionDetails.text || exceptionDetails.exception?.description);
      process.exit(1);
    }
    if (result.type === 'object' || result.type === 'undefined') {
      console.log(JSON.stringify(result.value, null, 2));
    } else {
      console.log(result.value);
    }
  } finally { s.close(); }
}

async function cmdPdf(substring, outPath) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    const { data } = await s.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });
    const buf = Buffer.from(data, 'base64');
    const out = outPath || path.join(os.tmpdir(), `webiss-${Date.now()}.pdf`);
    await fs.writeFile(out, buf);
    console.log(`OK: ${out} (${buf.length} bytes)`);
  } finally { s.close(); }
}

async function cmdClick(substring, selector) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    const { result, exceptionDetails } = await s.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    console.log(`click(${selector}): ${result.value}`);
  } finally { s.close(); }
}

async function cmdFetch(substring, url, outPath) {
  if (!url || !outPath) throw new Error('Uso: fetch <substring-tab> <url> <output-file>');
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      const text = await r.text();
      return { status: r.status, ct: r.headers.get('content-type'), len: text.length, text };
    })()`;
    const { result, exceptionDetails } = await s.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || exceptionDetails.exception?.description);
    const { status, ct, len, text } = result.value;
    if (status >= 400) throw new Error(`HTTP ${status} ao buscar ${url}`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, text);
    console.log(`OK ${status} ${ct} ${len}B → ${outPath}`);
  } finally { s.close(); }
}

async function cmdNavigate(substring, newUrl) {
  const tab = await findTab(substring);
  const s = await openSession(tab);
  try {
    await s.send('Page.navigate', { url: newUrl });
    console.log(`Navegando ${tab.url} → ${newUrl}`);
  } finally { s.close(); }
}

// ---------- CLI ----------
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'list':       return await cmdList();
      case 'screenshot': return await cmdScreenshot(args[0] || 'webiss', args[1], false);
      case 'fullshot':   return await cmdScreenshot(args[0] || 'webiss', args[1], true);
      case 'text':       return await cmdText(args[0] || 'webiss');
      case 'html':       return await cmdHtml(args[0] || 'webiss');
      case 'scroll':     return await cmdScroll(args[0] || 'webiss', args[1]);
      case 'scrollend':  return await cmdScrollEnd(args[0] || 'webiss');
      case 'eval':       return await cmdEval(args[0] || 'webiss', args.slice(1).join(' '));
      case 'pdf':        return await cmdPdf(args[0] || 'webiss', args[1]);
      case 'click':      return await cmdClick(args[0] || 'webiss', args[1]);
      case 'navigate':   return await cmdNavigate(args[0] || 'webiss', args[1]);
      case 'fetch':      return await cmdFetch(args[0] || 'webiss', args[1], args[2]);
      default:
        console.error('Comando inválido. Veja o cabeçalho do arquivo pra usos válidos.');
        process.exit(2);
    }
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
