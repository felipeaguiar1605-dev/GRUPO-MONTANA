#!/usr/bin/env python3
"""
Fix: funções que contêm 'await' mas não são 'async' → adiciona async.
Também corrige bugs do conversor automático.
"""
import re, sys, os, glob

def fix_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        code = f.read()
    original = code

    # 1. Corrige bug: "e.await " → "await " (regex do conversor inseriu no lugar errado)
    code = re.sub(r'(\w)\.await\s+', lambda m: m.group(0).replace('.await ', '; await '), code)
    # Mais específico: "e.await db." → "await db."
    code = re.sub(r'(\w+)\.await\s+(db|req\.db)\.', r'await \2.', code)

    # 2. Torna async todas as `function nome(` que têm `await` no corpo
    #    Estratégia: varrer linha a linha, rastrear profundidade de chaves
    lines = code.split('\n')
    result = []
    i = 0
    while i < len(lines):
        line = lines[i]

        # Detecta início de função não-async
        is_func = re.match(r'^(\s*)(export\s+)?function\s+(\w)', line)
        is_method = re.match(r'^(\s*)(\w+)\s*\([^)]*\)\s*\{', line) and 'router.' not in line and 'app.' not in line

        if is_func and 'async' not in line:
            # Coleta o corpo da função para verificar se tem 'await'
            # Approach simples: pega as próximas 200 linhas ou até chegar no nível de chave 0
            depth = 0
            body_lines = []
            j = i
            while j < len(lines) and j < i + 300:
                body_lines.append(lines[j])
                depth += lines[j].count('{') - lines[j].count('}')
                if j > i and depth <= 0:
                    break
                j += 1
            body = '\n'.join(body_lines)
            if 'await ' in body:
                # Adiciona async antes de function
                line = re.sub(r'^(\s*)(export\s+)?function\s+',
                               lambda m: m.group(1) + (m.group(2) or '') + 'async function ',
                               line)

        result.append(line)
        i += 1

    code = '\n'.join(result)

    # 3. Corrige arrow functions helper (não em router.) que têm await
    #    Ex: const fn = (args) => { ... await ... }  → async (args) => {
    #    Heurística: const/let/var name = (args) => { com await no corpo
    def fix_arrow_fn(m):
        full = m.group(0)
        if 'async' in full:
            return full
        # Verifica se tem await (busca simples nos primeiros 500 chars)
        if 'await' in full:
            return re.sub(r'=\s*\(', '= async (', full, count=1)
        return full

    # 4. Adiciona await antes de chamadas de funções auxiliares conhecidas
    #    que agora são async (ex: ensureTables, atualizarStatus, ensureFichaTable, etc.)
    #    Se aparecem em contexto async (dentro de router handler), adiciona await
    known_async_helpers = [
        'ensureTables', 'ensureFichaTable', 'atualizarStatus', 'ensureSchema',
        'ensureColumns', 'migrarSchema', 'initSchema', 'criarTabelas',
    ]
    for fn_name in known_async_helpers:
        # Não adiciona await se já tem, e só dentro de funções async
        code = re.sub(
            r'(?<!await\s)(?<!await )(\b' + fn_name + r'\s*\()',
            r'await \1',
            code
        )

    # 5. Adiciona await antes de trans() / tx() / batch() sem await
    code = re.sub(r'(?<![.\w])(?<!await )(trans|tx|batch|importarTudo|processar|registrar|insert|upsertItem)\s*\(\s*\)',
                  r'await \1()', code)
    # Corrige double await
    code = re.sub(r'await\s+await\s+', 'await ', code)

    # 6. Dentro de .transaction(async ... { ... .run(...) sem await
    #    Heurística: .run( em linha que não tem await, dentro de bloco transaction
    #    Muito arriscado sem AST — pular

    # 7. .prepare(sql) retorna objeto, não Promise — REMOVE await incorreto do prepare()
    #    MAS só remove se o prepare() NÃO é seguido por .get/.all/.run na mesma linha
    #    (em cadeias multiline, o await aplica-se ao .all/.get/.run no final da cadeia)
    #    Ex: const upd = await db.prepare(...) → const upd = db.prepare(...)  (sem chain)
    #    Ex: await db.prepare(sql).all()  → MANTÉM o await (chain inline)
    #    Ex: await db.prepare(`\n...\n`).all() → MANTÉM o await (chain multiline)
    def remove_prepare_await(m):
        # Get remaining code after the match to see if chain ends in .get/.all/.run
        rest = code[m.end():]
        # Check if same line has .get/.all/.run
        line_end = rest.find('\n')
        same_line = rest[:line_end] if line_end != -1 else rest
        if re.search(r'\)\s*\.\s*(?:get|all|run)\s*\(', same_line):
            return m.group(0)  # keep the await (it's a chain)
        # Also check next few lines for the chain continuation
        next_lines = rest[:500]
        if re.search(r'`\s*\)\s*\.\s*(?:get|all|run)\s*\(', next_lines):
            return m.group(0)  # keep the await (multiline chain)
        return m.group(1)  # remove the await (standalone prepare assignment)
    code = re.sub(r'\bawait\s+((?:req\.db|db|\w+)\.prepare\s*\()', remove_prepare_await, code)

    if code != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(code)
        print(f'  ✓ {os.path.basename(path)}')
        return True
    print(f'  ○ {os.path.basename(path)} — sem mudanças')
    return False

if __name__ == '__main__':
    targets = sys.argv[1:]
    if not targets or targets[0] == '--all':
        src = r'C:\Users\Avell\OneDrive\Área de Trabalho\Montana_Seg_Conciliacao\app_unificado\src'
        targets = (
            [os.path.join(src, 'api.js')] +
            glob.glob(os.path.join(src, 'routes', '*.js'))
        )
        targets = [f for f in targets if not f.endswith('.bak_pg') and '.bak' not in f]

    changed = 0
    for f in targets:
        if os.path.exists(f):
            if fix_file(f): changed += 1

    print(f'\nTotal: {changed} arquivos corrigidos')

