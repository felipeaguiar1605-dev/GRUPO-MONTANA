#!/usr/bin/env python3
"""
Montana Intelligence — Servidor MCP/API
FastAPI que expõe ferramentas do banco de conhecimento para o Claude.

Uso:
    python3 server.py                   # Porta 8001
    python3 server.py --port 8001
    pm2 start server.py --interpreter python3 --name montana-intelligence

Configurar no Claude Desktop:
    Em claude_desktop_config.json adicionar:
    {
      "mcpServers": {
        "montana": {
          "command": "python3",
          "args": ["/opt/montana/app_unificado/montana_intelligence/server.py", "--stdio"],
          "env": { "MONTANA_TOKEN": "seu_token_aqui" }
        }
      }
    }
"""

import sqlite3
import json
import os
import sys
import argparse
from datetime import datetime, date, timedelta
from typing import Optional

# ─── Configuração ─────────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB_PATH  = os.path.join(BASE_DIR, 'montana_intelligence', 'knowledge_base.db')
TOKEN    = os.environ.get('MONTANA_TOKEN', 'montana2026')

EMPRESAS_DB = {
    'assessoria': os.path.join(BASE_DIR, 'data', 'assessoria', 'montana.db'),
    'seguranca':  os.path.join(BASE_DIR, 'data', 'seguranca',  'montana.db'),
    'mustang':    os.path.join(BASE_DIR, 'data', 'mustang',    'montana.db'),
    'portodovau': os.path.join(BASE_DIR, 'data', 'portodovau', 'montana.db'),
}

