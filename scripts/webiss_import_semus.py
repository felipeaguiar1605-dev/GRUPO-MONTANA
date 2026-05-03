#!/usr/bin/env python3
"""
Montana ERP — Importação WebISS (NFS-e Palmas-TO) — Script standalone
Executa direto no servidor: python3 scripts/webiss_import_semus.py

Importa NFS-e de AMBAS as empresas para o banco local SQLite.
Foca especialmente em NFs para SEMUS (CNPJ 24.851.511/xxxx).

Requisitos: Python 3.8+ (sem dependências externas)
"""

import http.client
import ssl
import sqlite3
import re
import time
import os
import sys
from datetime import datetime, date

# ─── Configuração ─────────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EMPRESAS = {
    'seguranca': {
        'cnpj':     '19200109000109',
        'insc':     '515161',
        'db_path':  os.path.join(BASE_DIR, 'data', 'seguranca', 'montana.db'),
        'pfx_path': os.path.join(BASE_DIR, 'certificados', 'seguranca.pfx'),
        'pfx_senha': os.environ.get('WEBISS_CERT_SENHA_SEGURANCA', '19200109'),
    },
    'assessoria': {
        'cnpj':     '14092519000151',
        'insc':     '237319',
        'db_path':  os.path.join(BASE_DIR, 'data', 'assessoria', 'montana.db'),
        'pfx_path': os.path.join(BASE_DIR, 'certificados', 'assessoria.pfx'),
        'pfx_senha': os.environ.get('WEBISS_CERT_SENHA_ASSESSORIA', '14092519'),
    },
}

WEBISS_HOST = 'palmasto.webiss.com.br'
WEBISS_PATH = '/ws/nfse.asmx'
ABRASF_NS   = 'http://www.abrasf.org.br/nfse.xsd'

DATA_INICIAL = '2025-01-01'   # Busca 2025 e 2026 para pegar SEMUS contrato 192/2025
DATA_FINAL   = date.today().isoformat()

# ─── SOAP helpers ─────────────────────────────────────────────────────────────

CABEC_XML = f'<cabecalho versao="2.02" xmlns="{ABRASF_NS}"><versaoDados>2.02</versaoDados></cabecalho>'

def build_envelope(operation, dados_xml):
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
        '<soap:Body>'
        f'<{operation}Request xmlns="http://nfse.abrasf.org.br">'
        f'<nfseCabecMsg xmlns=""><![CDATA[{CABEC_XML}]]></nfseCabecMsg>'
        f'<nfseDadosMsg xmlns=""><![CDATA[{dados_xml}]]></nfseDadosMsg>'
        f'</{operation}Request>'
        '</soap:Body>'
        '</soap:Envelope>'
    )

def build_consulta_xml(cnpj, insc, data_ini, data_fim, pagina):
    return (
        f'<ConsultarNfseServicoPrestadoEnvio xmlns="{ABRASF_NS}">'
        f'<Prestador>'
        f'<CpfCnpj><Cnpj>{cnpj}</Cnpj></CpfCnpj>'
        f'<InscricaoMunicipal>{insc}</InscricaoMunicipal>'
        f'</Prestador>'
        f'<PeriodoEmissao>'
        f'<DataInicial>{data_ini}</DataInicial>'
        f'<DataFinal>{data_fim}</DataFinal>'
        f'</PeriodoEmissao>'
        f'<Pagina>{pagina}</Pagina>'
        '</ConsultarNfseServicoPrestadoEnvio>'
    )

def soap_call(operation, dados_xml, pfx_path=None, pfx_senha=None, timeout=45):
    body = build_envelope(operation, dados_xml).encode('utf-8')
    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': f'"http://nfse.abrasf.org.br/{operation}"',
        'Content-Length': str(len(body)),
    }

    # Tenta com mTLS (certificado A1) se disponível
    ctx = ssl.create_default_context()
    if pfx_path and os.path.exists(pfx_path) and pfx_senha:
        try:
            ctx.load_cert_chain(pfx_path, password=pfx_senha)
            print(f'  [mTLS] Usando certificado: {pfx_path}')
        except Exception as e:
            print(f'  [mTLS] Aviso — não carregou cert ({e}), tentando sem mTLS')

    conn = http.client.HTTPSConnection(WEBISS_HOST, 443, context=ctx, timeout=timeout)
    try:
        conn.request('POST', WEBISS_PATH, body=body, headers=headers)
        resp = conn.getresponse()
        text = resp.read().decode('utf-8', errors='replace')
        if resp.status >= 400:
            raise RuntimeError(f'HTTP {resp.status}: {text[:300]}')
        return text
    finally:
        conn.close()

