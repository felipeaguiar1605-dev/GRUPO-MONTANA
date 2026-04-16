"""
Montana ERP — Importador automático de extratos de Contas Vinculadas
======================================================================
Como usar:
  1. Baixe os PDFs do BB Autoatendimento → Contas Vinculadas
  2. Salve TODOS na pasta: Downloads\CONTAS VINCULADAS EXTRATOS
  3. Execute este script: python importar_contas_vinculadas.py
  4. Os saldos são atualizados automaticamente no servidor de produção

O script:
  - Lê todos os PDFs da pasta
  - Extrai: conta vinculada, convenente, saldo, data
  - Envia para a API do Montana ERP em produção
  - Gera relatório resumido

Requisitos: pip install pdfplumber requests
"""

import os
import re
import sys
import json
import glob
import datetime
import requests

# ── Configuração ──────────────────────────────────────────────────
PASTA_PDFS = os.path.join(os.path.expanduser("~"), "Downloads", "CONTAS VINCULADAS EXTRATOS")
API_BASE   = "https://sistema.grupomontanasec.com/api"
USUARIO    = "admin"
SENHA      = "montana2026"

# ── Autenticação ──────────────────────────────────────────────────
def login():
    r = requests.post(f"{API_BASE}/auth/login",
                      json={"usuario": USUARIO, "senha": SENHA}, timeout=10)
    r.raise_for_status()
    return r.json()["token"]

# ── Extrai dados do PDF via texto ────────────────────────────────
def extrair_dados_pdf(caminho):
    try:
        import pdfplumber
        with pdfplumber.open(caminho) as pdf:
            texto = "\n".join(p.extract_text() or "" for p in pdf.pages)
    except ImportError:
        # Fallback: tenta ler com PyPDF2
        try:
            import PyPDF2
            with open(caminho, "rb") as f:
                reader = PyPDF2.PdfReader(f)
                texto = "\n".join(p.extract_text() or "" for p in reader.pages)
        except Exception as e:
            print(f"  [ERRO] Não conseguiu ler {os.path.basename(caminho)}: {e}")
            return None

    dados = {}

    # Convenente
    m = re.search(r"Nome do Convenente\s*\n(.+)", texto)
    if m:
        dados["convenente"] = m.group(1).strip()

    # CNPJ Convenente
    m = re.search(r"CNPJ do Convenente\s*\n(\d{14})", texto)
    if m:
        cnpj = m.group(1)
        dados["cnpj_convenente"] = f"{cnpj[:2]}.{cnpj[2:5]}.{cnpj[5:8]}/{cnpj[8:12]}-{cnpj[12:]}"

    # Conta Vinculada
    m = re.search(r"Conta Vinculada\s*\n(\d+)", texto)
    if m:
        dados["conta_vinculada"] = m.group(1).strip()

    # Período
    m = re.search(r"Data Inicio\s*\n(\d{2}/\d{2}/\d{4})", texto)
    if m:
        d, mo, y = m.group(1).split("/")
        dados["data_referencia"] = f"{y}-{mo}-{d}"
        dados["mes"] = f"{y}-{mo}"

    m = re.search(r"Até\s+(\d{2}/\d{2}/\d{4})", texto)
    if m:
        d, mo, y = m.group(1).split("/")
        dados["data_referencia_fim"] = f"{y}-{mo}-{d}"

    # Saldo Final
    m = re.search(r"Saldo Final\s+R\$\s+([\d.,]+)\s*C", texto)
    if m:
        saldo_str = m.group(1).replace(".", "").replace(",", ".")
        dados["saldo"] = float(saldo_str)
    else:
        # Tenta capturar saldo 0
        m = re.search(r"Saldo Final\s+R\$\s+0", texto)
        if m:
            dados["saldo"] = 0.0

    return dados if "conta_vinculada" in dados and "saldo" in dados else None

# ── Salva no servidor via SSH (script Python remoto) ──────────────
def salvar_no_servidor(token, registros):
    """Envia os saldos via API do Montana ERP"""
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Company": "assessoria",
        "Content-Type": "application/json",
    }
    # Usa endpoint genérico de configurações para salvar JSON
    payload = {"chave": "conta_vinculada_import", "valor": json.dumps({
        "importado_em": datetime.datetime.now().isoformat(),
        "registros": registros,
    })}
    try:
        r = requests.post(f"{API_BASE}/configuracoes", json=payload,
                          headers=headers, timeout=15)
        return r.status_code < 300
    except Exception as e:
        print(f"  [AVISO] API não disponível: {e}")
        return False

# ── Main ──────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print("  Montana ERP — Importador Contas Vinculadas")
    print(f"  Pasta: {PASTA_PDFS}")
    print("=" * 60)

    if not os.path.exists(PASTA_PDFS):
        print(f"\n[ERRO] Pasta não encontrada: {PASTA_PDFS}")
        print("Crie a pasta e coloque os PDFs nela.")
        sys.exit(1)

    pdfs = glob.glob(os.path.join(PASTA_PDFS, "*.pdf"))
    if not pdfs:
        print("\n[AVISO] Nenhum PDF encontrado na pasta.")
        sys.exit(0)

    print(f"\nEncontrados {len(pdfs)} PDFs. Processando...\n")

    registros = []
    total_saldo = 0

    for pdf_path in sorted(pdfs):
        nome = os.path.basename(pdf_path)
        dados = extrair_dados_pdf(pdf_path)

        if not dados:
            print(f"  [IGNORADO] {nome} — não foi possível extrair dados")
            continue

        saldo = dados.get("saldo", 0)
        total_saldo += saldo
        registros.append(dados)

        status = "✅" if saldo > 0 else "⬜"
        print(f"  {status} {dados.get('conta_vinculada','?')} | "
              f"{dados.get('convenente','?')[:30]:30s} | "
              f"R$ {saldo:>14,.2f}  [{dados.get('mes','?')}]")

    print(f"\n{'─'*60}")
    print(f"  TOTAL PROVISÕES: R$ {total_saldo:,.2f}")
    print(f"  Contas com saldo: {sum(1 for r in registros if r.get('saldo',0) > 0)}/{len(registros)}")
    print(f"{'─'*60}\n")

    if not registros:
        print("Nenhum registro válido para enviar.")
        return

    # Salva JSON local de backup
    backup_path = os.path.join(PASTA_PDFS, f"saldos_{datetime.date.today()}.json")
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump({"data": str(datetime.date.today()), "registros": registros,
                   "total": total_saldo}, f, ensure_ascii=False, indent=2)
    print(f"  📄 Backup salvo: {backup_path}")

    # Tenta enviar para o servidor
    print("  🔄 Enviando para o servidor...")
    try:
        token = login()
        ok = salvar_no_servidor(token, registros)
        if ok:
            print("  ✅ Saldos atualizados no Montana ERP!")
        else:
            print("  ⚠ Servidor não atualizou — use o backup JSON")
    except Exception as e:
        print(f"  ⚠ Erro ao conectar ao servidor: {e}")
        print(f"  Use o arquivo {backup_path} para importar manualmente")

    print("\n  Pronto! Abra o sistema e veja a aba 🏦 Conta Vinculada.")
    input("\n  [Enter para fechar]")

if __name__ == "__main__":
    main()
