/**
 * Montana — Módulo Roadmap de Substituição do Omie
 *
 * Rota GLOBAL (não usa companyMiddleware). Persiste em SQLite dedicado
 * em data/_global/roadmap.db. Fonte inicial: ROADMAP_SUBSTITUICAO_OMIE.md
 *
 * Endpoints:
 *   GET    /api/roadmap          — lista agrupada por seção + stats
 *   POST   /api/roadmap          — cria item (secao, codigo, titulo, descricao)
 *   PATCH  /api/roadmap/:id      — atualiza prioridade / ordem / status / responsavel / observacoes
 *   DELETE /api/roadmap/:id      — remove item
 *   POST   /api/roadmap/reseed   — re-executa seed (idempotente — só insere o que falta)
 */
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', '_global');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'roadmap.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS roadmap_itens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    secao       TEXT NOT NULL,
    codigo      TEXT UNIQUE NOT NULL,
    titulo      TEXT NOT NULL,
    descricao   TEXT DEFAULT '',
    prioridade  TEXT DEFAULT '',
    ordem       INTEGER DEFAULT NULL,
    status      TEXT DEFAULT 'pendente',
    responsavel TEXT DEFAULT '',
    observacoes TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_rm_secao  ON roadmap_itens(secao);
  CREATE INDEX IF NOT EXISTS idx_rm_status ON roadmap_itens(status);
