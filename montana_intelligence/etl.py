#!/usr/bin/env python3
"""
Montana Intelligence — ETL
Lê os SQLites do Montana App e gera linguagem natural no knowledge_base.db
Roda no servidor GCP ou qualquer máquina com acesso aos bancos.

Uso:
    python3 etl.py                    # Processa tudo
    python3 etl.py --empresa assessoria   # Só uma empresa
    python3 etl.py --modo incremental     # Só registros novos
"""

import sqlite3
import json
import os
import argparse
from datetime import datetime, date

# ─── Configuração ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EMPRESAS = {
    'assessoria': os.path.join(BASE_DIR, 'data', 'assessoria', 'montana.db'),
    'seguranca':  os.path.join(BASE_DIR, 'data', 'seguranca',  'montana.db'),
    'mustang':    os.path.join(BASE_DIR, 'data', 'mustang',    'montana.db'),
    'portodovau': os.path.join(BASE_DIR, 'data', 'portodovau', 'montana.db'),
}

KB_PATH = os.path.join(BASE_DIR, 'montana_intelligence', 'knowledge_base.db')

NOMES_EMPRESA = {
    'assessoria': 'Montana Assessoria',
    'seguranca':  'Montana Segurança',
    'mustang':    'Montana Mustang',
    'portodovau': 'Porto do Vau',
}

# ─── Banco de Conhecimento ───────────────────────────────────────────────────

def abrir_kb():
    kb = sqlite3.connect(KB_PATH)
    kb.row_factory = sqlite3.Row
    kb.execute('''
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa    TEXT NOT NULL,
            categoria  TEXT NOT NULL,
            referencia TEXT NOT NULL,
            conteudo   TEXT NOT NULL,
            dados_json TEXT,
            data_ref   TEXT,
            atualizado TEXT NOT NULL,
            UNIQUE(empresa, categoria, referencia)
        )
    ''')
    kb.execute('''
        CREATE TABLE IF NOT EXISTS meta_indexacao (
            empresa        TEXT PRIMARY KEY,
            ultima_rodada  TEXT,
            total_chunks   INTEGER,
            status         TEXT
        )
    ''')
    kb.execute('''
        CREATE INDEX IF NOT EXISTS idx_empresa_cat
        ON knowledge_chunks(empresa, categoria)
    ''')
    kb.execute('''
        CREATE INDEX IF NOT EXISTS idx_data_ref
        ON knowledge_chunks(data_ref)
    ''')
    kb.commit()
    return kb


def upsert_chunk(kb, empresa, categoria, referencia, conteudo, dados=None, data_ref=None):
    kb.execute('''
        INSERT INTO knowledge_chunks
            (empresa, categoria, referencia, conteudo, dados_json, data_ref, atualizado)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(empresa, categoria, referencia)
        DO UPDATE SET
            conteudo   = excluded.conteudo,
            dados_json = excluded.dados_json,
            data_ref   = excluded.data_ref,
            atualizado = excluded.atualizado
    ''', (
        empresa, categoria, referencia,
        conteudo,
        json.dumps(dados, ensure_ascii=False, default=str) if dados else None,
        data_ref,
        datetime.now().isoformat()
    ))


# ─── Formatadores de texto ────────────────────────────────────────────────────

def fmt_brl(valor):
    try:
        return f"R${float(valor):,.2f}".replace(',', 'X').replace('.', ',').replace('X', '.')
    except:
        return "R$0,00"


def fmt_data(d):
    if not d:
        return "data não informada"
    try:
        if len(str(d)) == 10:
            dt = datetime.strptime(str(d), '%Y-%m-%d')
            return dt.strftime('%d/%m/%Y')
        return str(d)
    except:
        return str(d)


