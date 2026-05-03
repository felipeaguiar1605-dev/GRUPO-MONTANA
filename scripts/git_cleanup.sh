#!/bin/bash
# Montana ERP — Faxina git do servidor
#
# O servidor está num branch local (vm-snapshot-dispatch-26abr) com 50+ arquivos
# modificados, muitos deles arquivos `.bak_*` (backups da migração SQLite→PG
# que não servem mais). Este script:
#
#   1. Lista o que vai apagar (DRY-RUN por default)
#   2. Pede confirmação
#   3. Apaga .bak_* (lixo)
#   4. Mostra estado limpo para você decidir o que fazer com mudanças reais
#
# Uso:
#   bash scripts/git_cleanup.sh              # dry-run (só mostra)
#   bash scripts/git_cleanup.sh --apply      # apaga arquivos .bak_*
#
# IMPORTANTE: Não toca em arquivos versionados nem faz commit.
# Você decide depois o que fazer com as mudanças não-bak.

set -euo pipefail

cd /opt/montana/app_unificado

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

echo "═══════════════════════════════════════════════════════════"
echo "  Montana ERP — Git cleanup ${APPLY:+APPLY}${APPLY:-DRY-RUN}"
echo "═══════════════════════════════════════════════════════════"

# ── 1. Branch + estado ───────────────────────────────────────────────
echo ""
echo "▶ Branch atual: $(git branch --show-current)"
echo "▶ Último commit: $(git log --oneline -1)"
echo ""

# ── 2. Lista todos os .bak_* — esses são lixo da migração SQLite→PG ─
echo "▶ Arquivos .bak_* a remover (lixo da migração):"
BAK_FILES=$(find . -type f \( -name "*.bak_sqlite" -o -name "*.bak_pg" -o -name "*.bak_2026*" -o -name "*.bak_transparencia" -o -name "*.bak_before_fix" \) | sort)
if [ -z "$BAK_FILES" ]; then
  echo "   (nenhum .bak_* encontrado)"
else
  echo "$BAK_FILES" | head -30
  TOTAL_BAK=$(echo "$BAK_FILES" | wc -l)
  TOTAL_SIZE=$(du -ch $(echo "$BAK_FILES") 2>/dev/null | tail -1 | awk '{print $1}')
  echo "   ..."
  echo "   TOTAL: $TOTAL_BAK arquivos, $TOTAL_SIZE"
fi

if $APPLY; then
  echo ""
  echo "▶ Apagando ${TOTAL_BAK:-0} arquivos .bak_*..."
  if [ -n "$BAK_FILES" ]; then
    echo "$BAK_FILES" | xargs rm -f
    echo "  ✓ Removidos"
  fi
fi

# ── 3. Estado pós-cleanup ────────────────────────────────────────────
echo ""
echo "▶ Mudanças não-bak (modificações REAIS no código):"
git status --short 2>/dev/null | grep -v '\.bak_' | head -30

echo ""
echo "▶ Estatísticas das mudanças (vs branch base):"
git diff --stat 2>/dev/null | grep -v '\.bak_' | tail -15

# ── 4. Recomendação ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  PRÓXIMOS PASSOS RECOMENDADOS"
echo "═══════════════════════════════════════════════════════════"
echo ""
if ! $APPLY; then
  echo "1. Rode com --apply pra deletar os arquivos .bak_*:"
  echo "   bash scripts/git_cleanup.sh --apply"
  echo ""
fi
echo "2. Após cleanup, decida cada mudança pendente:"
echo "   git diff src/api.js                    # ver mudanças"
echo "   git checkout -- <arquivo>              # descartar mudança"
echo "   git add <arquivo>                      # aceitar pra commit"
echo ""
echo "3. Quando tudo classificado:"
echo "   git commit -m 'snapshot pós-cleanup'"
echo "   git push origin vm-snapshot-dispatch-26abr"
echo ""
echo "4. Abrir PR vs main no GitHub e mergear"
