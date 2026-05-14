#!/usr/bin/env node
/**
 * Baixa em massa todos os XMLs de NFs emitidas visíveis na tabela atual do WebISS.
 * Requer Chrome aberto com --remote-debugging-port=9222 e tabela já filtrada.
 *
 * Uso:
 *   node scripts/webiss-bulk-download.js <empresa>
 *
 *   <empresa> = assessoria | seguranca | mustang | portodovau
 *
 * Salva em data/webiss-samples/<empresa>/<contrato>-<cidade>-nf<numero>-<comp>.xml
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const CDP = `http://${process.env.WEBISS_CDP_HOST || '127.0.0.1'}:${process.env.WEBISS_CDP_PORT || '9222'}`;
const TAB_SUBSTR = 'notas-fiscais';
const EMPRESA = (process.argv[2] || 'assessoria').toLowerCase();
const OUT_DIR = path.join('data', 'webiss-samples', EMPRESA);

// CNPJ → prefixo do nome do arquivo (mapping conhecido — extender quando aparecerem outros)
const CONTRATO_PREFIX = {
  '05.149.726/0001-04': 'uft',
  '01.637.536/0001-85': 'unitins',
  '38.178.825/0001-73': 'ufnt',
  '26.752.857/0001-51': 'detran',
  '25.053.117/0001-64': 'sesau',
  '25.053.083/0001-30': 'seduc',
  '25.053.133/0001-50': 'tce-to',
  '05.016.202/0001-45': 'semarh',
  '03.173.154/0001-73': 'tjto-fundo',
  '24.851.511/0001-85': 'previ-palmas',
  '05.278.848/0001-94': 'previ-palmas',  // outra inscrição da Previdência Municipal
  '19.200.109/0001-09': 'montana-seg-interno',  // NF interna p/ Montana Segurança
  '26.600.137/0001-70': 'mustang-interno',  // NF interna p/ Mustang Gestão
  // Descobertos na coleta Segurança Abr/2026:
  '24.851.511/0001-85': 'pm-palmas',       // Município de Palmas (Prefeitura)
  '01.786.078/0001-21': 'pgj-to',          // Procuradoria Geral da Justiça TO
  '07.924.551/0001-43': 'cbmto',           // Corpo de Bombeiros Militar TO
  // Descobertos na coleta Segurança Jan-Mar/2026:
  '11.794.886/0001-83': 'fcp-palmas',      // Fundação Cultural de Palmas
  '49.037.995/0001-43': 'atcp-palmas',     // Agência de Transporte Coletivo de Palmas
  '01.786.011/0001-09': 'seinf-to',        // Secretaria da Infra-estrutura TO
  '27.366.575/0001-50': 'arcon-palmas',    // Agência de Regulação, Controle e Fiscalização (ARCON)
  '21.770.076/0001-40': 'fma-palmas',      // Fundação Municipal de Meio Ambiente
};
function prefixoContrato(cnpj, item) {
  const base = CONTRATO_PREFIX[cnpj] || cnpj.replace(/\D/g, '').slice(0, 8);
  const tipo = item === '1705' ? 'motoristas' : 'limpeza';
  return `${base}-${tipo}`;
}

function slugCidade(c) {
  if (!c) return 'sem-cidade';
  return c.replace(/\/.*$/, '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function compToYYYYMM(comp) {
  // "4/2026" → "abr2026"
  const meses = ['','jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const m = (comp || '').match(/(\d+)\/(\d{4})/);
  if (!m) return 'sem-comp';
  return `${meses[parseInt(m[1])] || m[1]}${m[2]}`;
}

function httpGetJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => { try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

class CdpSession {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('WS error')), { once: true });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch(_) {} }
}

(async () => {
  const tabs = await httpGetJson(`${CDP}/json/list`);
  const tab = tabs.find(t => t.type === 'page' && (t.url || '').toLowerCase().includes(TAB_SUBSTR));
  if (!tab) { console.error(`Aba com "${TAB_SUBSTR}" não encontrada`); process.exit(1); }

  const s = new CdpSession(tab.webSocketDebuggerUrl);
  await s.open();
  await s.send('Runtime.enable');

  // 1) Lê tabela
  const { result } = await s.send('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.filter(tr => tr.querySelectorAll('td').length > 5).map(tr => {
        const c = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim().replace(/\\s+/g,' '));
        const xmlLink = tr.querySelector('a.xml-nota-fiscal');
        return {
          situacao: c[0], cnpj: c[1], num: c[4], valor: c[7],
          cidade: c[17], comp: c[15], item: c[18],
          data_id: xmlLink ? xmlLink.getAttribute('data-id') : null
        };
      }).filter(r => r.situacao === 'Normal' && r.data_id);
    })())`,
    returnByValue: true,
  });
  const lista = JSON.parse(result.value);
  console.log(`Encontrei ${lista.length} NFs emitidas na tabela atual.`);

  await fs.mkdir(OUT_DIR, { recursive: true });

  // 2) Baixa um por vez (sequencial pra não sobrecarregar)
  let baixados = 0, pulados = 0, erros = 0;
  for (const r of lista) {
    const prefix = prefixoContrato(r.cnpj, r.item);
    const cidade = slugCidade(r.cidade);
    const comp = compToYYYYMM(r.comp);
    const fname = `${prefix}-${cidade}-nf${r.num}-${comp}.xml`;
    const outPath = path.join(OUT_DIR, fname);

    try {
      const stat = await fs.stat(outPath).catch(() => null);
      if (stat && stat.size > 1000) {
        console.log(`SKIP ${fname} (já existe ${stat.size}B)`);
        pulados++;
        continue;
      }

      const url = `https://palmasto.webiss.com.br/issqn/nfse/xml/${r.data_id}`;
      const { result } = await s.send('Runtime.evaluate', {
        expression: `(async () => { const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' }); return { status: r.status, text: await r.text() }; })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      const { status, text } = result.value;
      if (status !== 200) throw new Error(`HTTP ${status}`);
      await fs.writeFile(outPath, text);
      baixados++;
      console.log(`OK   ${fname} (${text.length}B)`);
      // pequena pausa pra não floodar
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      erros++;
      console.error(`ERRO ${fname}: ${e.message}`);
    }
  }

  console.log(`\n---\nBaixados: ${baixados} | Pulados (já existiam): ${pulados} | Erros: ${erros}`);
  s.close();
})();