NOMES_EMPRESA = {
    'assessoria': 'Montana Assessoria',
    'seguranca':  'Montana Segurança',
    'mustang':    'Montana Mustang',
    'portodovau': 'Porto do Vau',
    None:         'Todas as empresas',
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

def kb_conn():
    if not os.path.exists(KB_PATH):
        return None
    conn = sqlite3.connect(KB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def montana_conn(empresa):
    path = EMPRESAS_DB.get(empresa)
    if not path or not os.path.exists(path):
        return None
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def fmt_brl(valor):
    try:
        v = float(valor or 0)
        return f"R${v:,.2f}".replace(',', 'X').replace('.', ',').replace('X', '.')
    except:
        return "R$0,00"


def fmt_data(d):
    if not d:
        return None
    try:
        dt = datetime.strptime(str(d)[:10], '%Y-%m-%d')
        return dt.strftime('%d/%m/%Y')
    except:
        return str(d)


# ─── Ferramentas do Claude ─────────────────────────────────────────────────────

def pendencias_financeiras(empresa: Optional[str] = None, contrato: Optional[str] = None) -> dict:
    """
    Retorna NFs pendentes de pagamento e créditos bancários não identificados.
    Se não informar empresa, retorna de todas.
    """
    resultado = {'empresas': {}, 'total_pendente_nfs': 0, 'total_pendente_banco': 0}
    empresas_list = [empresa] if empresa else list(EMPRESAS_DB.keys())

    for emp in empresas_list:
        conn = montana_conn(emp)
        if not conn:
            continue

        try:
            # NFs pendentes
            query = "SELECT numero, competencia, tomador, valor_liquido, contrato_ref, data_emissao FROM notas_fiscais WHERE status_conciliacao = 'PENDENTE'"
            params = []
            if contrato:
                query += " AND contrato_ref = ?"
                params.append(contrato)
            query += " ORDER BY data_emissao"
            nfs = [dict(r) for r in conn.execute(query, params).fetchall()]

            total_nfs = sum(float(r['valor_liquido'] or 0) for r in nfs)

            # Créditos bancários pendentes
            banco = conn.execute('''
                SELECT COUNT(*) as qtd, COALESCE(SUM(credito), 0) as total
                FROM extratos
                WHERE credito > 0
                  AND (status_conciliacao = 'PENDENTE' OR status_conciliacao IS NULL)
                  AND data_iso >= date('now', '-90 days')
            ''').fetchone()

            resultado['empresas'][NOMES_EMPRESA[emp]] = {
                'nfs_pendentes': len(nfs),
                'valor_nfs_pendente': fmt_brl(total_nfs),
                'creditos_banco_pendentes': banco['qtd'] if banco else 0,
                'valor_banco_pendente': fmt_brl(banco['total'] if banco else 0),
                'detalhes_nfs': [
                    {
                        'numero': r['numero'],
                        'competencia': r['competencia'],
                        'tomador': (r['tomador'] or '')[:50],
                        'valor': fmt_brl(r['valor_liquido']),
                        'contrato': r['contrato_ref'],
                        'emissao': fmt_data(r['data_emissao']),
                    }
                    for r in nfs[:30]
                ]
            }
            resultado['total_pendente_nfs'] += total_nfs
        except Exception as e:
            resultado['empresas'][emp] = {'erro': str(e)}
        finally:
            conn.close()

    resultado['total_pendente_nfs'] = fmt_brl(resultado['total_pendente_nfs'])
    resultado['resumo'] = (
        f"Total de NFs pendentes de pagamento: {resultado['total_pendente_nfs']}. "
        f"Verifique cada empresa para detalhes."
    )
    return resultado


def fluxo_caixa(empresa: str, mes: Optional[str] = None, ano: Optional[int] = None) -> dict:
    """
    Retorna entradas, saídas e saldo de um período.
    mes: 'JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'
    ano: 2026 (padrão: ano atual)
    Se não informar mês, retorna os últimos 6 meses.
    """
    conn = montana_conn(empresa)
    if not conn:
        return {'erro': f'Empresa "{empresa}" não encontrada ou banco indisponível'}

    try:
        if mes:
            mes_upper = mes.upper()[:3]
            filtro = "AND UPPER(SUBSTR(mes, 1, 3)) = ?"
            params = [mes_upper]
        else:
            filtro = "AND data_iso >= date('now', '-6 months')"
            params = []

        rows = conn.execute(f'''
            SELECT
                mes,
                COALESCE(SUM(credito), 0) as entradas,
                COALESCE(SUM(debito), 0)  as saidas,
                COUNT(CASE WHEN credito > 0 AND status_conciliacao='CONCILIADO' THEN 1 END) as conc_entradas,
                COUNT(CASE WHEN credito > 0 AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL) THEN 1 END) as pend_entradas,
                COALESCE(SUM(CASE WHEN status_conciliacao='INVESTIMENTO' THEN credito END), 0) as investimentos,
                COALESCE(SUM(CASE WHEN status_conciliacao='INTERNO' THEN credito END), 0) as internos
            FROM extratos
            WHERE 1=1 {filtro}
            GROUP BY mes
            ORDER BY MIN(data_iso) DESC
        ''', params).fetchall()

        meses = []
        for r in rows:
            saldo = float(r['entradas']) - float(r['saidas'])
            operacional = float(r['entradas']) - float(r['investimentos']) - float(r['internos'])
            meses.append({
                'mes': r['mes'],
                'entradas_total': fmt_brl(r['entradas']),
                'saidas_total': fmt_brl(r['saidas']),
                'saldo': fmt_brl(saldo),
                'entradas_operacionais': fmt_brl(operacional),
                'investimentos': fmt_brl(r['investimentos']),
                'internos': fmt_brl(r['internos']),
                'conciliados': r['conc_entradas'],
                'pendentes': r['pend_entradas'],
            })

        conn.close()
        return {
            'empresa': NOMES_EMPRESA.get(empresa, empresa),
            'periodo': mes or 'últimos 6 meses',
            'meses': meses,
            'resumo': f"{NOMES_EMPRESA.get(empresa, empresa)}: {len(meses)} meses retornados."
        }
    except Exception as e:
        conn.close()
        return {'erro': str(e)}


def status_contratos(empresa: Optional[str] = None) -> dict:
    """
    Resumo da saúde de todos os contratos ativos.
    Mostra valor mensal, total recebido, a receber, última NF, status.
    """
    resultado = {'contratos': [], 'total_mensal': 0, 'total_a_receber': 0}
    empresas_list = [empresa] if empresa else list(EMPRESAS_DB.keys())

    for emp in empresas_list:
        conn = montana_conn(emp)
        if not conn:
            continue
        try:
            contratos = conn.execute('''
                SELECT c.*,
                    COUNT(nf.id) as qtd_nfs,
                    COALESCE(SUM(CASE WHEN nf.status_conciliacao='CONCILIADO' THEN nf.valor_liquido END), 0) as recebido,
                    COALESCE(SUM(CASE WHEN nf.status_conciliacao='PENDENTE' THEN nf.valor_liquido END), 0) as pendente,
                    MAX(CASE WHEN nf.status_conciliacao='CONCILIADO' THEN nf.data_emissao END) as ultimo_pgto,
                    COUNT(CASE WHEN nf.status_conciliacao='PENDENTE' THEN 1 END) as nfs_pendentes
                FROM contratos c
                LEFT JOIN notas_fiscais nf ON nf.contrato_ref = c.numContrato
                    AND nf.data_emissao >= date('now', '-12 months')
                WHERE c.status = 'ATIVO'
                GROUP BY c.id
                ORDER BY c.orgao
            ''').fetchall()

            for c in contratos:
                c = dict(c)
                alerta = None
                if c['nfs_pendentes'] and c['nfs_pendentes'] > 3:
                    alerta = f"⚠️ {c['nfs_pendentes']} NFs pendentes"
                elif not c['ultimo_pgto']:
                    alerta = "⚠️ Nenhum pagamento registrado"

                resultado['contratos'].append({
                    'empresa': NOMES_EMPRESA[emp],
                    'contrato': c['numContrato'],
                    'orgao': c['orgao'],
                    'valor_mensal': fmt_brl(c['valor_mensal_bruto']),
                    'recebido_12m': fmt_brl(c['recebido']),
                    'pendente': fmt_brl(c['pendente']),
                    'nfs_pendentes': c['nfs_pendentes'],
                    'ultimo_pagamento': fmt_data(c['ultimo_pgto']),
                    'vigencia_fim': fmt_data(c['vigencia_fim']),
                    'alerta': alerta,
                })
                resultado['total_mensal'] += float(c['valor_mensal_bruto'] or 0)
                resultado['total_a_receber'] += float(c['pendente'] or 0)
        except Exception as e:
            pass
        finally:
            conn.close()

    resultado['total_mensal'] = fmt_brl(resultado['total_mensal'])
    resultado['total_a_receber'] = fmt_brl(resultado['total_a_receber'])
    resultado['resumo'] = (
        f"{len(resultado['contratos'])} contratos ativos. "
        f"Receita mensal total: {resultado['total_mensal']}. "
        f"Total a receber: {resultado['total_a_receber']}."
    )
    return resultado


def apuracao_fiscal(empresa: str, competencia: str) -> dict:
    """
    Apuração PIS/COFINS/ISS do período pelo regime de caixa.
    competencia: 'jan/26', 'fev/26', 'mar/26', 'abr/26', etc.
    """
    conn = montana_conn(empresa)
    if not conn:
        return {'erro': f'Empresa "{empresa}" não encontrada'}

    COMP_MAP = {
        'dez/25': '2025-12', 'jan/26': '2026-01', 'fev/26': '2026-02',
        'mar/26': '2026-03', 'abr/26': '2026-04', 'mai/26': '2026-05',
        'jun/26': '2026-06', 'jul/26': '2026-07', 'ago/26': '2026-08',
        'set/26': '2026-09', 'out/26': '2026-10', 'nov/26': '2026-11',
        'dez/26': '2026-12',
    }

    comp_lower = competencia.lower().strip()
    comp_iso   = COMP_MAP.get(comp_lower, comp_lower)
    comp_variants = [k for k, v in COMP_MAP.items() if v == comp_iso] + [comp_iso, competencia]

    try:
        placeholders = ','.join('?' * len(comp_variants))
        nfs = conn.execute(f'''
            SELECT numero, tomador, valor_bruto, valor_liquido, inss, ir, iss, pis, cofins, contrato_ref
            FROM notas_fiscais
            WHERE status_conciliacao = 'CONCILIADO'
              AND competencia IN ({placeholders})
        ''', comp_variants).fetchall()

        total_liq    = sum(float(r['valor_liquido'] or 0) for r in nfs)
        total_bruto  = sum(float(r['valor_bruto'] or 0) for r in nfs)
        total_iss    = sum(float(r['iss'] or 0) for r in nfs)
        total_pis_ret = sum(float(r['pis'] or 0) for r in nfs)
        total_cof_ret = sum(float(r['cofins'] or 0) for r in nfs)

        pis_apurado   = total_liq * 0.0165
        cofins_apurado = total_liq * 0.076
        pis_pagar     = max(0, pis_apurado - total_pis_ret)
        cofins_pagar  = max(0, cofins_apurado - total_cof_ret)
        total_tributos = total_iss + pis_pagar + cofins_pagar

        conn.close()
        return {
            'empresa': NOMES_EMPRESA.get(empresa, empresa),
            'competencia': competencia,
            'regime': 'Caixa',
            'nfs_base': len(nfs),
            'valor_bruto': fmt_brl(total_bruto),
            'valor_liquido_base': fmt_brl(total_liq),
            'iss_5pct': fmt_brl(total_iss),
            'pis_apurado_165': fmt_brl(pis_apurado),
            'pis_retido_fonte': fmt_brl(total_pis_ret),
            'pis_a_pagar': fmt_brl(pis_pagar),
            'cofins_apurado_76': fmt_brl(cofins_apurado),
            'cofins_retido_fonte': fmt_brl(total_cof_ret),
            'cofins_a_pagar': fmt_brl(cofins_pagar),
            'total_tributos': fmt_brl(total_tributos),
            'resumo': (
                f"{NOMES_EMPRESA.get(empresa, empresa)} — {competencia}: "
                f"{len(nfs)} NFs conciliadas, base {fmt_brl(total_liq)}. "
                f"PIS a pagar: {fmt_brl(pis_pagar)}. "
                f"COFINS a pagar: {fmt_brl(cofins_pagar)}. "
                f"ISS: {fmt_brl(total_iss)}. "
                f"Total tributos: {fmt_brl(total_tributos)}."
            )
        }
    except Exception as e:
        conn.close()
        return {'erro': str(e)}


def buscar_nfs(
    tomador: Optional[str] = None,
    contrato: Optional[str] = None,
    status: Optional[str] = None,
    empresa: Optional[str] = None,
    periodo_inicio: Optional[str] = None,
    periodo_fim: Optional[str] = None,
    limite: int = 50
) -> dict:
    """
    Busca notas fiscais com filtros flexíveis.
    status: 'PENDENTE' | 'CONCILIADO' | 'CANCELADA'
    periodo_inicio/fim: 'YYYY-MM-DD'
    """
    empresas_list = [empresa] if empresa else list(EMPRESAS_DB.keys())
    todas_nfs = []

    for emp in empresas_list:
        conn = montana_conn(emp)
        if not conn:
            continue
        try:
            where = ['1=1']
            params = []
            if tomador:
                where.append('tomador LIKE ?')
                params.append(f'%{tomador}%')
            if contrato:
                where.append('contrato_ref = ?')
                params.append(contrato)
            if status:
                where.append('status_conciliacao = ?')
                params.append(status.upper())
            if periodo_inicio:
                where.append('data_emissao >= ?')
                params.append(periodo_inicio)
            if periodo_fim:
                where.append('data_emissao <= ?')
                params.append(periodo_fim)

            nfs = conn.execute(f'''
                SELECT numero, competencia, tomador, valor_bruto, valor_liquido,
                       status_conciliacao, contrato_ref, data_emissao
                FROM notas_fiscais
                WHERE {" AND ".join(where)}
                ORDER BY data_emissao DESC
                LIMIT {limite}
            ''', params).fetchall()

            for nf in nfs:
                todas_nfs.append({
                    'empresa': NOMES_EMPRESA[emp],
                    'numero': nf['numero'],
                    'competencia': nf['competencia'],
                    'tomador': (nf['tomador'] or '')[:50],
                    'valor_liquido': fmt_brl(nf['valor_liquido']),
                    'status': nf['status_conciliacao'],
                    'contrato': nf['contrato_ref'],
                    'emissao': fmt_data(nf['data_emissao']),
                })
        except Exception:
            pass
        finally:
            conn.close()

    total_valor = 0  # calculado separadamente se necessário
    return {
        'total_encontradas': len(todas_nfs),
        'nfs': todas_nfs,
        'filtros_usados': {
            'tomador': tomador, 'contrato': contrato,
            'status': status, 'empresa': empresa,
        },
        'resumo': f"{len(todas_nfs)} NFs encontradas com os filtros informados."
    }


def buscar_conhecimento(termo: str, empresa: Optional[str] = None, categoria: Optional[str] = None, limite: int = 10) -> dict:
    """
    Pesquisa no banco de conhecimento por texto livre.
    Retorna os chunks mais relevantes que contêm o termo.
    categoria: 'contrato' | 'nf' | 'funcionario' | 'despesa' | 'extrato_mensal' | 'sumario'
    """
    kb = kb_conn()
    if not kb:
        return {
            'aviso': 'Banco de conhecimento não encontrado. Execute python3 etl.py para gerar.',
            'resultados': []
        }

    try:
        where = ["conteudo LIKE ?"]
        params = [f'%{termo}%']
        if empresa:
            where.append("empresa = ?")
            params.append(empresa)
        if categoria:
            where.append("categoria = ?")
            params.append(categoria)

        rows = kb.execute(f'''
            SELECT empresa, categoria, referencia, conteudo, data_ref
            FROM knowledge_chunks
            WHERE {" AND ".join(where)}
            ORDER BY data_ref DESC
            LIMIT {limite}
        ''', params).fetchall()

        kb.close()
        return {
            'total': len(rows),
            'resultados': [
                {
                    'empresa': NOMES_EMPRESA.get(r['empresa'], r['empresa']),
                    'categoria': r['categoria'],
                    'referencia': r['referencia'],
                    'texto': r['conteudo'],
                    'data': fmt_data(r['data_ref']),
                }
                for r in rows
            ],
            'resumo': f"{len(rows)} resultado(s) para '{termo}'."
        }
    except Exception as e:
        return {'erro': str(e), 'resultados': []}


def alerta_vencimentos(dias: int = 30) -> dict:
    """
    Lista contratos vencendo nos próximos X dias, certidões a vencer, e NFs atrasadas.
    """
    data_limite = (date.today() + timedelta(days=dias)).isoformat()
    alertas = []

    for emp, db_path in EMPRESAS_DB.items():
        conn = montana_conn(emp)
        if not conn:
            continue
        try:
            # Contratos vencendo
            vencendo = conn.execute('''
                SELECT numContrato, orgao, vigencia_fim, valor_mensal_bruto
                FROM contratos
                WHERE status = 'ATIVO'
                  AND vigencia_fim <= ?
                  AND vigencia_fim >= date('now')
                ORDER BY vigencia_fim
            ''', (data_limite,)).fetchall()

            for c in vencendo:
                dias_restantes = (
                    datetime.strptime(str(c['vigencia_fim'])[:10], '%Y-%m-%d').date() - date.today()
                ).days
                alertas.append({
                    'tipo': '🔴 CONTRATO VENCENDO',
                    'empresa': NOMES_EMPRESA[emp],
                    'descricao': f"Contrato {c['numContrato']} com {c['orgao']}",
                    'data': fmt_data(c['vigencia_fim']),
                    'dias_restantes': dias_restantes,
                    'valor_mensal': fmt_brl(c['valor_mensal_bruto']),
                })

            # Certidões vencendo
            try:
                certidoes = conn.execute('''
                    SELECT tipo, numero, data_validade
                    FROM certidoes
                    WHERE status = 'VALIDA'
                      AND data_validade <= ?
                      AND data_validade >= date('now')
                    ORDER BY data_validade
                ''', (data_limite,)).fetchall()

                for cert in certidoes:
                    dias_restantes = (
                        datetime.strptime(str(cert['data_validade'])[:10], '%Y-%m-%d').date() - date.today()
                    ).days
                    alertas.append({
                        'tipo': '🟡 CERTIDÃO VENCENDO',
                        'empresa': NOMES_EMPRESA[emp],
                        'descricao': f"Certidão {cert['tipo']} nº {cert['numero']}",
                        'data': fmt_data(cert['data_validade']),
                        'dias_restantes': dias_restantes,
                    })
            except Exception:
                pass

        except Exception:
            pass
        finally:
            conn.close()

    alertas.sort(key=lambda x: x.get('dias_restantes', 9999))
    return {
        'total_alertas': len(alertas),
        'periodo_dias': dias,
        'alertas': alertas,
        'resumo': (
            f"{len(alertas)} item(ns) requerem atenção nos próximos {dias} dias."
            if alertas else
            f"Nenhum vencimento nos próximos {dias} dias. Tudo em ordem!"
        )
    }


def funcionarios_contrato(contrato: str, empresa: Optional[str] = None) -> dict:
    """
    Lista funcionários alocados a um contrato específico com custos.
    """
    empresas_list = [empresa] if empresa else list(EMPRESAS_DB.keys())
    resultado = {'funcionarios': [], 'total_salarios': 0}

    for emp in empresas_list:
        conn = montana_conn(emp)
        if not conn:
            continue
        try:
            funcs = conn.execute('''
                SELECT f.nome, f.data_admissao, f.lotacao, f.contrato_ref,
                       f.salario_base, f.status, c.nome as cargo_nome
                FROM rh_funcionarios f
                LEFT JOIN rh_cargos c ON f.cargo_id = c.id
                WHERE (f.contrato_ref = ? OR f.lotacao LIKE ?)
                  AND f.status = 'ATIVO'
                ORDER BY f.nome
            ''', (contrato, f'%{contrato}%')).fetchall()

            for f in funcs:
                resultado['funcionarios'].append({
                    'empresa': NOMES_EMPRESA[emp],
                    'nome': f['nome'],
                    'cargo': f['cargo_nome'] or 'não informado',
                    'lotacao': f['lotacao'],
                    'admissao': fmt_data(f['data_admissao']),
                    'salario': fmt_brl(f['salario_base']),
                })
                resultado['total_salarios'] += float(f['salario_base'] or 0)
        except Exception:
            pass
        finally:
            conn.close()

    resultado['total_salarios'] = fmt_brl(resultado['total_salarios'])
    resultado['resumo'] = (
        f"{len(resultado['funcionarios'])} funcionários no contrato {contrato}. "
        f"Folha salarial: {resultado['total_salarios']}."
    )
    return resultado


# ─── Modo stdio (MCP nativo para Claude Desktop) ─────────────────────────────

TOOLS = {
    "pendencias_financeiras": {
        "fn": pendencias_financeiras,
        "description": "Retorna NFs pendentes de pagamento e créditos bancários não identificados por empresa.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "empresa": {
                    "type": "string",
                    "enum": ["assessoria", "seguranca", "mustang", "portodovau"],
                    "description": "Empresa a consultar (omita para todas)"
                },
                "contrato": {"type": "string", "description": "Filtrar por contrato específico"}
            }
        }
    },
    "fluxo_caixa": {
        "fn": fluxo_caixa,
        "description": "Entradas, saídas e saldo bancário de uma empresa por período.",
        "inputSchema": {
            "type": "object",
            "required": ["empresa"],
            "properties": {
                "empresa": {"type": "string", "enum": ["assessoria", "seguranca", "mustang", "portodovau"]},
                "mes": {"type": "string", "description": "Mês: JAN, FEV, MAR, ABR... (omita para últimos 6 meses)"},
                "ano": {"type": "integer", "description": "Ano (padrão: 2026)"}
            }
        }
    },
    "status_contratos": {
        "fn": status_contratos,
        "description": "Resumo da saúde de todos os contratos ativos: valor mensal, recebido, pendente, alertas.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "empresa": {"type": "string", "enum": ["assessoria", "seguranca", "mustang", "portodovau"],
                            "description": "Empresa (omita para todas)"}
            }
        }
    },
    "apuracao_fiscal": {
        "fn": apuracao_fiscal,
        "description": "Apuração PIS/COFINS/ISS pelo regime de caixa para uma competência.",
        "inputSchema": {
            "type": "object",
            "required": ["empresa", "competencia"],
            "properties": {
                "empresa": {"type": "string", "enum": ["assessoria", "seguranca", "mustang", "portodovau"]},
                "competencia": {"type": "string", "description": "Ex: jan/26, fev/26, mar/26, abr/26"}
            }
        }
    },
    "buscar_nfs": {
        "fn": buscar_nfs,
        "description": "Busca notas fiscais com filtros: tomador, contrato, status, empresa, período.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tomador": {"type": "string", "description": "Parte do nome do tomador (ex: UFT, SESAU, DETRAN)"},
                "contrato": {"type": "string", "description": "Código exato do contrato (ex: UFT 16/2025)"},
                "status": {"type": "string", "enum": ["PENDENTE", "CONCILIADO", "CANCELADA"]},
                "empresa": {"type": "string", "enum": ["assessoria", "seguranca", "mustang", "portodovau"]},
                "periodo_inicio": {"type": "string", "description": "YYYY-MM-DD"},
                "periodo_fim":    {"type": "string", "description": "YYYY-MM-DD"},
                "limite": {"type": "integer", "default": 50}
            }
        }
    },
    "buscar_conhecimento": {
        "fn": buscar_conhecimento,
        "description": "Pesquisa no banco de conhecimento por texto livre. Retorna contratos, NFs, funcionários etc.",
        "inputSchema": {
            "type": "object",
            "required": ["termo"],
            "properties": {
                "termo": {"type": "string", "description": "Texto a pesquisar"},
                "empresa": {"type": "string", "enum": ["assessoria", "seguranca", "mustang", "portodovau"]},
                "categoria": {"type": "string", "enum": ["contrato", "nf", "funcionario", "despesa", "extrato_mensal", "sumario"]},
                "limite": {"type": "integer", "default": 10}
            }
        }
    },
    "alerta_vencimentos": {
        "fn": alerta_vencimentos,
        "description": "Lista contratos e certidões vencendo nos próximos X dias.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "dias": {"type": "integer", "default": 30, "description": "Dias à frente (padrão 30)"}
            }
        }
    },
    "funcionarios_contrato": {
        "fn": funcionarios_contrato,
        "description": "Lista funcionários alocados a um contrato com folha salarial.",
        "inputSchema": {
            "type": "object",
            "required": ["contrato"],
            "properties": {
                "contrato": {"type": "string", "description": "Código do contrato (ex: SESAU 178/2022)"},
                "empresa": {"type": "string", "enum": ["assessoria", "seguranca", "mustang", "portodovau"]}
            }
        }
    },
}