def texto_contrato(emp_nome, c):
    partes = [
        f"Contrato {c['numContrato'] or c.get('contrato', '?')} firmado com {c['orgao']}",
        f"pela {emp_nome}.",
        f"Vigência de {fmt_data(c.get('vigencia_inicio'))} a {fmt_data(c.get('vigencia_fim'))}.",
        f"Valor mensal bruto {fmt_brl(c.get('valor_mensal_bruto', 0))}",
        f"(líquido {fmt_brl(c.get('valor_mensal_liquido', 0))}).",
        f"Total pago até hoje: {fmt_brl(c.get('total_pago', 0))}.",
        f"Saldo a receber: {fmt_brl(c.get('total_aberto', 0))}.",
        f"Status: {c.get('status', 'desconhecido')}.",
    ]
    obs = c.get('obs') or ''
    if obs:
        partes.append(f"Observação: {obs[:200]}.")
    reaj = c.get('data_proximo_reajuste')
    if reaj:
        partes.append(f"Próximo reajuste previsto: {fmt_data(reaj)}.")
    return ' '.join(partes)


def texto_nf(emp_nome, nf):
    status_map = {
        'CONCILIADO': 'paga/conciliada',
        'PENDENTE':   'pendente de pagamento',
        'CANCELADA':  'cancelada',
    }
    status = status_map.get(nf.get('status_conciliacao', ''), nf.get('status_conciliacao', 'sem status'))
    partes = [
        f"Nota Fiscal nº {nf['numero']} emitida pela {emp_nome}",
        f"para {(nf.get('tomador') or 'tomador não informado')[:60]}",
        f"referente a {nf.get('competencia', '?')}.",
        f"Valor bruto {fmt_brl(nf.get('valor_bruto', 0))}",
        f"(líquido {fmt_brl(nf.get('valor_liquido', 0))}).",
    ]
    retencoes = []
    if float(nf.get('iss') or 0) > 0:
        retencoes.append(f"ISS {fmt_brl(nf.get('iss'))}")
    if float(nf.get('inss') or 0) > 0:
        retencoes.append(f"INSS {fmt_brl(nf.get('inss'))}")
    if float(nf.get('ir') or 0) > 0:
        retencoes.append(f"IR {fmt_brl(nf.get('ir'))}")
    if float(nf.get('pis') or 0) > 0:
        retencoes.append(f"PIS {fmt_brl(nf.get('pis'))}")
    if float(nf.get('cofins') or 0) > 0:
        retencoes.append(f"COFINS {fmt_brl(nf.get('cofins'))}")
    if retencoes:
        partes.append(f"Retenções: {', '.join(retencoes)}.")
    if nf.get('contrato_ref'):
        partes.append(f"Vinculada ao contrato {nf['contrato_ref']}.")
    partes.append(f"Situação: {status}.")
    if nf.get('data_emissao'):
        partes.append(f"Emitida em {fmt_data(nf['data_emissao'])}.")
    return ' '.join(partes)


def texto_extrato_resumo(emp_nome, mes, dados):
    partes = [
        f"Extrato bancário de {emp_nome} — {mes}.",
        f"Total de {dados['qtd']} lançamentos.",
        f"Entradas: {fmt_brl(dados['creditos'])}.",
        f"Saídas: {fmt_brl(dados['debitos'])}.",
        f"Saldo do período: {fmt_brl(float(dados['creditos']) - float(dados['debitos']))}.",
        f"Conciliados: {dados['conciliados']} lançamentos.",
        f"Pendentes de identificação: {dados['pendentes']} lançamentos",
        f"({fmt_brl(dados['pendentes_valor'])}).",
    ]
    return ' '.join(partes)