def extract_output(soap_resp):
    m = re.search(r'<outputXML[^>]*>([\s\S]*?)</outputXML>', soap_resp)
    if not m:
        return soap_resp
    return (m.group(1)
            .replace('&lt;', '<')
            .replace('&gt;', '>')
            .replace('&amp;', '&')
            .replace('&quot;', '"'))

def get_tag(xml, tag):
    m = re.search(rf'<{tag}(?:\s[^>]*)?>([^<]*)</{tag}>', xml)
    return m.group(1).strip() if m else ''

def parse_nfses(xml):
    results = []
    for m in re.finditer(r'<CompNfse>([\s\S]*?)</CompNfse>', xml):
        b = m.group(1)
        tom_block = re.search(r'<Tomador>([\s\S]*?)</Tomador>', b)
        tom = tom_block.group(1) if tom_block else ''
        cancel = bool(re.search(r'<NfseCancelamento>', b))

        cnpj_tom = get_tag(tom, 'Cnpj') or get_tag(tom, 'Cpf')
        # Formata CNPJ: 24851511000185 → 24.851.511/0001-85
        if cnpj_tom and len(cnpj_tom) == 14 and cnpj_tom.isdigit():
            c = cnpj_tom
            cnpj_tom = f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}'

        numero = get_tag(b, 'Numero')
        competencia = get_tag(b, 'Competencia')[:7] if get_tag(b, 'Competencia') else ''
        data_emissao = get_tag(b, 'DataEmissao')[:10] if get_tag(b, 'DataEmissao') else ''

        results.append({
            'numero':        numero,
            'competencia':   competencia,
            'data_emissao':  data_emissao,
            'valor_bruto':   float(get_tag(b, 'ValorServicos') or 0),
            'valor_liquido': float(get_tag(b, 'ValorLiquidoNfse') or 0),
            'valor_iss':     float(get_tag(b, 'ValorIss') or 0),
            'valor_ir':      float(get_tag(b, 'ValorIr') or 0),
            'valor_csll':    float(get_tag(b, 'ValorCsll') or 0),
            'valor_pis':     float(get_tag(b, 'ValorPis') or 0),
            'valor_cofins':  float(get_tag(b, 'ValorCofins') or 0),
            'valor_inss':    float(get_tag(b, 'ValorInss') or 0),
            'tomador':       get_tag(tom, 'RazaoSocial') or get_tag(tom, 'NomeFantasia'),
            'cnpj_tomador':  cnpj_tom,
            'discriminacao': get_tag(b, 'Discriminacao'),
            'cancelada':     cancel,
        })
    return results

# ─── Banco de dados ────────────────────────────────────────────────────────────

def get_db(db_path):
    conn = sqlite3.connect(db_path)
    # Garante colunas extras
    for col_def in [
        'webiss_numero_nfse TEXT',
        'discriminacao TEXT',
        'data_pagamento TEXT DEFAULT ""',
        'extrato_id INTEGER DEFAULT NULL',
    ]:
        col = col_def.split()[0]
        try:
            conn.execute(f'ALTER TABLE notas_fiscais ADD COLUMN {col_def}')
        except Exception:
            pass
    conn.commit()
    return conn

def import_nfses(db_conn, nfses):
    sql = '''
        INSERT OR IGNORE INTO notas_fiscais
          (numero, competencia, cidade, tomador, cnpj_tomador,
           valor_bruto, valor_liquido,
           inss, ir, iss, csll, pis, cofins, retencao,
           data_emissao, status_conciliacao,
           webiss_numero_nfse, discriminacao)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    '''
    imported = 0
    skipped  = 0
    for nf in nfses:
        retencao = (nf['valor_inss'] + nf['valor_ir'] + nf['valor_iss'] +
                    nf['valor_csll'] + nf['valor_pis'] + nf['valor_cofins'])
        r = db_conn.execute(sql, (
            nf['numero'],
            nf['competencia'],
            'Palmas/TO',
            nf['tomador'],
            nf['cnpj_tomador'],
            nf['valor_bruto'],
            nf['valor_liquido'],
            nf['valor_inss'],
            nf['valor_ir'],
            nf['valor_iss'],
            nf['valor_csll'],
            nf['valor_pis'],
            nf['valor_cofins'],
            retencao,
            nf['data_emissao'],
            'CANCELADA' if nf['cancelada'] else 'PENDENTE',
            nf['numero'],
            nf['discriminacao'],
        ))
        if r.rowcount:
            imported += 1
        else:
            skipped += 1
    db_conn.commit()
    return imported, skipped

# ─── Main ──────────────────────────────────────────────────────────────────────

