// Patch script: corrige extrairDados + calcularLinha em analise_cprb_comparativo.js
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'analise_cprb_comparativo.js');
let s = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

// ── PATCH 1: substitui stmtFolha simples pelo cascade completo ──────────────
const OLD1 = `  const stmtFolha = db.prepare(\`
    SELECT COALESCE(SUM(total_bruto), 0) AS folha
    FROM rh_folha
    WHERE competencia = ?
  \`);

  const linhas = competencias.map(c => {
    const receita = stmtReceita.get(c)?.receita || 0;
    const folha   = stmtFolha.get(c)?.folha     || 0;
    return {
      competencia: c,
      receita: r2(receita),
      folha:   r2(folha),
      faltando: receita === 0 && folha === 0,
    };
  });

  db.close();
  return linhas;
}`;

const NEW1 = `  // Folha em cascata: sumário > itens individuais > manual CLI > proxy melhor mês
  const stmtFolhaSumario = db.prepare(
    'SELECT COALESCE(SUM(total_bruto),0) AS folha FROM rh_folha WHERE competencia=? AND total_bruto>0'
  );
  const stmtFolhaItens = db.prepare(
    'SELECT COALESCE(SUM(fi.total_bruto),0) AS folha FROM rh_folha_itens fi JOIN rh_folha f ON fi.folha_id=f.id WHERE f.competencia=? AND fi.total_bruto>0'
  );
  // Uso: --folha-assessoria-mensal=3650000  /  --folha-seguranca-mensal=2220000
  const folhaManualMensal = parseFloat(argMap['folha-' + empresa.key + '-mensal'] || '0') || 0;

  let folhaRefItens = 0;
  try {
    const m = db.prepare(
      'SELECT SUM(fi.total_bruto) AS t FROM rh_folha_itens fi JOIN rh_folha f ON fi.folha_id=f.id WHERE fi.total_bruto>0 GROUP BY f.competencia ORDER BY t DESC LIMIT 1'
    ).get();
    if (m && m.t > 0) folhaRefItens = m.t;
  } catch (_) {}

  const linhas = competencias.map(c => {
    const receita = stmtReceita.get(c)?.receita || 0;
    let folha = 0, folhaFonte = '';
    folha = stmtFolhaSumario.get(c)?.folha || 0;
    if (folha > 0) folhaFonte = 'rh_folha';
    if (!folha) {
      try { folha = stmtFolhaItens.get(c)?.folha || 0; } catch (_) {}
      if (folha > 0) folhaFonte = 'rh_folha_itens';
    }
    if (!folha && folhaManualMensal > 0) { folha = folhaManualMensal; folhaFonte = 'manual'; }
    if (!folha && folhaRefItens > 0)     { folha = folhaRefItens;     folhaFonte = 'proxy_itens'; }
    return {
      competencia: c,
      receita: r2(receita),
      folha:   r2(folha),
      folhaFonte,
      faltando:    receita === 0,
      folhaSemDados: folha === 0,
    };
  });

  db.close();
  return linhas;
}`;

if (s.includes(OLD1.slice(0, 50))) {
  s = s.replace(OLD1, NEW1);
  console.log('PATCH 1 aplicado (cascade folha)');
} else {
  console.log('PATCH 1: bloco não encontrado — já aplicado ou texto diferente');
}

// ── PATCH 2: console output com fonte da folha ──────────────────────────────
const OLD2 = `    const t = totalizar(linhas);
    const fr = t.folha_sobre_receita ? (t.folha_sobre_receita*100).toFixed(1) + '%' : '—';
    console.log(\`    Receita 12m: \${brl(t.receita)}\`);
    console.log(\`    Folha   12m: \${brl(t.folha)}  (\${fr} da receita)\`);
    console.log(\`    A — Folha cheia:       \${brl(t.A)}\`);
    console.log(\`    B — CPRB 2026 (60/50): \${brl(t.B)}\`);
    console.log(\`    C — CPRB cheio (ref):  \${brl(t.C)}\`);
    console.log(\`    ⇒ Caixa em jogo 2026:  \${brl(t.economia_B)}  \${t.economia_B>0 ? '(CPRB vence)' : '(folha cheia vence)'}\`);
    console.log(\`    ⇒ Caixa teórico cheio: \${brl(t.economia_C)}  \${t.economia_C>0 ? '(CPRB vence)' : '(folha cheia vence)'}\`);
    console.log('');`;

const NEW2 = `    const t = totalizar(linhas);
    const fr = t.folha_sobre_receita ? (t.folha_sobre_receita*100).toFixed(1) + '%' : '—';
    const fontes = [...new Set(linhas.map(l => l.folhaFonte).filter(Boolean))];
    const semFolha = linhas.filter(l => l.folhaSemDados).length;
    console.log(\`    Receita 12m: \${brl(t.receita)}\`);
    console.log(\`    Folha   12m: \${brl(t.folha)}  (\${fr} da receita)\` +
      (fontes.length ? \`  [fonte: \${fontes.join('+')}]\` : '') +
      (semFolha ? \`  ⚠ \${semFolha} meses sem dados\` : ''));
    if (t.folha === 0) {
      console.log(\`    ⚠  FOLHA SEM DADOS — forneça via --folha-\${emp.key}-mensal=VALOR\`);
      console.log(\`       Cenários A/B parciais. Cenário C (CPRB puro) válido.\`);
    }
    console.log(\`    A — Folha cheia:       \${brl(t.A)}\${t.folha===0?' (⚠ incompleto)':''}\`);
    console.log(\`    B — CPRB 2026 (60/50): \${brl(t.B)}\`);
    console.log(\`    C — CPRB cheio (ref):  \${brl(t.C)}\`);
    if (t.folha > 0) {
      console.log(\`    ⇒ Caixa em jogo 2026:  \${brl(t.economia_B)}  \${t.economia_B>0 ? '(CPRB vence)' : '(folha cheia vence)'}\`);
      console.log(\`    ⇒ Caixa teórico cheio: \${brl(t.economia_C)}  \${t.economia_C>0 ? '(CPRB vence)' : '(folha cheia vence)'}\`);
    }
    console.log('');`;

if (s.includes(OLD2.slice(0, 50))) {
  s = s.replace(OLD2, NEW2);
  console.log('PATCH 2 aplicado (console output)');
} else {
  console.log('PATCH 2: bloco não encontrado — possivelmente já aplicado');
}

fs.writeFileSync(target, s, 'utf8');
console.log('folhaManualMensal ocorrências:', (s.match(/folhaManualMensal/g) || []).length);
console.log('aliq_cprb ocorrências:',         (s.match(/aliq_cprb/g) || []).length);
