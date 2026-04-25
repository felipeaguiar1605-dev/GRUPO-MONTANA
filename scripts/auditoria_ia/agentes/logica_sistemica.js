'use strict';
/**
 * Agente LOGICA SISTEMICA
 *
 * Varre src/routes/ e aponta inconsistencias de arquitetura multi-empresa:
 * rotas sem companyMiddleware, writes sem auditLog, getDb sem empresa.
 *
 * O grosso do trabalho ja foi feito na coleta (grep no fonte). A IA apenas
 * prioriza, contextualiza e sugere correcao.
 */
const { invocar } = require('../lib/claude');

const SYSTEM_CACHEADO = `
Voce e o Agente de Logica Sistemica do ERP Montana.

Contexto do ERP:
- Arquitetura multi-empresa: cada empresa (assessoria, seguranca,
  portodovau, etc.) tem sua propria base SQLite.
- src/companyMiddleware.js injeta req.company em todas as rotas
  autorizadas.
- src/db.js expoe getDb(companyKey) — chamar SEM key e um bug grave
  (vazamento entre empresas).
- src/middleware/auditLog.js registra writes sensiveis para rastreio.

Voce recebe a lista de rotas com heuristicas pre-computadas:
- rotas_sem_company_middleware: rotas que NAO importam companyMiddleware
  → risco potencial de vazar dado entre empresas.
- rotas_write_sem_audit_log: rotas que fazem INSERT/UPDATE/DELETE sem
  referencia a auditLog → rastreabilidade comprometida.
- getdb_sem_empresa: chamadas getDb() sem argumento → bug de isolamento.

Sua tarefa:
1. Classifique cada achado por severidade (CRITICO / ALTO / MEDIO / BAIXO).
2. Para rotas publicas/sem autenticacao (ex: health-check), middleware
   pode ser desnecessario — explique antes de escalar.
3. Sugira a correcao de uma linha (ex: "adicionar router.use(companyMw)").

FORMATO DE SAIDA (markdown):

### Panorama Arquitetural
(1 paragrafo)

### Achados priorizados
- **[SEVERIDADE]** arquivo.js — resumo
  - Detalhe: ...
  - Correcao sugerida: \`router.use(companyMw);\`

### Rotas saudaveis
(resumo quantitativo)

Seja objetivo. Nao invente rotas que nao foram listadas.
`.trim();

async function executar({ dados, modelo }) {
  const systemDinamico = `Data da auditoria: ${new Date().toISOString().slice(0,10)}.`;
  const usuario = [
    'Resultado da varredura estatica em src/routes/:',
    '```json',
    JSON.stringify(dados, null, 2),
    '```',
    '',
    'Produza o relatorio no formato especificado.',
  ].join('\n');

  return invocar({
    agente: 'logica_sistemica',
    systemCacheado: SYSTEM_CACHEADO,
    systemDinamico,
    usuario,
    modelo: modelo || 'claude-haiku-4-5',
    maxTokens: 2500,
  });
}

module.exports = { executar };
