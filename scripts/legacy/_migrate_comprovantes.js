/**
 * Cria tabelas comprovantes_pagamento + comprovante_vinculos em todos os 4 DBs.
 * Idempotente — pode ser executado várias vezes.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbs = [
  'data/assessoria/montana.db',
  'data/seguranca/montana.db',
  'data/portodovau/montana.db',
  'data/mustang/montana.db',
];

const SCHEMA_COMPROVANTES = `
  CREATE TABLE IF NOT EXISTS comprovantes_pagamento (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,                  -- 'OB','TED','DOC','PIX','BOLETO','DEBITO','CHEQUE','OUTRO'
    direcao TEXT NOT NULL DEFAULT 'SAIDA', -- 'ENTRADA' (recebimento de tomador) | 'SAIDA' (pagamento a fornecedor)
    data_pagamento TEXT NOT NULL,        -- ISO date 'YYYY-MM-DD'
    valor REAL NOT NULL,                 -- valor total do comprovante
    valor_vinculado REAL DEFAULT 0,      -- soma dos vínculos (para saber se ainda tem saldo livre)
    banco_pagador TEXT,                  -- 'BB','BRB','CAIXA', etc
    conta_pagador TEXT,                  -- agência/conta ofuscada (ex: '2028-0 / 3145-X')
    cnpj_pagador TEXT,                   -- CNPJ da empresa que pagou (nossa) — validado contra empresa da sessão
    cnpj_destinatario TEXT,              -- CNPJ do recebedor
    nome_destinatario TEXT,
    numero_documento TEXT,               -- número OB/TED/ID PIX
    arquivo_path TEXT,                   -- caminho relativo ao uploadsPath da empresa
    arquivo_hash TEXT,                   -- SHA256 para deduplicação
    arquivo_mimetype TEXT,
    arquivo_tamanho INTEGER,
    observacao TEXT,
    status TEXT NOT NULL DEFAULT 'PENDENTE', -- 'PENDENTE' | 'PARCIAL' | 'TOTAL'
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_comp_data ON comprovantes_pagamento(data_pagamento);
  CREATE INDEX IF NOT EXISTS idx_comp_cnpj_dest ON comprovantes_pagamento(cnpj_destinatario);
  CREATE INDEX IF NOT EXISTS idx_comp_hash ON comprovantes_pagamento(arquivo_hash);
  CREATE INDEX IF NOT EXISTS idx_comp_status ON comprovantes_pagamento(status);

  CREATE TABLE IF NOT EXISTS comprovante_vinculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comprovante_id INTEGER NOT NULL,
    tipo_destino TEXT NOT NULL,          -- 'NF' | 'DESPESA' | 'CONTRATO_CREDITO' | 'EXTRATO'
    destino_id TEXT NOT NULL,            -- id (texto pra suportar numContrato composto)
    destino_label TEXT,                  -- descrição legível (p.ex: "NF 202600000000123 — R$ 51.003,98")
    valor_vinculado REAL NOT NULL,
    observacao TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (comprovante_id) REFERENCES comprovantes_pagamento(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_compv_cpm ON comprovante_vinculos(comprovante_id);
  CREATE INDEX IF NOT EXISTS idx_compv_dest ON comprovante_vinculos(tipo_destino, destino_id);
`;

for (const p of dbs) {
  try {
    if (!fs.existsSync(p)) { console.log('  × DB ausente:', p); continue; }
    const db = new Database(p);
    db.exec(SCHEMA_COMPROVANTES);
    const cols = db.prepare('PRAGMA table_info(comprovantes_pagamento)').all().map(c => c.name);
    console.log(`✓ ${p} — ${cols.length} colunas em comprovantes_pagamento`);
    db.close();
  } catch (e) {
    console.log('! Erro em', p, ':', e.message);
  }
}