`);

// ── Seed inicial: 47 itens de ROADMAP_SUBSTITUICAO_OMIE.md ───────
const SEED = [
  // ── Seção A — Onda 1: Financeiro Operacional ──
  { s:'A', c:'A1', t:'Cadastro unificado de entidades',
    d:'Tabela entidades (CNPJ/CPF, tipo cliente/fornecedor/ambos, contatos, endereço, histórico). Migra dados espalhados hoje em contratos, despesas, rh_*.' },
  { s:'A', c:'A2', t:'Contas a Pagar (CP)',
    d:'Módulo com agendamento, aprovação, geração de lote PIX/boleto, baixa automática via conciliação contra extrato BB.' },
  { s:'A', c:'A3', t:'Contas a Receber (CR)',
    d:'Ligação contrato → NFS-e → pagamento (Transparência Palmas ou extrato). Régua de cobrança.' },
  { s:'A', c:'A4', t:'Geração de boletos/PIX out',
    d:'Integração com API do banco (BB já tem OAuth mTLS) para emissão de cobrança e ordens de pagamento.' },
  { s:'A', c:'A5', t:'Régua de cobrança',
    d:'Alertas escalonados (D-3, D+1, D+7, D+15) — reaproveitar alertas-operacionais.js.' },
  { s:'A', c:'A6', t:'UI unificada de Financeiro',
    d:'Tela única com CP + CR + fluxo de caixa + conciliação (hoje espalhado em rotas diferentes).' },

  // ── Seção B — Onda 2: Gestão e Análise ──
  { s:'B', c:'B1', t:'Dashboard executivo consolidado',
    d:'KPIs das 4 empresas em 1 tela (faturamento, margem, caixa, alertas críticos). Expandir /consolidado existente.' },
  { s:'B', c:'B2', t:'Export contábil',
    d:'Gerar SPED Contribuições, balancete, razão no formato que o contador aceita (hoje sai do Omie).' },
  { s:'B', c:'B3', t:'RBAC (perfis e permissões)',
    d:'Perfis: Admin, Financeiro, Operacional, Consulta. Restringir rotas por perfil. JWT já existe; faltam claims de role.' },
  { s:'B', c:'B4', t:'Auditoria global',
    d:'Tabela audit_log (quem/quando/o-quê). Parcialmente iniciada no commit 2c8721f — consolidar e cobrir 100% das rotas de escrita.' },
  { s:'B', c:'B5', t:'Workflow de aprovações',
    d:'Despesas acima de limite (ex: R$10k) requerem aprovação do diretor antes de agendar pagamento.' },
  { s:'B', c:'B6', t:'Montana Intelligence — expansão',
    d:'MCP + Claude respondendo perguntas em linguagem natural (ver ARQUITETURA_MONTANA_INTELLIGENCE.md fases 2–4).' },
  { s:'B', c:'B7', t:'Relatórios gerenciais',
    d:'DRE comparativo (MoM, YoY), análise de contratos (rentabilidade, glosas), projeção anual.' },

  // ── Seção C — Onda 3: Corte do Omie ──
  { s:'C', c:'C1', t:'Export completo do Omie',
    d:'Baixar histórico integral (cadastros, lançamentos, anexos) em formato estruturado.' },
  { s:'C', c:'C2', t:'Importador Omie → Montana',
    d:'Script único que mapeia entidades, CP, CR, histórico financeiro para as tabelas locais.' },
  { s:'C', c:'C3', t:'Reconciliação paralela',
    d:'Rodar 1 mês fiscal completo com Omie + Montana, comparar fechamento, zerar divergências.' },
  { s:'C', c:'C4', t:'Congelamento do Omie',
    d:'Omie em read-only; toda entrada nova só no Montana.' },
  { s:'C', c:'C5', t:'Desligamento',
    d:'Cancelar assinatura Omie, arquivar exports em cold storage (GCS).' },

  // ── Seção D — Pré-requisitos e Dívida Técnica ──
  { s:'D', c:'D1', t:'Testes automatizados',
    d:'Cobertura dos endpoints críticos: conciliação-robusta, fluxo-caixa-projetado, webiss, bb-sync. Rede mínima antes de mexer em financeiro.' },
  { s:'D', c:'D2', t:'Migração SQLite → PostgreSQL',
    d:'Antes de Onda 1, porque CP/CR cross-company em 4 bancos SQLite separados é caro. Fase 4 do PLANO_MIGRACAO_CLOUD.md.' },
  { s:'D', c:'D3', t:'Limpeza de dados contaminados',
    d:'570 NFs Segurança codificadas como Assessoria (CONSULTORIA_2026-04-17). Não migrar lixo p/ sistema novo.' },
  { s:'D', c:'D4', t:'Investigar SEMUS 192/2025',
    d:'R$672k/mês com total_pago = 0 — resolver antes que vire inconsistência sistêmica.' },
  { s:'D', c:'D5', t:'Renovação de certificados A1',
    d:'5 certificados vencendo (CONSULTORIA_2026-04-17). Sem isso, WebISS/BB param.' },
  { s:'D', c:'D6', t:'Backup automatizado',
    d:'Fase 3 do plano de migração cloud — backup diário dos 4 SQLites (ou Postgres após D2) p/ GCS.' },
  { s:'D', c:'D7', t:'CI/CD mínimo',
    d:'GitHub Actions rodando testes em PR + deploy automático p/ GCP quando merge em main.' },

  // ── Seção E — Melhorias em Módulos Existentes ──
  { s:'E', c:'E1', t:'Conciliação: auto-categorização',
    d:'Auto-categorização de despesas por padrão de histórico (ML simples ou regras).' },
  { s:'E', c:'E2', t:'Conciliação: matching em cadeia',
    d:'Matching de NFS-e ↔ extrato ↔ contrato em cadeia única (hoje parcial).' },
  { s:'E', c:'E3', t:'Fluxo de caixa: cenários',
    d:'Cenários (otimista/realista/pessimista) com premissas editáveis.' },
  { s:'E', c:'E4', t:'Contratos: alerta CCT',
    d:'Alerta automático de repactuação CCT (já fez TJ 440/2024 e 73/2020 manualmente).' },
  { s:'E', c:'E5', t:'NFS-e: cache local',
    d:'Cache local de NFs emitidas (hoje WebISS é query-on-demand).' },
  { s:'E', c:'E6', t:'Folha: importador robusto',
    d:'Reduzir dependência de Excel — importador robusto + validações.' },
  { s:'E', c:'E7', t:'Ponto: integração com folha',
    d:'Horas extras alimentam folha automaticamente.' },
  { s:'E', c:'E8', t:'Estoque: revisar',
    d:'Status "parcial" no mapeamento — revisar o que falta.' },
  { s:'E', c:'E9', t:'Licitações: revisar',
    d:'Status "parcial" no mapeamento — revisar o que falta.' },
  { s:'E', c:'E10', t:'Volus: revisar',
    d:'Status "parcial" no mapeamento — revisar o que falta.' },

  // ── Seção F — Gaps de Funcionalidade (vs Omie) ──
  { s:'F', c:'F1',  t:'NFe de produto',           d:'Se Porto/Mustang/Nevada precisarem. Hoje só NFS-e.' },
  { s:'F', c:'F2',  t:'NFC-e (varejo)',           d:'Não existe.' },
  { s:'F', c:'F3',  t:'Gestão de vendas / pedidos de venda', d:'Não existe.' },
  { s:'F', c:'F4',  t:'Gestão de compras / pedidos de compra', d:'Não existe.' },
  { s:'F', c:'F5',  t:'Ordens de serviço',        d:'Não existe.' },
  { s:'F', c:'F6',  t:'CRM leve',                 d:'Pipeline, oportunidades. Não existe.' },
  { s:'F', c:'F7',  t:'Portal do cliente',        d:'Não existe.' },
  { s:'F', c:'F8',  t:'App mobile / PWA',         d:'Hoje web only. Avaliar PWA sobre o app atual.' },
  { s:'F', c:'F9',  t:'Integração com marketplace', d:'Não existe. Avaliar se faz sentido.' },
  { s:'F', c:'F10', t:'Conciliação cartão de crédito (adquirente)', d:'Não existe.' },
  { s:'F', c:'F11', t:'Gestão de projetos (horas, apontamentos)',
    d:'Parcial — ponto eletrônico existe, falta vincular a projetos/centros de custo.' },
  { s:'F', c:'F12', t:'Comissões de vendedores',  d:'Não existe.' },
];

const insertSeed = db.prepare(`
  INSERT OR IGNORE INTO roadmap_itens (secao, codigo, titulo, descricao)
  VALUES (@s, @c, @t, @d)
