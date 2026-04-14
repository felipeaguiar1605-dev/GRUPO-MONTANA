/**
 * Montana Multi-Empresa — Database Factory
 * Mantém uma instância SQLite por empresa (lazy init + Map cache).
 */
const Database = require('better-sqlite3');
const path = require('path');
const COMPANIES = require('./companies');

const _instances = new Map();

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contratos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numContrato TEXT UNIQUE NOT NULL,
    contrato TEXT NOT NULL,
    orgao TEXT DEFAULT '',
    vigencia_inicio TEXT DEFAULT '',
    vigencia_fim TEXT DEFAULT '',
    valor_mensal_bruto REAL DEFAULT 0,
    valor_mensal_liquido REAL DEFAULT 0,
    total_pago REAL DEFAULT 0,
    total_aberto REAL DEFAULT 0,
    status TEXT DEFAULT '',
    obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS parcelas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contrato_num TEXT NOT NULL,
    competencia TEXT DEFAULT '',
    valor_liquido REAL DEFAULT 0,
    valor_bruto REAL DEFAULT 0,
    valor_pago REAL DEFAULT 0,
    data_pagamento TEXT DEFAULT '',
    status TEXT DEFAULT '',
    obs TEXT DEFAULT '',
    FOREIGN KEY (contrato_num) REFERENCES contratos(numContrato)
  );
  CREATE TABLE IF NOT EXISTS extratos (
    id INTEGER PRIMARY KEY,
    mes TEXT NOT NULL,
    data TEXT NOT NULL,
    data_iso TEXT DEFAULT '',
    tipo TEXT DEFAULT '',
    historico TEXT DEFAULT '',
    debito REAL,
    credito REAL,
    posto TEXT DEFAULT '',
    competencia TEXT DEFAULT '',
    valor_liquido REAL,
    valor_bruto REAL,
    retencao REAL,
    cv REAL,
    diferenca REAL,
    status TEXT DEFAULT '',
    obs TEXT DEFAULT '',
    contrato_vinculado TEXT DEFAULT '',
    status_conciliacao TEXT DEFAULT 'PENDENTE',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notas_fiscais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    competencia TEXT DEFAULT '',
    cidade TEXT DEFAULT '',
    tomador TEXT DEFAULT '',
    valor_bruto REAL DEFAULT 0,
    valor_liquido REAL DEFAULT 0,
    inss REAL DEFAULT 0,
    ir REAL DEFAULT 0,
    iss REAL DEFAULT 0,
    csll REAL DEFAULT 0,
    pis REAL DEFAULT 0,
    cofins REAL DEFAULT 0,
    retencao REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS liquidacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empenho TEXT DEFAULT '',
    gestao TEXT DEFAULT '',
    favorecido TEXT DEFAULT '',
    processo TEXT DEFAULT '',
    data_liquidacao TEXT DEFAULT '',
    data_liquidacao_iso TEXT DEFAULT '',
    valor REAL DEFAULT 0,
    status TEXT DEFAULT '',
    obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ob TEXT DEFAULT '',
    gestao TEXT DEFAULT '',
    fonte TEXT DEFAULT '',
    empenho TEXT DEFAULT '',
    processo TEXT DEFAULT '',
    favorecido TEXT DEFAULT '',
    data_pagamento TEXT DEFAULT '',
    data_pagamento_iso TEXT DEFAULT '',
    valor_pago REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vinculacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extrato_id INTEGER NOT NULL,
    contrato_num TEXT NOT NULL,
    tipo TEXT DEFAULT '',
    valor REAL DEFAULT 0,
    data_vinculacao TEXT DEFAULT (datetime('now')),
    usuario TEXT DEFAULT 'admin',
    FOREIGN KEY (extrato_id) REFERENCES extratos(id),
    UNIQUE(extrato_id)
  );
  CREATE TABLE IF NOT EXISTS importacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    arquivo TEXT NOT NULL,
    registros INTEGER DEFAULT 0,
    data_importacao TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'OK'
  );
  CREATE TABLE IF NOT EXISTS despesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria TEXT NOT NULL DEFAULT 'FORNECEDOR',
    descricao TEXT DEFAULT '',
    fornecedor TEXT DEFAULT '',
    cnpj_fornecedor TEXT DEFAULT '',
    nf_numero TEXT DEFAULT '',
    data_despesa TEXT DEFAULT '',
    data_iso TEXT DEFAULT '',
    competencia TEXT DEFAULT '',
    valor_bruto REAL DEFAULT 0,
    irrf REAL DEFAULT 0,
    csll REAL DEFAULT 0,
    pis_retido REAL DEFAULT 0,
    cofins_retido REAL DEFAULT 0,
    inss_retido REAL DEFAULT 0,
    iss_retido REAL DEFAULT 0,
    total_retencao REAL DEFAULT 0,
    valor_liquido REAL DEFAULT 0,
    extrato_id INTEGER DEFAULT NULL,
    status TEXT DEFAULT 'PENDENTE',
    obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pref_contratos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gestao TEXT DEFAULT '', gestao_codigo TEXT DEFAULT '',
    objeto TEXT DEFAULT '', valor_mensal_bruto REAL DEFAULT 0,
    total_pago REAL DEFAULT 0, total_liquidado REAL DEFAULT 0,
    qtd_pagamentos INTEGER DEFAULT 0, primeiro_pg TEXT DEFAULT '',
    ultimo_pg TEXT DEFAULT '', status TEXT DEFAULT '',
    obs TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pref_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gestao TEXT DEFAULT '', gestao_codigo TEXT DEFAULT '',
    fonte TEXT DEFAULT '', fonte_det TEXT DEFAULT '',
    elemento_desp TEXT DEFAULT '', subnatureza TEXT DEFAULT '',
    fornecedor TEXT DEFAULT '', data_empenho TEXT DEFAULT '',
    data_empenho_iso TEXT DEFAULT '', data_liquidacao TEXT DEFAULT '',
    data_liquidacao_iso TEXT DEFAULT '', data_pagamento TEXT DEFAULT '',
    data_pagamento_iso TEXT DEFAULT '', valor_pago REAL DEFAULT 0,
    pronto_pgto TEXT DEFAULT '', ano_empenho INTEGER DEFAULT 0,
    nf_vinculada TEXT DEFAULT '', valor_liquido_ob REAL DEFAULT 0,
    retencao REAL DEFAULT 0, pct_retencao REAL DEFAULT 0,
    data_ob TEXT DEFAULT '', status_conciliacao TEXT DEFAULT 'PENDENTE',
    obs TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pref_nfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT DEFAULT '', cidade TEXT DEFAULT '',
    gestao TEXT DEFAULT '', gestao_codigo TEXT DEFAULT '',
    competencia TEXT DEFAULT '', valor_bruto REAL DEFAULT 0,
    valor_liquido REAL DEFAULT 0, retencao REAL DEFAULT 0,
    pagamento_id INTEGER DEFAULT NULL, status TEXT DEFAULT 'EMITIDA',
    arquivo TEXT DEFAULT '', obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_desp_data ON despesas(data_iso);
  CREATE INDEX IF NOT EXISTS idx_desp_cat ON despesas(categoria);
  CREATE INDEX IF NOT EXISTS idx_ext_data ON extratos(data_iso);
  CREATE INDEX IF NOT EXISTS idx_ext_status ON extratos(status_conciliacao);
  CREATE INDEX IF NOT EXISTS idx_pg_data ON pagamentos(data_pagamento_iso);
  CREATE INDEX IF NOT EXISTS idx_vinc_contrato ON vinculacoes(contrato_num);

  CREATE TABLE IF NOT EXISTS certidoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    numero TEXT DEFAULT '',
    data_emissao TEXT DEFAULT '',
    data_validade TEXT DEFAULT '',
    arquivo_pdf TEXT DEFAULT '',
    status TEXT DEFAULT 'válida',
    observacoes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS licitacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orgao TEXT DEFAULT '',
    numero_edital TEXT DEFAULT '',
    modalidade TEXT DEFAULT 'pregão',
    objeto TEXT DEFAULT '',
    data_abertura TEXT DEFAULT '',
    data_encerramento TEXT DEFAULT '',
    valor_estimado REAL DEFAULT 0,
    valor_proposta REAL DEFAULT 0,
    status TEXT DEFAULT 'em análise',
    resultado TEXT DEFAULT '',
    observacoes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS orcamentos_posto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    tipo_posto TEXT DEFAULT '',
    salario_base REAL DEFAULT 0,
    dados_json TEXT DEFAULT '{}',
    preco_mensal REAL DEFAULT 0,
    preco_anual REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notificacoes_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT DEFAULT 'email',
    destinatario TEXT DEFAULT '',
    assunto TEXT DEFAULT '',
    corpo TEXT DEFAULT '',
    status TEXT DEFAULT 'enviado',
    erro TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════════════════════════════
  -- MÓDULO BOLETINS DE MEDIÇÃO
  -- ═══════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS bol_contratos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    contratante TEXT NOT NULL,
    numero_contrato TEXT NOT NULL,
    processo TEXT DEFAULT '',
    pregao TEXT DEFAULT '',
    descricao_servico TEXT DEFAULT '',
    escala TEXT DEFAULT '12x36',
    empresa_razao TEXT DEFAULT '',
    empresa_cnpj TEXT DEFAULT '',
    empresa_endereco TEXT DEFAULT '',
    empresa_email TEXT DEFAULT '',
    empresa_telefone TEXT DEFAULT '',
    ativo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bol_postos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contrato_id INTEGER NOT NULL,
    campus_key TEXT NOT NULL,
    campus_nome TEXT NOT NULL,
    municipio TEXT DEFAULT '',
    descricao_posto TEXT DEFAULT '',
    ordem INTEGER DEFAULT 0,
    label_resumo TEXT DEFAULT '',
    FOREIGN KEY (contrato_id) REFERENCES bol_contratos(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS bol_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    posto_id INTEGER NOT NULL,
    descricao TEXT NOT NULL,
    quantidade INTEGER DEFAULT 1,
    valor_unitario REAL DEFAULT 0,
    ordem INTEGER DEFAULT 0,
    FOREIGN KEY (posto_id) REFERENCES bol_postos(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS bol_boletins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contrato_id INTEGER NOT NULL,
    competencia TEXT NOT NULL,
    data_emissao TEXT NOT NULL,
    periodo_inicio TEXT DEFAULT '',
    periodo_fim TEXT DEFAULT '',
    status TEXT DEFAULT 'gerado',
    total_geral REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contrato_id) REFERENCES bol_contratos(id)
  );
  CREATE TABLE IF NOT EXISTS bol_boletins_nfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    boletim_id INTEGER NOT NULL,
    posto_id INTEGER NOT NULL,
    nf_numero TEXT NOT NULL,
    valor_total REAL DEFAULT 0,
    arquivo_pdf TEXT DEFAULT '',
    FOREIGN KEY (boletim_id) REFERENCES bol_boletins(id) ON DELETE CASCADE,
    FOREIGN KEY (posto_id) REFERENCES bol_postos(id)
  );
  CREATE INDEX IF NOT EXISTS idx_bol_postos_contrato ON bol_postos(contrato_id);
  CREATE INDEX IF NOT EXISTS idx_bol_itens_posto ON bol_itens(posto_id);
  CREATE INDEX IF NOT EXISTS idx_bol_boletins_contrato ON bol_boletins(contrato_id);

  -- ═══════════════════════════════════════════════════════
  --  MÓDULO RH / DEPARTAMENTO PESSOAL
  -- ═══════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS rh_cargos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cbo TEXT DEFAULT '',
    salario_base REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rh_funcionarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT DEFAULT '',
    rg TEXT DEFAULT '',
    data_nascimento TEXT DEFAULT '',
    data_admissao TEXT NOT NULL,
    data_demissao TEXT DEFAULT '',
    cargo_id INTEGER REFERENCES rh_cargos(id),
    contrato_ref TEXT DEFAULT '',
    lotacao TEXT DEFAULT '',
    salario_base REAL NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'ATIVO',
    pis TEXT DEFAULT '',
    ctps_numero TEXT DEFAULT '',
    ctps_serie TEXT DEFAULT '',
    banco TEXT DEFAULT '',
    agencia TEXT DEFAULT '',
    conta_banco TEXT DEFAULT '',
    tipo_conta TEXT DEFAULT '',
    email TEXT DEFAULT '',
    telefone TEXT DEFAULT '',
    obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rh_folha (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competencia TEXT NOT NULL,
    data_pagamento TEXT DEFAULT '',
    status TEXT DEFAULT 'RASCUNHO',
    total_bruto REAL DEFAULT 0,
    total_descontos REAL DEFAULT 0,
    total_liquido REAL DEFAULT 0,
    obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rh_folha_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folha_id INTEGER REFERENCES rh_folha(id) ON DELETE CASCADE,
    funcionario_id INTEGER REFERENCES rh_funcionarios(id),
    salario_base REAL DEFAULT 0,
    dias_trabalhados INTEGER DEFAULT 30,
    horas_extras REAL DEFAULT 0,
    valor_he REAL DEFAULT 0,
    adicional_noturno REAL DEFAULT 0,
    vale_transporte REAL DEFAULT 0,
    vale_alimentacao REAL DEFAULT 0,
    outros_proventos REAL DEFAULT 0,
    inss REAL DEFAULT 0,
    irrf REAL DEFAULT 0,
    faltas REAL DEFAULT 0,
    outros_descontos REAL DEFAULT 0,
    total_bruto REAL DEFAULT 0,
    total_descontos REAL DEFAULT 0,
    total_liquido REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rh_ferias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    funcionario_id INTEGER REFERENCES rh_funcionarios(id),
    periodo_aquisitivo_inicio TEXT DEFAULT '',
    periodo_aquisitivo_fim TEXT DEFAULT '',
    data_inicio TEXT DEFAULT '',
    data_fim TEXT DEFAULT '',
    dias INTEGER DEFAULT 30,
    valor REAL DEFAULT 0,
    status TEXT DEFAULT 'AGENDADA',
    obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rh_afastamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    funcionario_id INTEGER REFERENCES rh_funcionarios(id),
    tipo TEXT DEFAULT '',
    data_inicio TEXT NOT NULL,
    data_fim TEXT DEFAULT '',
    dias INTEGER DEFAULT 0,
    motivo TEXT DEFAULT '',
    obs TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rh_func_status ON rh_funcionarios(status);
  CREATE INDEX IF NOT EXISTS idx_rh_folha_comp ON rh_folha(competencia);
  CREATE INDEX IF NOT EXISTS idx_rh_itens_folha ON rh_folha_itens(folha_id);

  -- ═══════════════════════════════════════════════════════════════
  -- LOG DE AUDITORIA
  -- ═══════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL,
    acao TEXT NOT NULL,
    tabela TEXT NOT NULL,
    registro_id TEXT DEFAULT '',
    detalhe TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_usuario ON audit_log(usuario);
  CREATE INDEX IF NOT EXISTS idx_audit_tabela ON audit_log(tabela);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

  -- ═══════════════════════════════════════════════════════════════
  -- MÓDULO CONTROLE DE PONTO E FREQUÊNCIA
  -- ═══════════════════════════════════════════════════════════════

  -- Registros de batida de ponto (entrada, saída, intervalo)
  CREATE TABLE IF NOT EXISTS ponto_registros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    funcionario_id INTEGER NOT NULL REFERENCES rh_funcionarios(id),
    tipo TEXT NOT NULL CHECK(tipo IN ('entrada','saida','intervalo_inicio','intervalo_fim')),
    data_hora TEXT NOT NULL,
    observacao TEXT DEFAULT '',
    criado_em TEXT DEFAULT (datetime('now'))
  );

  -- Ocorrências: falta justificada, licença, férias, afastamento, etc.
  CREATE TABLE IF NOT EXISTS ponto_ocorrencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    funcionario_id INTEGER NOT NULL REFERENCES rh_funcionarios(id),
    tipo TEXT NOT NULL,
    date_inicio TEXT NOT NULL,
    date_fim TEXT DEFAULT '',
    observacao TEXT DEFAULT '',
    aprovado INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  -- Jornadas configuráveis por funcionário ou cargo
  CREATE TABLE IF NOT EXISTS ponto_jornadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    funcionario_id INTEGER DEFAULT NULL REFERENCES rh_funcionarios(id),
    cargo_id INTEGER DEFAULT NULL REFERENCES rh_cargos(id),
    entrada TEXT DEFAULT '08:00',
    saida TEXT DEFAULT '17:00',
    intervalo_minutos INTEGER DEFAULT 60,
    dias_semana TEXT DEFAULT 'seg,ter,qua,qui,sex',
    horas_dia REAL DEFAULT 8,
    horas_semana REAL DEFAULT 44,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ponto_reg_func ON ponto_registros(funcionario_id);
  CREATE INDEX IF NOT EXISTS idx_ponto_reg_data ON ponto_registros(data_hora);
  CREATE INDEX IF NOT EXISTS idx_ponto_oc_func ON ponto_ocorrencias(funcionario_id);
  CREATE INDEX IF NOT EXISTS idx_ponto_jorn_func ON ponto_jornadas(funcionario_id);

  CREATE TABLE IF NOT EXISTS conta_vinculada (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta TEXT NOT NULL,
    orgao TEXT DEFAULT '',
    cnpj_orgao TEXT DEFAULT '',
    data TEXT NOT NULL,
    data_iso TEXT NOT NULL,
    historico TEXT DEFAULT '',
    debito REAL DEFAULT 0,
    credito REAL DEFAULT 0,
    saldo REAL DEFAULT 0,
    contrato_ref TEXT DEFAULT '',
    competencia TEXT DEFAULT '',
    origem TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cv_data ON conta_vinculada(data_iso);
  CREATE INDEX IF NOT EXISTS idx_cv_conta ON conta_vinculada(conta);
  CREATE INDEX IF NOT EXISTS idx_cv_contrato ON conta_vinculada(contrato_ref);
`;

const MIGRATIONS = [
  "ALTER TABLE despesas ADD COLUMN contrato_ref TEXT DEFAULT ''",
  "ALTER TABLE notas_fiscais ADD COLUMN contrato_ref TEXT DEFAULT ''",
  "ALTER TABLE notas_fiscais ADD COLUMN data_emissao TEXT DEFAULT ''",
  "ALTER TABLE notas_fiscais ADD COLUMN cnpj_tomador TEXT DEFAULT ''",
  "ALTER TABLE notas_fiscais ADD COLUMN status_conciliacao TEXT DEFAULT 'PENDENTE'",
  "ALTER TABLE extratos ADD COLUMN banco TEXT DEFAULT ''",
  "ALTER TABLE extratos ADD COLUMN conta TEXT DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_desp_contrato ON despesas(contrato_ref)",
  // Índices adicionais para consultas frequentes (P-3)
  "CREATE INDEX IF NOT EXISTS idx_nfs_data_emissao ON notas_fiscais(data_emissao)",
  "CREATE INDEX IF NOT EXISTS idx_nfs_contrato ON notas_fiscais(contrato_ref)",
  "CREATE INDEX IF NOT EXISTS idx_cont_status ON contratos(status)",
  // Módulo 3: Reajuste contratual
  "ALTER TABLE contratos ADD COLUMN data_ultimo_reajuste TEXT DEFAULT ''",
  "ALTER TABLE contratos ADD COLUMN indice_reajuste TEXT DEFAULT 'INPC'",
  "ALTER TABLE contratos ADD COLUMN pct_reajuste_ultimo REAL DEFAULT 0",
  "ALTER TABLE contratos ADD COLUMN data_proximo_reajuste TEXT DEFAULT ''",
  "ALTER TABLE contratos ADD COLUMN obs_reajuste TEXT DEFAULT ''",
  // Integração Ponto → Folha: matrícula para exportação Alterdata/Domínio
  "ALTER TABLE rh_funcionarios ADD COLUMN matricula TEXT DEFAULT ''",
];

function getDb(companyKey) {
  if (!COMPANIES[companyKey]) throw new Error('Empresa desconhecida: ' + companyKey);
  if (_instances.has(companyKey)) return _instances.get(companyKey);

  const dbPath = path.join(__dirname, '..', COMPANIES[companyKey].dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');       // escrita simultânea sem lock
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');     // mais rápido, seguro com WAL
  db.pragma('cache_size = -64000');      // 64 MB de cache em memória
  db.pragma('temp_store = MEMORY');      // tabelas temporárias em RAM
  db.pragma('mmap_size = 268435456');    // 256 MB memory-mapped I/O
  db.pragma('busy_timeout = 5000');      // aguarda 5s antes de retornar "locked"
  db.exec(SCHEMA_SQL);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { /* coluna já existe */ }
  }
  _instances.set(companyKey, db);
  console.log(`  ✅ DB [${companyKey}] conectado: ${dbPath}`);
  return db;
}

module.exports = { getDb, COMPANIES };
