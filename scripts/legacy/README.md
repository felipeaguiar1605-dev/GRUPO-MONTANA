# scripts/legacy

Scripts da era SQLite (`better-sqlite3`). **Nenhum funciona como está hoje** — o
banco SQLite (`data/*/montana.db`) não existe mais; toda a aplicação roda em
PostgreSQL (`db_pg.js`) desde a migração de Mar/2026.

## Quando usar

- **Referência histórica**: ver como dados foram importados/transformados em
  determinadas operações pontuais (ex.: importação de extratos Abr/2026,
  reclassificação de NFs, fix de contratos específicos).
- **Template para portar pra PG**: se algum script aqui resolver um problema
  recorrente, copie pra `scripts/`, troque `require('better-sqlite3')` +
  `new Database(path)` pelo pool PG via `getPool()` (ver `src/db_pg.js`),
  converta `.prepare().get/all/run()` síncronos para `await`.

## Como rodar (se realmente precisar)

```bash
# Instalar a dep ad-hoc (não está mais no package.json)
npm i better-sqlite3 --no-save

# Porém: precisa restaurar um backup .db de antes da migração para o script funcionar
node scripts/legacy/<nome_do_script>.js
```

## Categorias

- `_audit_*`, `_check_*`, `_diag_*`, `_inspect_*` — diagnósticos one-off
- `_fix_*`, `_update_*`, `_reclassificar_*` — correções pontuais de dados
- `_import_*`, `_read_*`, `_organize_*` — imports de PDFs/Excels antigos
- `_cadastra_*`, `_encerrar_*` — operações administrativas one-off
- `_migrate_*`, `_backfill_*` — migrações já executadas
- `bb_sync_manual`, `setup_bb_*`, `set_bb_conta`, `test_bb_oauth*` — utilitários BB
- `conciliacao_*`, `conciliar_*` — conciliações antigas
- `gerar_relatorio_*` — geradores de relatório (precisam port pra PG)
- `criar-usuarios-funcionarios` — criação de usuários
- `cadastrar_apolices_garantia`, `check_certificados_validade` — utilitários
- `importar_folha_escritorio`, `importar_nfe_entrada`, `limpar_despesas` — imports

70 arquivos no total.