def run_stdio():
    """Modo MCP stdio — para Claude Desktop / Claude Code."""
    import sys

    def send(obj):
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        method  = req.get('method', '')
        req_id  = req.get('id')
        params  = req.get('params', {})

        if method == 'initialize':
            send({
                'jsonrpc': '2.0', 'id': req_id,
                'result': {
                    'protocolVersion': '2024-11-05',
                    'serverInfo': {'name': 'montana-intelligence', 'version': '1.0.0'},
                    'capabilities': {'tools': {}}
                }
            })

        elif method == 'tools/list':
            tools_list = [
                {
                    'name': name,
                    'description': info['description'],
                    'inputSchema': info['inputSchema']
                }
                for name, info in TOOLS.items()
            ]
            send({'jsonrpc': '2.0', 'id': req_id, 'result': {'tools': tools_list}})

        elif method == 'tools/call':
            tool_name = params.get('name')
            args      = params.get('arguments', {})

            if tool_name not in TOOLS:
                send({'jsonrpc': '2.0', 'id': req_id,
                      'error': {'code': -32601, 'message': f'Ferramenta "{tool_name}" não encontrada'}})
                continue

            try:
                result = TOOLS[tool_name]['fn'](**args)
                send({
                    'jsonrpc': '2.0', 'id': req_id,
                    'result': {
                        'content': [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False, indent=2)}]
                    }
                })
            except Exception as e:
                send({
                    'jsonrpc': '2.0', 'id': req_id,
                    'result': {
                        'content': [{'type': 'text', 'text': json.dumps({'erro': str(e)}, ensure_ascii=False)}]
                    }
                })

        elif method == 'notifications/initialized':
            pass  # Ignorar

        else:
            send({'jsonrpc': '2.0', 'id': req_id,
                  'error': {'code': -32601, 'message': f'Método "{method}" desconhecido'}})


