-- Montana ERP — Migration 2FA TOTP
-- Aplicar em todos os schemas (assessoria, seguranca, portodovau, mustang)
-- Executar como: psql -h 35.247.208.7 -U montana -d montana_erp -f scripts/migrate_2fa.sql

DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN SELECT unnest(ARRAY['assessoria','seguranca','portodovau','mustang'])
  LOOP
    EXECUTE format('ALTER TABLE %I.usuarios ADD COLUMN IF NOT EXISTS totp_secret TEXT', sch);
    EXECUTE format('ALTER TABLE %I.usuarios ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE', sch);
    EXECUTE format('ALTER TABLE %I.usuarios ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT', sch);
    EXECUTE format('ALTER TABLE %I.usuarios ADD COLUMN IF NOT EXISTS senha_alterada_em TIMESTAMP', sch);
    EXECUTE format('ALTER TABLE %I.usuarios ADD COLUMN IF NOT EXISTS senha_historico TEXT', sch);
    EXECUTE format('ALTER TABLE %I.usuarios ADD COLUMN IF NOT EXISTS tentativas_login INTEGER DEFAULT 0', sch);
    EXECUTE format('ALTER TABLE %I.usuarios ADD COLUMN IF NOT EXISTS bloqueado_ate TIMESTAMP', sch);
    RAISE NOTICE '✓ Schema % migrado (2FA + password policy fields)', sch;
  END LOOP;
END $$;
