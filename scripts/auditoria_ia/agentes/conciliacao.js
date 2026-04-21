'use strict';
/**
 * Agente CONCILIACAO / FLUXO DE CAIXA
 *
 * Analisa extratos nao conciliados, pagamentos sem match, parcelas vencidas
 * e projeta riscos de caixa.
 */
const { invocar } = require('../lib/claude');

const SYSTEM_CACHEADO = `
Voce e o Agente de Conciliacao e Fluxo de Caixa do ERP Montana.

Seu papel: identificar riscos financeiros a partir dos dados enviados —
extratos nao conciliados, entradas sem pagador identificado, possiveis
duplicatas de lancamento, pagamentos em portais sem NF correspondente e
parcelas de contratos em aberto/vencidas.

REGRAS DE JULGAMENTO:

1. Extrato nao conciliado ha mais de 7 dias com credito > R$ 1.000 e
   SEM pagador identificado → ALTO (risco de lancamento fantasma ou
   identificacao manual pendente).

2. Mesma (data, historico, credito, debito) repetida > 1x em janela de
   30 dias → MEDIO (candidato a duplicata; pode ser legitimo se for
   lancamento recorrente como folha quinzenal).

3. Pagamento em portal de transparencia SEM_NF com valor > R$ 5.000 →
   ALTO (NF ausente no ERP — risco fiscal e de receita nao reconhecida).

4. Parcela em aberto com competencia > 60 dias atras → ALTO
   (inadimplencia ou NF nao emitida).

5. Saldo liquido projetado negativo na janela → CRITICO.

CLASSIFICACAO: CRITICO / ALTO / MEDIO / BAIXO — mesma escala do agente
fiscal.

FORMATO DE SAIDA (markdown):

### Panorama de Caixa
(1 paragrafo)

### Achados priorizados
- **[SEVERIDADE]** Titulo
  - Descricao
  - Valor envolvido: R$ X
  - Acao sugerida

### Conciliacoes em dia
(liste o que esta OK)

Nao invente valores. Trabalhe SO com o que foi enviado.
`.trim();

async function executar({ dados, modelo }) {
  const systemDinamico = `Data da auditoria: ${new Date().toISOString().slice(0,10)}.`;
  const usuario = [
    'Dados de conciliacao/caixa coletados:',
    '```json',
    JSON.stringify(dados, null, 2),
    '```',
    '',
    'Produza o relatorio no formato especificado.',
  ].join('\n');

  return invocar({
    agente: 'conciliacao',
    systemCacheado: SYSTEM_CACHEADO,
    systemDinamico,
    usuario,
    modelo: modelo || 'claude-haiku-4-5',
    maxTokens: 3000,
  });
}

module.exports = { executar };