`);
const runSeed = db.transaction(() => {
  for (const item of SEED) insertSeed.run(item);
});
runSeed();
const seedCount = db.prepare('SELECT COUNT(*) AS n FROM roadmap_itens').get().n;
console.log(`  ✅ Roadmap: ${seedCount} itens no banco (seed: ${SEED.length})`);

// ═══════════════════════════════════════════════════════════════════
const router = express.Router();

const STATUS_VALIDOS = ['pendente', 'em-andamento', 'em-review', 'concluido', 'cancelado'];
const PRIORIDADES_VALIDAS = ['A', 'B', 'C', ''];

// GET /api/roadmap — lista agrupada por seção + estatísticas
router.get('/', (_req, res) => {
  const itens = db.prepare(`
    SELECT * FROM roadmap_itens
    ORDER BY secao,
             CASE WHEN ordem IS NULL THEN 1 ELSE 0 END,
             ordem,
             codigo
  `).all();

  const secoes = {};
  for (const it of itens) {
    if (!secoes[it.secao]) secoes[it.secao] = [];
    secoes[it.secao].push(it);
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='pendente'      THEN 1 ELSE 0 END) AS pendentes,
      SUM(CASE WHEN status='em-andamento'  THEN 1 ELSE 0 END) AS andamento,
      SUM(CASE WHEN status='em-review'     THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN status='concluido'     THEN 1 ELSE 0 END) AS concluidos,
      SUM(CASE WHEN status='cancelado'     THEN 1 ELSE 0 END) AS cancelados,
      SUM(CASE WHEN prioridade='A'         THEN 1 ELSE 0 END) AS prio_a,
      SUM(CASE WHEN prioridade='B'         THEN 1 ELSE 0 END) AS prio_b,
      SUM(CASE WHEN prioridade='C'         THEN 1 ELSE 0 END) AS prio_c
    FROM roadmap_itens
  `).get();

  res.json({ secoes, stats, total: itens.length });
});

// PATCH /api/roadmap/:id — atualiza campos editáveis
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const existe = db.prepare('SELECT id FROM roadmap_itens WHERE id=?').get(id);
  if (!existe) return res.status(404).json({ error: 'Item não encontrado' });

  const { prioridade, ordem, status, responsavel, observacoes, titulo, descricao } = req.body;
  const updates = [];
  const params = { id };

  if (prioridade !== undefined) {
    if (!PRIORIDADES_VALIDAS.includes(prioridade)) {
      return res.status(400).json({ error: 'Prioridade inválida (use A, B, C ou vazio)' });
    }
    updates.push('prioridade=@prioridade'); params.prioridade = prioridade;
  }
  if (ordem !== undefined) {
    updates.push('ordem=@ordem');
    params.ordem = (ordem === null || ordem === '') ? null : parseInt(ordem);
  }
  if (status !== undefined) {
    if (!STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }
    updates.push('status=@status'); params.status = status;
  }
  if (responsavel !== undefined) { updates.push('responsavel=@responsavel'); params.responsavel = String(responsavel); }
  if (observacoes !== undefined) { updates.push('observacoes=@observacoes'); params.observacoes = String(observacoes); }
  if (titulo      !== undefined) { updates.push('titulo=@titulo');            params.titulo      = String(titulo); }
  if (descricao   !== undefined) { updates.push('descricao=@descricao');      params.descricao   = String(descricao); }

  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push(`updated_at=datetime('now','localtime')`);

  db.prepare(`UPDATE roadmap_itens SET ${updates.join(', ')} WHERE id=@id`).run(params);
  const item = db.prepare('SELECT * FROM roadmap_itens WHERE id=?').get(id);
  res.json({ ok: true, item });
});

// POST /api/roadmap — cria item novo
router.post('/', (req, res) => {
  const { secao, codigo, titulo, descricao } = req.body;
  if (!secao || !codigo || !titulo) {
    return res.status(400).json({ error: 'Campos obrigatórios: secao, codigo, titulo' });
  }
  try {
    const r = db.prepare(`
      INSERT INTO roadmap_itens (secao, codigo, titulo, descricao)
      VALUES (?, ?, ?, ?)
    `).run(String(secao).toUpperCase(), String(codigo), String(titulo), String(descricao || ''));
    const item = db.prepare('SELECT * FROM roadmap_itens WHERE id=?').get(r.lastInsertRowid);
    res.json({ ok: true, item });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Código já existe' });
    }
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/roadmap/:id — remove item
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const r = db.prepare('DELETE FROM roadmap_itens WHERE id=?').run(id);
  res.json({ ok: true, removidos: r.changes });
});

// POST /api/roadmap/reseed — reexecuta seed (idempotente via INSERT OR IGNORE)
router.post('/reseed', (_req, res) => {
  runSeed();
  const total = db.prepare('SELECT COUNT(*) AS n FROM roadmap_itens').get().n;
  res.json({ ok: true, total, seed_size: SEED.length });
});

module.exports = router;