def texto_contrato_saude(emp_nome, c, nfs_stats):
    partes = [
        f"Saúde financeira do contrato {c['numContrato']} ({c['orgao']}) — {emp_nome}.",
        f"Total de {nfs_stats['qtd']} NFs emitidas no último ano.",
        f"NFs pagas/conciliadas: {nfs_stats['pagas']} ({fmt_brl(nfs_stats['valor_pago'])}).",
        f"NFs pendentes: {nfs_stats['pendentes']} ({fmt_brl(nfs_stats['valor_pendente'])}).",
    ]
    if nfs_stats.get('ultima_paga'):
        partes.append(f"Último pagamento registrado: {fmt_data(nfs_stats['ultima_paga'])}.")
    if nfs_stats.get('mais_antiga_pendente'):
        partes.append(
            f"NF pendente mais antiga: {fmt_data(nfs_stats['mais_antiga_pendente'])} "
            f"({nfs_stats['dias_atraso']} dias)."
        )
    return ' '.join(partes)


def texto_funcionario(emp_nome, f):
    status = 'ativo' if f.get('status') == 'ATIVO' else f.get('status', 'desconhecido')
    partes = [
        f"Funcionário {f['nome']} da {emp_nome}.",
        f"Cargo: {f.get('cargo_nome', 'não informado')}.",
        f"Lotação/contrato: {f.get('lotacao') or f.get('contrato_ref') or 'não informado'}.",
        f"Admissão: {fmt_data(f.get('data_admissao'))}.",
        f"Status: {status}.",
    ]
    if f.get('data_demissao'):
        partes.append(f"Demissão: {fmt_data(f['data_demissao'])}.")
    if f.get('salario_base') and float(f.get('salario_base') or 0) > 0:
        partes.append(f"Salário base: {fmt_brl(f['salario_base'])}.")
    return ' '.join(partes)


def texto_despesa(emp_nome, d):
    partes = [
        f"Despesa da {emp_nome}: {d.get('descricao', 'sem descrição')[:80]}.",
        f"Categoria: {d.get('categoria', '?')}.",
        f"Fornecedor: {d.get('fornecedor', 'não informado')[:50]}.",
        f"Valor: {fmt_brl(d.get('valor_liquido', 0))}.",
        f"Data: {fmt_data(d.get('data_iso') or d.get('data_despesa'))}.",
        f"Status: {d.get('status', 'desconhecido')}.",
    ]
    if d.get('contrato_ref'):
        partes.append(f"Contrato: {d['contrato_ref']}.")
    return ' '.join(partes)


# ─── Processadores por empresa ────────────────────────────────────────────────

