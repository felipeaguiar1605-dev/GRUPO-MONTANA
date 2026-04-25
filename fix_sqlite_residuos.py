#!/usr/bin/env python3
"""
Montana — Corrige resíduos SQLite nos arquivos JS após conversão para PostgreSQL.
Lida com:
  1. PRAGMA table_info(X)  → information_schema.columns
  2. sqlite_master          → information_schema.tables
  3. datetime('now',...)   → NOW()
  4. strftime('%Y-%m', X)  → to_char((X)::date, 'YYYY-MM')
  5. INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
  6. TEXT DEFAULT (datetime(...)) → TIMESTAMP DEFAULT NOW()
"""
import re, os, glob, sys

SRC = r'C:\Users\Avell\OneDrive\Área de Trabalho\Montana_Seg_Conciliacao\app_unificado\src'

# ── Helpers ─────────────────────────────────────────────────────────
def fix_file(path):
    with open(path, encoding='utf-8') as f:
        code = f.read()
    original = code

    # 1. PRAGMA table_info(tablename) → information_schema query
    #    Captura tanto literal quanto template literal ${var}
    def repl_pragma(m):
        tbl = m.group(1).strip()
        # Se é template literal com variável JS, usa interpolação
        if tbl.startswith('${') and tbl.endswith('}'):
            # Para template literals: `PRAGMA table_info(${table})`
            # → `SELECT column_name as name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='${table}' ORDER BY ordinal_position`
            var = tbl[2:-1]  # extrai nome da variável
            return (f"SELECT column_name as name FROM information_schema.columns "
                    f"WHERE table_schema=current_schema() AND table_name='${{' + {repr(var)} + '}}' "
                    f"ORDER BY ordinal_position")
        else:
            return (f"SELECT column_name as name FROM information_schema.columns "
                    f"WHERE table_schema=current_schema() AND table_name='{tbl}' "
                    f"ORDER BY ordinal_position")

    # Substitui dentro de template literals e strings
    code = re.sub(r'PRAGMA\s+table_info\((\$\{[^}]+\}|[\w_]+)\)', repl_pragma, code)

    # 2. sqlite_master → information_schema.tables
    code = code.replace(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        "SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=$1"
    )
    code = re.sub(
        r"SELECT\s+name\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'",
        "SELECT table_name as name FROM information_schema.tables WHERE table_schema=current_schema()",
        code
    )

    # 3. datetime('now','localtime') e datetime('now') → NOW()
    code = re.sub(r"datetime\('now'\s*,\s*'localtime'\)", "NOW()", code, flags=re.IGNORECASE)
    code = re.sub(r'datetime\("now"\s*,\s*"localtime"\)', "NOW()", code, flags=re.IGNORECASE)
    code = re.sub(r"datetime\('now'\)", "NOW()", code, flags=re.IGNORECASE)
    code = re.sub(r'datetime\("now"\)', "NOW()", code, flags=re.IGNORECASE)
    # datetime('now','-N day','localtime') → NOW() - INTERVAL 'N days'
    def repl_datetime_interval(m):
        n = m.group(1)
        unit = m.group(2).rstrip('s') + 's'
        return f"NOW() - INTERVAL '{n} {unit}'"
    code = re.sub(
        r"datetime\('now'\s*,\s*'-(\d+)\s*(days?|hours?|minutes?)'\s*(?:,\s*'localtime')?\)",
        repl_datetime_interval, code, flags=re.IGNORECASE
    )

    # 4. strftime('%Y-%m', campo) → to_char((campo)::date, 'YYYY-MM')
    #    strftime('%Y', campo)    → to_char((campo)::date, 'YYYY')
    #    strftime('%m', campo)    → to_char((campo)::date, 'MM')
    FMT_MAP = {
        '%Y-%m-%d': 'YYYY-MM-DD',
        '%Y-%m':    'YYYY-MM',
        '%Y':       'YYYY',
        '%m':       'MM',
        '%d':       'DD',
    }
    def repl_strftime(m):
        fmt_sqlite = m.group(1)
        col = m.group(2).strip()
        pg_fmt = FMT_MAP.get(fmt_sqlite, fmt_sqlite.replace('%Y','YYYY').replace('%m','MM').replace('%d','DD'))
        return f"to_char(({col})::date, '{pg_fmt}')"
    code = re.sub(
        r"strftime\s*\(\s*'([^']+)'\s*,\s*([^)]+?)\s*\)",
        repl_strftime, code
    )

    # 5. CREATE TABLE: INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
    code = re.sub(
        r'\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b',
        'BIGSERIAL PRIMARY KEY',
        code, flags=re.IGNORECASE
    )
    # INTEGER PRIMARY KEY (sem AUTOINCREMENT) → BIGSERIAL PRIMARY KEY
    code = re.sub(
        r'\bINTEGER\s+PRIMARY\s+KEY\b(?!\s+AUTOINCREMENT)',
        'BIGSERIAL PRIMARY KEY',
        code, flags=re.IGNORECASE
    )

    # 6. TEXT DEFAULT (NOW()) → TIMESTAMP DEFAULT NOW()  (em CREATE TABLE)
    code = re.sub(
        r'\bTEXT\s+DEFAULT\s+\(NOW\(\)\)',
        'TIMESTAMP DEFAULT NOW()',
        code, flags=re.IGNORECASE
    )
    code = re.sub(
        r'\bTEXT\s+DEFAULT\s+NOW\(\)',
        'TIMESTAMP DEFAULT NOW()',
        code, flags=re.IGNORECASE
    )

    # 7. ALTER TABLE ... ADD COLUMN ... TEXT (sem default) — OK, não mexe
    #    Mas corrige o padrão de acesso ao resultado de PRAGMA (agora é column_name, não name)
    #    → PRAGMA já retorna 'name' via alias, OK

    # 8. .map(c => c.name) após PRAGMA → já funciona porque alias é 'name', OK

    # 9. ensureFichaTable / ensureItemCols / ensureMovCols:
    #    O ALTER TABLE ADD COLUMN falha silenciosamente no PG se coluna já existe
    #    → envolve em bloco que ignora "column already exists"
    #    Heurística: substitui padrão  await db.prepare(`ALTER TABLE X ADD COLUMN Y T`).run()
    #    por versão que usa IF NOT EXISTS (PG 9.6+: não existe, mas podemos usar DO $$)
    #    Solução mais simples: deixa como está — o PG lança erro, mas o catch do ensureXxx
    #    já silencia (try/catch na função que chama)
    #    → Adiciona try/catch em cada ALTER TABLE ADD COLUMN
    def wrap_alter(m):
        indent = m.group(1)
        stmt = m.group(2)
        return (f"{indent}try {{ await {stmt} }} "
                f"catch (e) {{ if (!e.message?.includes('already exists')) throw e; }}")
    code = re.sub(
        r'^(\s+)(await db\.prepare\s*\(`ALTER TABLE \S+ ADD COLUMN[^`]+`\)\.run\(\)\s*;?)',
        wrap_alter, code, flags=re.MULTILINE
    )

    if code == original:
        print(f'  ○ {os.path.relpath(path, SRC)} — sem mudanças')
        return False

    bak = path + '.bak_sqlite'
    if not os.path.exists(bak):
        with open(bak, 'w', encoding='utf-8') as f:
            f.write(original)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(code)
    print(f'  ✓ {os.path.relpath(path, SRC)}')
    return True

# ── Targets ─────────────────────────────────────────────────────────
targets = sys.argv[1:] or (
    [os.path.join(SRC, 'api.js'),
     os.path.join(SRC, 'alertas-operacionais.js'),
     os.path.join(SRC, 'fluxo-caixa-projetado.js'),
     os.path.join(SRC, 'server.js'),
    ] +
    glob.glob(os.path.join(SRC, 'routes', '*.js')) +
    glob.glob(os.path.join(SRC, 'middleware', '*.js'))
)
targets = [f for f in targets if '.bak' not in f and os.path.exists(f)]

changed = 0
for f in targets:
    if fix_file(f): changed += 1

print(f'\nTotal: {changed} arquivos corrigidos de {len(targets)}')

