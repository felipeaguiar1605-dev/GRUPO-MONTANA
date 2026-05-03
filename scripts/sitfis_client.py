#!/usr/bin/env python3
"""
Cliente SITFIS — emite Relatório de Situação Fiscal da RFB/PGFN.
Fluxo: POST /apoio → recebe protocolo → POST /emitir → recebe PDF base64.
"""
import os, sys, time, base64, json, tempfile, subprocess
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

CERTS_DIR = '/opt/montana/app_unificado/certificados'
OUT_DIR = '/opt/montana/app_unificado/output/sitfis'
os.makedirs(OUT_DIR, exist_ok=True)

EMPRESAS = {
    'assessoria': {'pfx': 'assessoria.pfx', 'pass': '14092519', 'cnpj': '14092519000151', 'nome': 'MONTANA ASSESSORIA'},
    'seguranca':  {'pfx': 'seguranca.pfx',  'pass': '19200109', 'cnpj': '19200109000109', 'nome': 'MONTANA SEGURANCA'},
    'portodovau': {'pfx': 'portodovau.pfx', 'pass': 'Control5060', 'cnpj': '41034574000168', 'nome': 'PORTO DO VAU'},
}

BASE = 'https://cav.receita.fazenda.gov.br/Sitfis/rest'

def pfx_to_pem(pfx_path, password):
    """Converte .pfx (legacy) em cert.pem e key.pem temporários."""
    td = tempfile.mkdtemp(prefix='sitfis_')
    cert = os.path.join(td, 'cert.pem')
    key  = os.path.join(td, 'key.pem')
    # cert
    subprocess.check_call(['openssl','pkcs12','-legacy','-in', pfx_path,
                           '-passin', f'pass:{password}','-nokeys','-out', cert],
                          stderr=subprocess.DEVNULL)
    # key (sem senha)
    subprocess.check_call(['openssl','pkcs12','-legacy','-in', pfx_path,
                           '-passin', f'pass:{password}','-nocerts','-nodes','-out', key],
                          stderr=subprocess.DEVNULL)
    return cert, key, td

def emitir(empresa_key):
    e = EMPRESAS[empresa_key]
    pfx = os.path.join(CERTS_DIR, e['pfx'])
    cert_pem, key_pem, td = pfx_to_pem(pfx, e['pass'])
    print(f'[{empresa_key}] cert carregado ({e["cnpj"]})', flush=True)

    s = requests.Session()
    s.verify = "/etc/montana/ca_bundle.pem"
    s.cert = (cert_pem, key_pem)
    s.headers.update({
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 SITFIS-Client',
    })

    # Passo 1: solicita protocolo
    url1 = f'{BASE}/apoio'
    r1 = s.post(url1, timeout=60)
    print(f'[{empresa_key}] apoio status={r1.status_code}', flush=True)
    if r1.status_code != 200:
        print(f'  body: {r1.text[:500]}', flush=True)
        return None
    j1 = r1.json()
    protocolo = j1.get('protocoloRelatorio') or j1.get('protocolo')
    tempo_espera = j1.get('tempoEspera', 0)
    if not protocolo:
        print(f'  sem protocolo: {j1}', flush=True)
        return None
    print(f'[{empresa_key}] protocolo={protocolo[:40]}... espera={tempo_espera}ms', flush=True)

    # Aguarda o tempo indicado pelo servidor (se houver)
    if tempo_espera > 0:
        time.sleep(tempo_espera / 1000 + 1)

    # Passo 2: emite relatório
    url2 = f'{BASE}/emitir'
    r2 = s.post(url2, json={'protocoloRelatorio': protocolo}, timeout=120)
    print(f'[{empresa_key}] emitir status={r2.status_code}', flush=True)
    if r2.status_code != 200:
        print(f'  body: {r2.text[:500]}', flush=True)
        return None
    j2 = r2.json()
    pdf_b64 = j2.get('dados') or j2.get('pdf') or j2.get('relatorio')
    if not pdf_b64:
        print(f'  sem pdf: {json.dumps(j2)[:300]}', flush=True)
        return None
    pdf_bytes = base64.b64decode(pdf_b64)
    out_path = os.path.join(OUT_DIR, f'sitfis_{empresa_key}_{time.strftime("%Y%m%d")}.pdf')
    with open(out_path, 'wb') as f:
        f.write(pdf_bytes)
    print(f'[{empresa_key}] PDF salvo: {out_path} ({len(pdf_bytes)} bytes)', flush=True)
    return out_path

if __name__ == '__main__':
    alvo = sys.argv[1] if len(sys.argv) > 1 else 'assessoria'
    if alvo == 'todas':
        for k in EMPRESAS:
            try: emitir(k)
            except Exception as ex: print(f'ERRO {k}: {ex}')
            time.sleep(2)
    else:
        emitir(alvo)
