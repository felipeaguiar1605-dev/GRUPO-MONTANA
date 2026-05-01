-- Montana — Migração P2: Fluxo Prévia → Aprovação → Emissão → Boletim Final
-- Data: 2026-04-30
--
-- Aplicar em cada schema (assessoria, seguranca, portodovau, mustang).
-- Idempotente: usa IF NOT EXISTS / IF EXISTS pra ser seguro re-rodar.
--
-- Mudanças:
--   1. bol_boletins: +posto_id, +aprovado_por/em, +expira_em, +tem_nf_cancelada,
--      +nfse_data_cancelamento, +template_renderizado
--   2. bol_contratos: +template_discriminacao
--   3. NOVA: bol_aditivos
--   4. NOVA: bol_boletins_nfs_planejadas
--   5. Novo índice UNIQUE (contrato_id, posto_id, competencia)

\set ON_ERROR_STOP on

-- ============================================================
--   1. bol_boletins — colunas novas
-- ============================================================

ALTER TABLE bol_boletins ADD COLUMN IF NOT EXISTS posto_id BIGINT NULL;
ALTER TABLE bol_boletins ADD COLUMN IF NOT EXISTS aprovado_por TEXT;
ALTER TABLE bol_boletins ADD COLUMN IF NOT EXISTS aprovado_em TIMESTAMP;
ALTER TABLE bol_boletins ADD COLUMN IF NOT EXISTS expira_em DATE;
ALTER TABLE bol_boletins ADD COLUMN IF NOT EXISTS tem_nf_cancelada BOOLEAN DEFAULT FALSE;
ALTER TABLE bol_boletins ADD COLUMN IF NOT EXISTS nfse_data_cancelamento TIMESTAMP;
ALTER TABLE bol_boletins ADD COLUMN IF NOT EXISTS template_renderizado TEXT;

-- FK opcional (não bloqueia null) — referência a bol_postos
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'bol_postos')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.constraint_column_usage
       WHERE constraint_name = 'bol_boletins_posto_id_fkey' AND table_schema = current_schema()
     )
  THEN
    BEGIN
      ALTER TABLE bol_boletins
        ADD CONSTRAINT bol_boletins_posto_id_fkey
        FOREIGN KEY (posto_id) REFERENCES bol_postos(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN
      NULL;  -- já existe, ignora
    END;
  END IF;
END $$;

-- ============================================================
--   2. Índice UNIQUE: troca (contrato_id, comp) por (contrato_id, COALESCE(posto_id,0), comp)
-- ============================================================

DROP INDEX IF EXISTS bol_boletins_contrato_comp_uq;
CREATE UNIQUE INDEX IF NOT EXISTS bol_boletins_contrato_posto_comp_uq
  ON bol_boletins (contrato_id, COALESCE(posto_id, 0), competencia);

-- ============================================================
--   3. bol_contratos — template de discriminação
-- ============================================================

ALTER TABLE bol_contratos ADD COLUMN IF NOT EXISTS template_discriminacao TEXT;

-- ============================================================
--   4. NOVA: bol_aditivos
-- ============================================================

CREATE TABLE IF NOT EXISTS bol_aditivos (
  id              BIGSERIAL PRIMARY KEY,
  contrato_id     BIGINT NOT NULL REFERENCES bol_contratos(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,                  -- 'reajuste', 'prorrogacao', 'apostilamento', 'reequilibrio'
  data_assinatura DATE,
  vigencia_de     DATE NOT NULL,
  vigencia_ate    DATE,                           -- NULL = sem prazo final
  fator           NUMERIC(10,6) DEFAULT 1.0,      -- 1.0825 = +8.25%
  base_legal      TEXT,                           -- 'CCT 24/2025 SINTECAP/TO'
  observacao      TEXT,
  status          TEXT DEFAULT 'rascunho',        -- 'rascunho', 'validado', 'aplicado', 'cancelado'
  validado_por    TEXT,
  validado_em     TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bol_aditivos_contrato     ON bol_aditivos(contrato_id);
CREATE INDEX IF NOT EXISTS bol_aditivos_vigencia     ON bol_aditivos(vigencia_de, vigencia_ate);
CREATE INDEX IF NOT EXISTS bol_aditivos_status       ON bol_aditivos(status);

-- ============================================================
--   5. NOVA: bol_boletins_nfs_planejadas
-- ============================================================

CREATE TABLE IF NOT EXISTS bol_boletins_nfs_planejadas (
  id                   BIGSERIAL PRIMARY KEY,
  boletim_id           BIGINT NOT NULL REFERENCES bol_boletins(id) ON DELETE CASCADE,
  ordem                INT DEFAULT 0,
  posto_id             BIGINT REFERENCES bol_postos(id) ON DELETE SET NULL,
  descricao_template   TEXT,                      -- texto renderizado do template (read-only ref)
  descricao_override   TEXT,                      -- override Q7: se preenchido, sobrescreve
  valor                NUMERIC(14,2) NOT NULL,
  rps_numero           TEXT,
  rps_serie            TEXT DEFAULT 'NFSE',
  nfse_numero          TEXT,
  nfse_data_emissao    TIMESTAMP,
  status               TEXT DEFAULT 'pendente',   -- 'pendente', 'emitindo', 'emitida', 'erro', 'cancelada'
  erro_mensagem        TEXT,
  tentativas           INT DEFAULT 0,
  emitida_em           TIMESTAMP,
  emitida_por          TEXT,
  created_at           TIMESTAMP DEFAULT NOW(),
  updated_at           TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bol_nfs_planejadas_boletim ON bol_boletins_nfs_planejadas(boletim_id);
CREATE INDEX IF NOT EXISTS bol_nfs_planejadas_status  ON bol_boletins_nfs_planejadas(status);
CREATE INDEX IF NOT EXISTS bol_nfs_planejadas_nfse    ON bol_boletins_nfs_planejadas(nfse_numero);

-- ============================================================
--   6. Adicionar status novos suportados em bol_boletins.status
-- ============================================================
-- Nota: bol_boletins.status já é TEXT free-form. Os novos estados são:
--   'previa', 'aprovado_para_emissao', 'emitindo', 'emitido', 'erro_emissao'
-- (em adição aos legados: 'gerado', 'aprovado', 'sem_nf', 'conciliado_nf', 'divergencia_nf')
-- Não precisa CHECK constraint — código valida.

\echo 'Migration P2 aplicada com sucesso no schema atual.'