def processar_empresa(kb, empresa_key, db_path, modo='full'):
    emp_nome = NOMES_EMPRESA[empresa_key]
    total = 0

    if not os.path.exists(db_path):
        print(f"  ⚠️  Banco não encontrado: {db_path}")
        kb.execute('''
            INSERT OR REPLACE INTO meta_indexacao VALUES (?, ?, ?, ?)
        ''', (empresa_key, datetime.now().isoformat(), 0, 'banco_ausente'))
        kb.commit()
        return 0

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # ── Contratos ──────────────────────────────────────────────────────────
    try:
        for c in conn.execute("SELECT * FROM contratos ORDER BY status, numContrato"):
            c = dict(c)
            # Busca estatísticas de NFs para o contrato
            nf_stats = {'qtd': 0, 'pagas': 0, 'pendentes': 0,
                        'valor_pago': 0, 'valor_pendente': 0,
                        'ultima_paga': None, 'mais_antiga_pendente': None, 'dias_atraso': 0}
            try:
                stats = conn.execute('''
                    SELECT
                        COUNT(*) as qtd,
                        SUM(CASE WHEN status_conciliacao='CONCILIADO' THEN 1 ELSE 0 END) as pagas,
                        SUM(CASE WHEN status_conciliacao='PENDENTE' THEN 1 ELSE 0 END) as pendentes,
                        SUM(CASE WHEN status_conciliacao='CONCILIADO' THEN valor_liquido ELSE 0 END) as valor_pago,
                        SUM(CASE WHEN status_conciliacao='PENDENTE' THEN valor_liquido ELSE 0 END) as valor_pendente,
                        MAX(CASE WHEN status_conciliacao='CONCILIADO' THEN data_emissao END) as ultima_paga,
                        MIN(CASE WHEN status_conciliacao='PENDENTE' THEN data_emissao END) as mais_antiga_pendente
                    FROM notas_fiscais
                    WHERE contrato_ref = ?
                      AND data_emissao >= date('now', '-12 months')
                ''', (c['numContrato'],)).fetchone()
                if stats:
                    nf_stats.update(dict(stats))
                    if nf_stats.get('mais_antiga_pendente'):
                        try:
                            d0 = datetime.strptime(nf_stats['mais_antiga_pendente'], '%Y-%m-%d')
                            nf_stats['dias_atraso'] = (datetime.now() - d0).days
                        except:
                            pass
            except Exception:
                pass

            # Texto do contrato + saúde financeira
            texto_c = texto_contrato(emp_nome, c)
            texto_s = texto_contrato_saude(emp_nome, c, nf_stats)
            texto_final = texto_c + " — " + texto_s

            upsert_chunk(kb, empresa_key, 'contrato', c['numContrato'],
                         texto_final, {**c, 'nf_stats': nf_stats},
                         c.get('vigencia_fim'))
            total += 1
    except Exception as e:
        print(f"  ⚠️  Contratos [{empresa_key}]: {e}")

    # ── Notas Fiscais (últimos 12 meses) ──────────────────────────────────
    try:
        filtro_data = "AND data_emissao >= date('now', '-12 months')" if modo == 'incremental' else ""
        for nf in conn.execute(f'''
            SELECT * FROM notas_fiscais
            WHERE 1=1 {filtro_data}
            ORDER BY data_emissao DESC
        '''):
            nf = dict(nf)
            texto_n = texto_nf(emp_nome, nf)
            upsert_chunk(kb, empresa_key, 'nf', nf['numero'],
                         texto_n, nf, nf.get('data_emissao'))
            total += 1
    except Exception as e:
        print(f"  ⚠️  NFs [{empresa_key}]: {e}")

    # ── Extratos bancários (resumo por mês) ───────────────────────────────
    try:
        for row in conn.execute('''
            SELECT
                mes,
                COUNT(*) as qtd,
                COALESCE(SUM(credito), 0) as creditos,
                COALESCE(SUM(debito), 0)  as debitos,
                COUNT(CASE WHEN status_conciliacao='CONCILIADO' THEN 1 END) as conciliados,
                COUNT(CASE WHEN status_conciliacao='PENDENTE'
                            OR status_conciliacao IS NULL THEN 1 END) as pendentes,
                COALESCE(SUM(CASE WHEN (status_conciliacao='PENDENTE'
                            OR status_conciliacao IS NULL) AND credito > 0
                            THEN credito END), 0) as pendentes_valor,
                MIN(data_iso) as data_inicio
            FROM extratos
            GROUP BY mes
            ORDER BY data_inicio DESC
            LIMIT 18
        '''):
            row = dict(row)
            texto_e = texto_extrato_resumo(emp_nome, row['mes'], row)
            upsert_chunk(kb, empresa_key, 'extrato_mensal', row['mes'],
                         texto_e, row, row.get('data_inicio'))
            total += 1
    except Exception as e:
        print(f"  ⚠️  Extratos [{empresa_key}]: {e}")

    # ── Funcionários ativos ───────────────────────────────────────────────
    try:
        for f in conn.execute('''
            SELECT rh.*, c.nome as cargo_nome
            FROM rh_funcionarios rh
            LEFT JOIN rh_cargos c ON rh.cargo_id = c.id
            WHERE rh.status = 'ATIVO'
        '''):
            f = dict(f)
            texto_f = texto_funcionario(emp_nome, f)
            upsert_chunk(kb, empresa_key, 'funcionario', str(f.get('id', f['nome'])),
                         texto_f, f, f.get('data_admissao'))
            total += 1
    except Exception as e:
        print(f"  ⚠️  Funcionários [{empresa_key}]: {e}")

    # ── Despesas recentes ─────────────────────────────────────────────────
    try:
        for d in conn.execute('''
            SELECT * FROM despesas
            WHERE data_iso >= date('now', '-6 months')
            ORDER BY data_iso DESC
        '''):
            d = dict(d)
            upsert_chunk(kb, empresa_key, 'despesa', str(d['id']),
                         texto_despesa(emp_nome, d), d, d.get('data_iso'))
            total += 1
    except Exception as e:
        print(f"  ⚠️  Despesas [{empresa_key}]: {e}")

    # ── Sumário geral da empresa ──────────────────────────────────────────
    try:
        resumo = {}
        for tabela in ['contratos', 'notas_fiscais', 'rh_funcionarios', 'despesas', 'extratos']:
            try:
                r = conn.execute(f"SELECT COUNT(*) as n FROM {tabela}").fetchone()
                resumo[tabela] = r['n'] if r else 0
            except:
                resumo[tabela] = 0

        # Valores chave
        financeiro = conn.execute('''
            SELECT
                COALESCE(SUM(CASE WHEN status_conciliacao='PENDENTE' THEN valor_liquido END), 0) as pendente,
                COALESCE(SUM(CASE WHEN status_conciliacao='CONCILIADO'
                    AND data_emissao >= date('now', '-3 months') THEN valor_liquido END), 0) as recebido_3m,
                COUNT(CASE WHEN status='ATIVO' THEN 1 END) as contratos_ativos
            FROM notas_fiscais
            LEFT JOIN contratos ON notas_fiscais.contrato_ref = contratos.numContrato
        ''').fetchone()

        texto_sumario = (
            f"Sumário da {emp_nome}: "
            f"{resumo.get('contratos', 0)} contratos cadastrados, "
            f"{resumo.get('notas_fiscais', 0)} notas fiscais no total, "
            f"{resumo.get('rh_funcionarios', 0)} funcionários registrados. "
            f"NFs pendentes de pagamento: {fmt_brl(financeiro['pendente'] if financeiro else 0)}. "
            f"Recebido nos últimos 3 meses: {fmt_brl(financeiro['recebido_3m'] if financeiro else 0)}."
        )
        upsert_chunk(kb, empresa_key, 'sumario', 'geral', texto_sumario, resumo)
        total += 1
    except Exception as e:
        print(f"  ⚠️  Sumário [{empresa_key}]: {e}")

    conn.close()

    # Atualiza meta
    kb.execute('''
        INSERT OR REPLACE INTO meta_indexacao VALUES (?, ?, ?, ?)
    ''', (empresa_key, datetime.now().isoformat(), total, 'ok'))
    kb.commit()

    return total


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Montana Intelligence — ETL')
    parser.add_argument('--empresa', choices=list(EMPRESAS.keys()),
                        help='Processar só uma empresa')
    parser.add_argument('--modo', choices=['full', 'incremental'], default='full',
                        help='full = tudo | incremental = só últimos 12 meses')
    args = parser.parse_args()

    print(f"\n🔄 Montana Intelligence ETL — {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print(f"   Banco de conhecimento: {KB_PATH}\n")

    kb = abrir_kb()

    empresas_processar = {args.empresa: EMPRESAS[args.empresa]} if args.empresa else EMPRESAS

    total_geral = 0
    for empresa_key, db_path in empresas_processar.items():
        print(f"  📂 Processando {NOMES_EMPRESA[empresa_key]}...")
        n = processar_empresa(kb, empresa_key, db_path, args.modo)
        print(f"     ✅ {n} chunks indexados")
        total_geral += n

    print(f"\n✅ Total: {total_geral} chunks no knowledge_base.db")
    print(f"   Pronto para o servidor MCP consultar.\n")


if __name__ == '__main__':
    main()
