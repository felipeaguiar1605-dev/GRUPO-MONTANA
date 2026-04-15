'use strict';
/**
 * Sync manual de extratos BB — Montana Segurança
 * Uso: node scripts/bb_sync_manual.js [dias] (padrão: 90)
 * Ex:  node scripts/bb_sync_manual.js 180
 */
const path  = require('path');
const https = require('https');
const fs    = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const db   = new Database(path.join(ROOT, 'data', 'seguranca', 'montana.db'));

const get = k => db.prepare('SELECT valor FROM configuracoes WHERE chave=?').get(k)?.valor || '';

const cfg = {
  client_id:     get('bb_client_id'),
  client_secret: get('bb_client_secret'),
  app_key:       get('bb_app_key'),
  agencia:       get('bb_agencia'),
  conta:         get('bb_conta'),
  cert_path:     get('bb_cert_path'),
  key_path:      get('bb_key_path'),
};

const DIAS = parseInt(process.argv[2] || '90', 10);
const hoje  = new Date();
const ini   = new Date(hoje); ini.setDate(ini.getDate() - DIAS);
const fmt   = d => d.toISOString().split('T')[0];
const dataFim    = fmt(hoje);
const dataInicio = fmt(ini);

// BB espera data sem zero à esquerda: 14042026
function toDateBB(iso) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)}${m}${y}`;
}

function httpsReq(urlStr, { method = 'GET', headers = {}, body = null, cert, key } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers };
    if (cert && key) { opts.cert = cert; opts.key = key; }
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data), text: () => data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`\n  🏦 BB Sync — Montana Segurança`);
  console.log(`  Período: ${dataInicio} → ${dataFim} (${DIAS} dias)\n`);

  // 1. OAuth
  const basic    = Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64');
  const oauthBody = 'grant_type=client_credentials&scope=extrato-info';
  const cert = fs.existsSync(cfg.cert_path) ? fs.readFileSync(cfg.cert_path) : null;
  const key  = fs.existsSync(cfg.key_path)  ? fs.readFileSync(cfg.key_path)  : null;

  console.log('  🔑 Obtendo token OAuth...');
  const authResp = await httpsReq('https://oauth.bb.com.br/oauth/token', {
    method: 'POST', cert, key,
    headers: {
      'Authorization':  `Basic ${basic}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(oauthBody),
    },
    body: oauthBody,
  });
  const auth = authResp.json();
  if (!auth.access_token) { console.error('  ❌ OAuth falhou:', auth); process.exit(1); }
  console.log('  ✅ Token OK\n');

  // 2. Dividir período em blocos de 30 dias (limite da API BB)
  const blocos = [];
  let cur = new Date(ini);
  while (cur < hoje) {
    const fim = new Date(cur); fim.setDate(fim.getDate() + 29);
    if (fim > hoje) fim.setTime(hoje.getTime());
    blocos.push({ de: fmt(cur), ate: fmt(fim) });
    cur = new Date(fim); cur.setDate(cur.getDate() + 1);
  }
  console.log(`  📦 ${blocos.length} bloco(s) de até 30 dias cada\n`);

  let totalImported = 0, totalSkipped = 0;

  const ins = db.prepare(`
    INSERT OR IGNORE INTO extratos (mes, data, data_iso, tipo, historico, debito, credito, status_conciliacao)
    VALUES (@mes, @data, @data_iso, @tipo, @historico, @debito, @credito, 'PENDENTE')
  `);

  const MESES = ['','JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
  const IGNORAR = [/^saldo/i, /^limite/i, /agendamento/i, /pix\s+rejeitado/i];

  for (const bloco of blocos) {
    let pagina = 1, hasMore = true, blocoImp = 0;
    process.stdout.write(`  📅 ${bloco.de} → ${bloco.ate}: `);

    while (hasMore) {
      const params = new URLSearchParams({
        'gw-dev-app-key':                       cfg.app_key,
        dataInicioSolicitacao:                  toDateBB(bloco.de),
        dataFimSolicitacao:                     toDateBB(bloco.ate),
        numeroPaginaSolicitacao:                String(pagina),
        quantidadeRegistroPaginaSolicitacao:    '200',
      });

      const url = `https://api-extratos.bb.com.br/extratos/v1/conta-corrente/agencia/${cfg.agencia}/conta/${cfg.conta}?${params}`;
      const resp = await httpsReq(url, {
        cert, key,
        headers: { 'Authorization': `Bearer ${auth.access_token}` },
      });

      if (resp.status < 200 || resp.status >= 300) {
        const err = resp.text();
        process.stdout.write(`❌ API erro ${resp.status}: ${err.substring(0, 200)}\n`);
        hasMore = false; break;
      }

      const data = resp.json();
      let lista = data.listaLancamento || data.lancamentos || data.data || [];
      if (!Array.isArray(lista)) lista = Object.values(lista);

      db.transaction(() => {
        for (const l of lista) {
          const desc = [l.textoDescricaoHistorico, l.textoInformacaoComplementar].filter(Boolean).join(' — ').trim() || 'LANÇAMENTO BB';
          if (IGNORAR.some(p => p.test(desc))) { totalSkipped++; continue; }

          const ds  = String(l.dataLancamento).padStart(8, '0');
          const d   = ds.substring(0, 2), m = ds.substring(2, 4), y = ds.substring(4, 8);
          const iso = `${y}-${m}-${d}`;
          if (iso > bloco.ate) { totalSkipped++; continue; }

          const sinal = (l.indicadorSinalLancamento || l.indicadorTipoLancamento || '').toUpperCase();
          const valor = Math.abs(parseFloat(l.valorLancamento) || 0);
          const r = ins.run({
            mes:       MESES[parseInt(m)] || m,
            data:      `${d}/${m}/${y}`,
            data_iso:  iso,
            tipo:      sinal || 'D',
            historico: desc,
            debito:    sinal === 'D' ? valor : 0,
            credito:   sinal === 'C' ? valor : 0,
          });
          if (r.changes > 0) { totalImported++; blocoImp++; } else totalSkipped++;
        }
      })();

      hasMore = (data.numeroPaginaProximo || 0) > 0 && lista.length > 0;
      pagina++;
      if (pagina > 10) break;
    }
    console.log(`+${blocoImp} novos`);
  }

  // 3. Registrar sync
  const agora = new Date().toISOString();
  db.prepare(`INSERT INTO configuracoes(chave, valor) VALUES('bb_ultimo_sync', ?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, updated_at=datetime('now')`).run(agora);
  try {
    db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('bb-sync', ?, ?)`)
      .run(`BB sync ${dataInicio}→${dataFim}`, totalImported);
  } catch (_) {}

  db.close();

  console.log(`\n  ✅ Sync concluído!`);
  console.log(`  📥 Importados:  ${totalImported}`);
  console.log(`  ⏭️  Ignorados:   ${totalSkipped}`);
  console.log(`  📅 Período:     ${dataInicio} → ${dataFim}\n`);
}

main().catch(e => { console.error('  ❌ Erro:', e.message); db.close(); process.exit(1); });
