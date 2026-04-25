#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parser estruturado das Ordens Bancárias SIAFE-TO (SEDUC) — Grupo Montana.

Extrai de cada bloco de OB:
  • numero_ob       (2025OB032234)
  • tipo_doc        ("Ordem Bancária Orçamentária" ou "Ordem Bancária de Retenção")
  • tipo_codigo     (32 = pagamento / 38 = retenção)
  • emissao         (DD/MM/YY)
  • valor           (float)
  • credor_cnpj     (14 dígitos)
  • credor_nome     (MONTANA ASSESSORIA ... / MONTANA SEGURANÇA ...)
  • empenho_ne      (2025NE012683)
  • nota_liq_nl     (2025NL025012)
  • contrato_siafe  (23000434)
  • competencia     (MM/AAAA)
  • nfs             (lista de NFs formato 15 dígitos)
  • tipo_retencao   (INSS, IRRF, ISS, etc. — só quando tipo_codigo=38)
  • status_envio    (Processado e Pago, etc.)
  • destino_banco   (001 - 1505 - 1090437 - CONTA TJTO ATUAL)
  • observacao
"""
import os, re, json, glob, sys, io
import pdfplumber

# Forçar UTF-8 no stdout (para caracteres gráficos)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

SRC = r"C:\Users\Avell\OneDrive\Área de Trabalho\Montana_Seg_Conciliacao\app_unificado\tmp_ob_seduc"
OUT_TXT  = os.path.join(SRC, '_texto_extraido.txt')
OUT_JSON = os.path.join(SRC, '_obs_parseadas.json')
OUT_CSV  = os.path.join(SRC, '_obs_parseadas.csv')

CNPJ_ASSESSORIA = '14092519000151'
CNPJ_SEGURANCA  = '19200109000109'

def extrair_texto(path):
    txt_pages = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            t = page.extract_text() or ''
            txt_pages.append(t)
    return '\n'.join(txt_pages)

def parse_valor(s):
    # "1.234.567,89" → 1234567.89
    s = s.replace('.', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None

def parse_bloco(bloco):
    """Parse um bloco de texto de uma única OB."""
    out = {}

    # Tipo doc ("Orçamentária" = pagamento | "Retenção" = OB de retenção)
    m = re.search(r'Ordem Bancária\s+(Orçamentária|de\s+Retenção)', bloco)
    out['tipo_doc'] = m.group(1) if m else None

    # TIPO codificado: TIPO 32, TIPO 38
    m = re.search(r'TIPO\s+(\d{1,3})', bloco)
    out['tipo_codigo'] = int(m.group(1)) if m else None

    # Documento + Emissão: "2025OB032234 07/05/25"
    m = re.search(r'(\d{4}OB\d{5,6})\s+(\d{2}/\d{2}/\d{2,4})', bloco)
    if m:
        out['numero_ob'] = m.group(1)
        out['emissao']   = m.group(2)

    # Valor por Extenso ... (número com vírgula/ponto, 2 decimais)
    m = re.search(r'Valor por Extenso\s+Valor\s*\n([^\n]+?)\s+([\d\.]+,\d{2})', bloco)
    if m:
        out['valor_extenso'] = m.group(1).strip()
        out['valor'] = parse_valor(m.group(2))
    else:
        # fallback: primeiro valor monetário grande
        m = re.search(r'(\d{1,3}(?:\.\d{3})*,\d{2})', bloco)
        if m:
            out['valor'] = parse_valor(m.group(1))

    # Nota de Empenho
    m = re.search(r'(\d{4}NE\d{5,6})', bloco)
    if m:
        out['empenho_ne'] = m.group(1)

    # Nota Liquidação
    m = re.search(r'(\d{4}NL\d{5,6})', bloco)
    if m:
        out['nota_liq_nl'] = m.group(1)

    # Credor: "Credor 14092519000151 - MONTANA ASSESSORIA EMPRESARIAL LTDA - EPP"
    # Em OBs de retenção aparece antes "Credor da Retenção MINISTERIO...", que não tem \d{14}
    m = re.search(r'Credor\s+(\d{14})\s*-\s*([^\n]+)', bloco)
    if m:
        out['credor_cnpj'] = m.group(1)
        out['credor_nome'] = m.group(2).strip()[:80]

    # Empresa (derivada do CNPJ)
    if out.get('credor_cnpj') == CNPJ_ASSESSORIA:
        out['empresa'] = 'assessoria'
    elif out.get('credor_cnpj') == CNPJ_SEGURANCA:
        out['empresa'] = 'seguranca'

    # Contrato SIAFE: "Contrato 23000434 - PRESTAÇÃO..."
    m = re.search(r'Contrato\s+(\d{6,10})\s*-\s*([^\n]+)', bloco)
    if m:
        out['contrato_siafe'] = m.group(1)
        out['contrato_descricao'] = m.group(2).strip()[:80]

    # Competência: "Competência 01/2025"
    m = re.search(r'Competência\s+(\d{1,2}/\d{2,4})', bloco)
    if m:
        out['competencia'] = m.group(1)

    # NFs citadas — dois formatos:
    #   (a) 202500000000143 (15 dígitos WebISS — YYYY + 11 zeros + nº)
    #   (b) "Nota Fiscal nº00000751" → NF 751 (tirar zeros à esquerda)
    # NFs WebISS: year 202[3-9] seguido de ≥7 zeros — filtra processos tipo 202227000005515
    nfs_long = re.findall(r'\b(20[2-3]\d0{7,}\d{1,6})\b', bloco)
    nfs_short = []
    # Formatos: "NF 00000751", "Nota Fiscal nº00000751", "NF's n° 00000750 e 00000751"
    # Ancora: cada ocorrência de "nota(s) fiscal(is)". Depois scanear janela de 250 chars
    # extraindo todos os números 3-6 dígitos que não sejam anos (preced./segd. por /).
    for m in re.finditer(r'[Nn]ota[s]?\s+[Ff]isca(?:l|is)', bloco):
        window = bloco[m.end():m.end()+280]
        stop = re.search(r'\b(contrato|valor|programação|registro|período|empenho)\b', window, re.I)
        if stop:
            window = window[:stop.start()]
        for m2 in re.finditer(r'(?<![/\d])0*(\d{3,6})(?!/\d)(?!\d)', window):
            num = m2.group(1)
            if not num or num == '0':
                continue
            # Excluir anos típicos (2020-2030)
            if re.match(r'^20[2-3]\d$', num):
                continue
            nfs_short.append(num)
    # Padrão "NF n° 00000751" sem palavra "Nota Fiscal" (pouco comum, mantido)
    for m in re.finditer(r"\bNF[''s]*\s*n[º°o\.]*\s*0*(\d{2,6})(?!\d)", bloco):
        nfs_short.append(m.group(1))
    # consolidar: converter cada curta ao formato 15 dígitos equivalente se possível
    # Format WebISS TO: ANO + 10 zeros + número(3-5 dígitos) → 2025 + 00000000000 + 751 = 2025000000000751
    todas_nfs = []
    seen = set()
    for nf in nfs_long:
        if nf not in seen:
            seen.add(nf); todas_nfs.append(nf)
    # Para as curtas, tentar mapear para formato WebISS usando ano da emissão
    ano_prefix = None
    if out.get('emissao'):
        ano_yy = out['emissao'][-2:]
        ano_prefix = '20' + ano_yy
    for nf in nfs_short:
        nf_norm = nf.lstrip('0') or nf
        if ano_prefix:
            nf_long = f"{ano_prefix}{nf_norm.zfill(11)}"
            if nf_long not in seen:
                seen.add(nf_long); todas_nfs.append(nf_long)
        if nf_norm not in seen:
            seen.add(nf_norm); todas_nfs.append(nf_norm)
    if todas_nfs:
        out['nfs'] = todas_nfs

    # Tipo retenção (só em OBs de Retenção): "Tipo de Retenção INSS"
    if out.get('tipo_doc') and 'Retenção' in out['tipo_doc']:
        m = re.search(r'Tipo de Retenção\s+([A-ZÀ-Úa-zà-ú][A-ZÀ-Úa-zà-ú\s]*?)(?:\s*\n|Credor\s+da)', bloco)
        if m:
            out['tipo_retencao'] = m.group(1).strip()
        # Categoria resumida
        tr = (out.get('tipo_retencao') or '').upper()
        if 'INSS' in tr:
            out['categoria'] = 'INSS'
        elif 'IRRF' in tr or 'IR' in tr.split():
            out['categoria'] = 'IRRF'
        elif 'ISS' in tr:
            out['categoria'] = 'ISS'
        elif 'PIS' in tr or 'COFINS' in tr or 'CSLL' in tr:
            out['categoria'] = 'PCC'
        else:
            out['categoria'] = 'RETENCAO'
    else:
        out['categoria'] = 'PAGAMENTO'

    # Status envio
    m = re.search(r'Status de Envio\s+([A-Za-zÀ-ÿ\s]+?)(?:Data|$|\n)', bloco)
    if m:
        out['status_envio'] = m.group(1).strip()

    # Domicílio Bancário Destino
    m = re.search(r'Domicílio Bancário Destino\s+([^\n]+)', bloco)
    if m:
        out['destino_banco'] = m.group(1).strip()[:90]

    # Observação — curta. Usa .*? para capturar observação vazia
    m = re.search(r'Observação\s*\n(.*?)(?:Registro de Envio|Programação de Desembolso)', bloco, re.DOTALL)
    if m:
        obs = ' '.join(m.group(1).split())
        out['observacao'] = obs[:400]

    return out

def split_blocos(texto_full):
    """Divide texto full por ocorrência do cabeçalho 'Governo do Estado do Tocantins'."""
    # A string "Governo do Estado do Tocantins\nOrdem Bancária" marca início de cada OB
    idx = [m.start() for m in re.finditer(r'Governo do Estado do Tocantins\s*\nOrdem Bancária', texto_full)]
    blocos = []
    for i, start in enumerate(idx):
        end = idx[i+1] if i+1 < len(idx) else len(texto_full)
        blocos.append(texto_full[start:end])
    return blocos

def main():
    pdfs = sorted(glob.glob(os.path.join(SRC, 'OB*')))
    print(f"Encontrados {len(pdfs)} PDFs em {SRC}\n")

    with open(OUT_TXT, 'w', encoding='utf-8') as ftxt:
        all_obs = []
        for pdf in pdfs:
            nome = os.path.basename(pdf)
            print(f"  → {nome}")
            texto = extrair_texto(pdf)
            ftxt.write(f"\n{'='*100}\n  ARQUIVO: {nome}\n{'='*100}\n{texto}\n")
            blocos = split_blocos(texto)
            print(f"      {len(blocos)} bloco(s) OB detectado(s)")
            for bl in blocos:
                ob = parse_bloco(bl)
                ob['_arquivo'] = nome
                all_obs.append(ob)

    # ── DEDUPLICAÇÃO por numero_ob ──
    seen = {}
    duplicatas = 0
    for ob in all_obs:
        k = ob.get('numero_ob')
        if not k:
            continue
        if k in seen:
            duplicatas += 1
            # Guardar arquivos-fonte
            seen[k].setdefault('_arquivos_fonte', [seen[k]['_arquivo']])
            seen[k]['_arquivos_fonte'].append(ob['_arquivo'])
        else:
            seen[k] = ob
    unicas = list(seen.values())

    # ── JSON ──
    with open(OUT_JSON, 'w', encoding='utf-8') as fj:
        json.dump({'total_obs_brutas': len(all_obs),
                   'duplicatas_entre_arquivos': duplicatas,
                   'obs_unicas': len(unicas),
                   'obs': unicas}, fj, ensure_ascii=False, indent=2)

    # ── CSV ──
    import csv
    keys = ['numero_ob','categoria','tipo_doc','tipo_retencao','emissao','valor',
            'credor_cnpj','credor_nome','empresa','contrato_siafe','competencia',
            'nfs','empenho_ne','nota_liq_nl','status_envio','_arquivo']
    with open(OUT_CSV, 'w', encoding='utf-8-sig', newline='') as fc:
        w = csv.writer(fc, delimiter=';')
        w.writerow(keys)
        for ob in sorted(unicas, key=lambda x: x.get('numero_ob','')):
            row = []
            for k in keys:
                v = ob.get(k, '')
                if isinstance(v, list):
                    v = ','.join(v)
                elif isinstance(v, float):
                    v = f"{v:.2f}".replace('.',',')
                row.append(v)
            w.writerow(row)

    # ── SUMÁRIO ──────────────────────────────
    print(f"\n{'='*100}")
    print(f"  SUMÁRIO DE EXTRAÇÃO")
    print(f"{'='*100}")
    print(f"  OBs brutas (c/ duplicatas entre arquivos): {len(all_obs)}")
    print(f"  Duplicatas entre arquivos removidas:       {duplicatas}")
    print(f"  OBs únicas:                                {len(unicas)}")

    por_empresa = {}
    por_categoria = {'PAGAMENTO':0, 'IRRF':0, 'INSS':0, 'ISS':0, 'PCC':0, 'RETENCAO':0}
    total_por_cat = {'PAGAMENTO':0.0, 'IRRF':0.0, 'INSS':0.0, 'ISS':0.0, 'PCC':0.0, 'RETENCAO':0.0}
    for ob in unicas:
        emp = ob.get('empresa','?')
        por_empresa[emp] = por_empresa.get(emp, 0) + 1
        cat = ob.get('categoria','?')
        por_categoria[cat] = por_categoria.get(cat, 0) + 1
        total_por_cat[cat] = total_por_cat.get(cat, 0.0) + (ob.get('valor') or 0)

    def fmt(v): return f"R$ {v:,.2f}".replace(',', 'X').replace('.', ',').replace('X','.')
    print(f"\n  Por empresa:    {por_empresa}")
    print(f"  Por categoria:  {por_categoria}")
    print(f"\n  Valores por categoria:")
    for c, v in total_por_cat.items():
        if v > 0:
            print(f"    {c:12s} {fmt(v)}")
    print(f"\n  Arquivos de saída:")
    print(f"    • {OUT_TXT}")
    print(f"    • {OUT_JSON}")
    print(f"    • {OUT_CSV}")

    # ── Lista das OBs únicas ──
    print(f"\n  Detalhe das OBs únicas (ordenadas):")
    print(f"  {'OB':16s} {'Categoria':10s} {'Emp':4s} {'Emissão':10s} {'Valor':>16s}  {'Comp':8s}  {'NFs (últimos 4 dígitos)'}")
    for ob in sorted(unicas, key=lambda x: x.get('numero_ob','')):
        cat = ob.get('categoria','?')
        emp = {'assessoria':'ASS', 'seguranca':'SEG'}.get(ob.get('empresa',''), '?')
        val = ob.get('valor')
        val_s = f"{val:>16,.2f}".replace(',', 'X').replace('.', ',').replace('X','.') if val else '—'
        # filtrar NFs: manter apenas as formato 202500... (ignorar processo 202327)
        nfs_raw = ob.get('nfs', []) or []
        nfs_fiscais = [n for n in nfs_raw if n.startswith(('20250','20260','20240'))]
        nfs_short = ','.join(n[-4:] for n in nfs_fiscais)  # últimos 4 dígitos pra caber
        print(f"  {ob.get('numero_ob','?'):16s} {cat:10s} {emp:4s} {ob.get('emissao','?'):10s} {val_s}  {ob.get('competencia','—'):8s}  {nfs_short}")

if __name__ == '__main__':
    main()