def run_http(port: int = 8001):
    """Modo HTTP/REST — para acesso via WebFetch."""
    try:
        from fastapi import FastAPI, HTTPException, Depends, Header
        from fastapi.middleware.cors import CORSMiddleware
        import uvicorn
        from pydantic import BaseModel
        from typing import Any
    except ImportError:
        print("Instalando dependências HTTP...")
        os.system("pip3 install fastapi uvicorn pydantic --break-system-packages -q")
        from fastapi import FastAPI, HTTPException, Depends, Header
        import uvicorn

    app = FastAPI(title="Montana Intelligence API", version="1.0.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    async def verificar_token(x_token: str = Header(default=None)):
        if x_token != TOKEN and TOKEN != 'montana2026':
            raise HTTPException(status_code=401, detail="Token inválido")

    @app.get("/")
    def raiz():
        return {
            "servico": "Montana Intelligence",
            "status": "online",
            "ferramentas": list(TOOLS.keys()),
            "horario": datetime.now().isoformat()
        }

    @app.get("/saude")
    def saude():
        return {"status": "ok", "kb_existe": os.path.exists(KB_PATH)}

    @app.get("/pendencias")
    def api_pendencias(empresa: Optional[str] = None, contrato: Optional[str] = None):
        return pendencias_financeiras(empresa, contrato)

    @app.get("/fluxo")
    def api_fluxo(empresa: str, mes: Optional[str] = None, ano: Optional[int] = None):
        return fluxo_caixa(empresa, mes, ano)

    @app.get("/contratos")
    def api_contratos(empresa: Optional[str] = None):
        return status_contratos(empresa)

    @app.get("/fiscal")
    def api_fiscal(empresa: str, competencia: str):
        return apuracao_fiscal(empresa, competencia)

    @app.get("/nfs")
    def api_nfs(tomador: Optional[str] = None, contrato: Optional[str] = None,
                status: Optional[str] = None, empresa: Optional[str] = None,
                inicio: Optional[str] = None, fim: Optional[str] = None):
        return buscar_nfs(tomador, contrato, status, empresa, inicio, fim)

    @app.get("/buscar")
    def api_buscar(q: str, empresa: Optional[str] = None, categoria: Optional[str] = None):
        return buscar_conhecimento(q, empresa, categoria)

    @app.get("/alertas")
    def api_alertas(dias: int = 30):
        return alerta_vencimentos(dias)

    @app.get("/funcionarios")
    def api_funcionarios(contrato: str, empresa: Optional[str] = None):
        return funcionarios_contrato(contrato, empresa)

    print(f"\n🚀 Montana Intelligence rodando em http://0.0.0.0:{port}")
    print(f"   Docs: http://0.0.0.0:{port}/docs")
    print(f"   Saúde: http://104.196.22.170:{port}/saude\n")
    uvicorn.run(app, host="0.0.0.0", port=port)


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Montana Intelligence Server')
    parser.add_argument('--stdio', action='store_true', help='Modo MCP stdio (Claude Desktop)')
    parser.add_argument('--port', type=int, default=8001, help='Porta HTTP (padrão 8001)')
    args = parser.parse_args()

    if args.stdio:
        run_stdio()
    else:
        run_http(args.port)