def processar_empresa(key, cfg, data_ini, data_fim):
    print(f'\n{"="*60}')
    print(f'EMPRESA: {key.upper()}')
    print(f'CNPJ: {cfg["cnpj"]}  |  Inscrição: {cfg["insc"]}')
    print(f'Período: {data_ini} → {data_fim}')
    print(f'{"="*60}')

    if not os.path.exists(cfg['db_path']):
        print(f'ERRO: banco não encontrado: {cfg["db_path"]}')
        return

    all_nfses = []
    seen_nums = set()

    for pagina in range(1, 51):
        if pagina > 1:
            print(f'  Aguardando 2.5s entre páginas...')
            time.sleep(2.5)

        print(f'  Consultando página {pagina}...', end=' ', flush=True)
        dados_xml = build_consulta_xml(cfg['cnpj'], cfg['insc'], data_ini, data_fim, pagina)

        try:
            soap_resp = soap_call(
                'ConsultarNfseServicoPrestado',
                dados_xml,
                pfx_path=cfg.get('pfx_path'),
                pfx_senha=cfg.get('pfx_senha'),
            )
        except Exception as e:
            print(f'ERRO: {e}')
            break

        xml = extract_output(soap_resp)

        # Verifica erros ABRASF
        erros = re.findall(r'<Mensagem>([^<]+)</Mensagem>', xml)
        if erros:
            print(f'ERRO ABRASF: {erros}')
            break

        page_nfs = parse_nfses(xml)
        if not page_nfs:
            print(f'sem NFs — fim da consulta')
            break

        # WebISS repete a última NF quando não há mais páginas
        if all(nf['numero'] in seen_nums for nf in page_nfs):
            print(f'página repetida — fim da consulta')
            break

        novos = [nf for nf in page_nfs if nf['numero'] not in seen_nums]
        for nf in novos:
            seen_nums.add(nf['numero'])
        all_nfses.extend(novos)
        print(f'{len(novos)} NFs (total até agora: {len(all_nfses)})')

    print(f'\n  Total consultado: {len(all_nfses)} NFs')

    if not all_nfses:
        print('  Nada para importar.')
        return

    # ─── Importa ──────────────────────────────────────────────────────────────
    db = get_db(cfg['db_path'])
    imported, skipped = import_nfses(db, all_nfses)
    print(f'  Importadas: {imported} | Já existiam (ignoradas): {skipped}')

    # ─── Relatório SEMUS ──────────────────────────────────────────────────────
    semus_nfs = [
        nf for nf in all_nfses
        if nf['cnpj_tomador'].startswith('24.851.511')
    ]
    if semus_nfs:
        total_semus = sum(nf['valor_bruto'] for nf in semus_nfs)
        print(f'\n  *** NFs SEMUS (MUNICIPIO DE PALMAS) ***')
        print(f'  Total: {len(semus_nfs)} NFs | R${total_semus:,.2f}')
        for nf in sorted(semus_nfs, key=lambda x: x['data_emissao']):
            print(f'    NF {nf["numero"]} | {nf["data_emissao"]} | CNPJ {nf["cnpj_tomador"]} | R${nf["valor_bruto"]:,.2f}')
    else:
        print('  Nenhuma NF para Municipio de Palmas no período consultado.')

    # ─── Status conciliação SEMUS ─────────────────────────────────────────────
    cur = db.cursor()
    cur.execute("""
        SELECT COUNT(*), SUM(valor_pago)
        FROM pref_pagamentos
        WHERE gestao_codigo='3200' AND status_conciliacao='PENDENTE'
    """)
    row = cur.fetchone()
    if row and row[0]:
        print(f'\n  SEMUS pref_pagamentos PENDENTES: {row[0]} OBs | R${row[1]:,.2f}')

    db.close()

def main():
    # Permite filtrar empresa via argumento: python3 script.py seguranca
    filtro = sys.argv[1].lower() if len(sys.argv) > 1 else 'ambas'

    # Período: default 2025-01-01 até hoje
    data_ini = sys.argv[2] if len(sys.argv) > 2 else DATA_INICIAL
    data_fim = sys.argv[3] if len(sys.argv) > 3 else DATA_FINAL

    print(f'Montana ERP — WebISS Import  [{datetime.now():%Y-%m-%d %H:%M:%S}]')
    print(f'Período: {data_ini} → {data_fim}')

    for key, cfg in EMPRESAS.items():
        if filtro not in ('ambas', key):
            continue
        processar_empresa(key, cfg, data_ini, data_fim)

    print('\n\nConcluído.')

if __name__ == '__main__':
    main()
