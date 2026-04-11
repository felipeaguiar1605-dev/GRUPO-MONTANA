"""
Extrai dados dos PDFs de contratos Montana Assessoria
e atualiza a tabela `contratos` no SQLite.

Uso: python scripts/extrair_contratos_pdf.py [--dry-run]
"""
import sys, re, json, sqlite3, os
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit("Instale pdfplumber: pip install pdfplumber")

DRY_RUN  = "--dry-run" in sys.argv
BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "assessoria" / "montana.db"

PDF_DIRS = [
    Path("D:/ARQUIVO FINANCEIRO MONTANA/CONTRATOS MONTANA ASSESSORIA"),
    Path("D:/ARQUIVO FINANCEIRO MONTANA/CONTRATOS MONTANA ASSESSORIA/CONTRATOS MONTANA ASSESSORIA"),
]

# PDFs a ignorar (contrato social / alterações societárias)
IGNORAR = {"CONTRATO SOCIAL", "ALTERAÇÃO CONTRATUAL", "ALTERAÇÃO CONTRATO SOCIAL",
           "ALTERAÇÃO LTDA", "ALTERAÇÃO MONTANA"}

# ── Helpers ──────────────────────────────────────────────────────────────
def extrair_texto(pdf_path: Path, max_pages=15) -> str:
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            pages = pdf.pages[:max_pages]
            return "\n".join(p.extract_text() or "" for p in pages)
    except Exception as e:
        print(f"  ⚠️  Erro ao ler {pdf_path.name}: {e}")
        return ""

def limpar(s):
    if not s: return ""
    return re.sub(r"\s+", " ", s).strip()

def achar(patterns, texto, grupo=1, flags=re.I|re.S):
    for pat in patterns:
        m = re.search(pat, texto, flags)
        if m:
            try: return limpar(m.group(grupo))
            except: pass
    return ""

def formatar_cnpj(s):
    digits = re.sub(r"\D", "", s or "")
    if len(digits) == 14:
        return f"{digits[:2]}.{digits[2:5]}.{digits[5:8]}/{digits[8:12]}-{digits[12:]}"
    return s

def extrair_valor(texto):
    """Encontra valor mensal no texto, retorna float ou 0."""
    pats = [
        r"valor\s+mensal[^R\d]*R\$\s*([\d.,]+)",
        r"valor\s+global[^R\d]*R\$\s*([\d.,]+)",
        r"import[âa]ncia\s+mensal[^R\d]*R\$\s*([\d.,]+)",
        r"remuner[aà].[aã]o\s+mensal[^R\d]*R\$\s*([\d.,]+)",
        r"mensal[^R\d]*R\$\s*([\d.,]+)",
        r"R\$\s*([\d.]+,\d{2})",                        # primeiro R$ com centavos
    ]
    for pat in pats:
        m = re.search(pat, texto, re.I)
        if m:
            v = m.group(1).replace(".", "").replace(",", ".")
            try:
                f = float(v)
                if 1_000 < f < 50_000_000:
                    return f
            except: pass
    return 0.0

def extrair_datas(texto):
    """Retorna (vigencia_inicio, vigencia_fim) como strings."""
    # Padrões tipo "vigência: 01/01/2025 a 31/12/2025"
    m = re.search(r"vig[eê]ncia[^0-9]*(\d{2}/\d{2}/\d{4})\s+[aà]\s+(\d{2}/\d{2}/\d{4})", texto, re.I)
    if m: return m.group(1), m.group(2)

    m = re.search(r"(\d{2}/\d{2}/\d{4})\s+[aà]\s+(\d{2}/\d{2}/\d{4})", texto, re.I)
    if m: return m.group(1), m.group(2)

    # Prazo: "prazo de 12 (doze) meses" + data início
    ini = achar([r"data\s+de\s+in[ií]cio[^0-9]*(\d{2}/\d{2}/\d{4})",
                 r"assinatura[^0-9]*(\d{2}/\d{2}/\d{4})",
                 r"a\s+partir\s+de\s+(\d{2}/\d{2}/\d{4})"], texto)
    return ini, ""

# ── Extração principal ───────────────────────────────────────────────────
def processar_pdf(pdf_path: Path) -> dict | None:
    nome = pdf_path.stem.upper()
    if any(ign in nome for ign in IGNORAR):
        return None

    texto = extrair_texto(pdf_path)
    if not texto.strip():
        print(f"  ⚠️  PDF vazio/escaneado: {pdf_path.name}")
        return None

    # ── Contratante / órgão ─────────────────────────────────────────────
    contratante = achar([
        r"CONTRATANTE[:\s]+([A-ZÁÉÍÓÚÇÃÕ][A-ZÁÉÍÓÚÇÃÕa-záéíóúçãõ\s,.\-–()0-9]{10,120}?)(?=\s*(?:CNPJ|CPF|inscri|sediada|com sede|doravante|,\s*pessoa))",
        r"(?:denomina[do]+|denom\.?)\s+CONTRATANTE[:\s]+([^\n]{10,120})",
    ], texto)

    # ── CNPJ do contratante ──────────────────────────────────────────────
    # Pega primeiro CNPJ que NÃO seja o da Montana (14.092.519/0001-51)
    cnpjs = re.findall(r"\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}", texto)
    cnpj_contratante = ""
    for c in cnpjs:
        if "14.092.519" not in c:
            cnpj_contratante = c
            break

    # ── Número do contrato ───────────────────────────────────────────────
    num_contrato = achar([
        r"CONTRATO[^Nn°Nº]*[Nn°Nº\.]+\s*(\d+[/.-]\d{4})",
        r"CONTRATO\s+(?:DE\s+)?(?:PRESTA[ÇC][ÃA]O\s+DE\s+SERVI[ÇC]OS\s+)?N[°º\.]\s*(\d+[/.-]\d{4})",
        r"N[°º]\s*(\d+[/.-]\d{4})",
    ], texto)

    # fallback: extrair do nome do arquivo
    if not num_contrato:
        m = re.search(r"(\d+[-/]\d{2,4})", pdf_path.stem)
        if m: num_contrato = m.group(1).replace("-", "/")

    # ── Objeto / descrição ───────────────────────────────────────────────
    objeto = achar([
        r"OBJETO[:\s]+([^\n]{20,300})",
        r"tem por objeto[:\s]+([^\n]{20,300})",
        r"objeto\s+deste\s+contrato[:\s]+([^\n]{20,300})",
    ], texto)

    # ── Valor mensal ─────────────────────────────────────────────────────
    valor_bruto = extrair_valor(texto)

    # ── Vigência ─────────────────────────────────────────────────────────
    vig_ini, vig_fim = extrair_datas(texto)

    # ── Prazo em meses ───────────────────────────────────────────────────
    prazo_m = achar([r"prazo\s+de\s+(\d+)\s*\(?\w*\)?\s*meses?",
                     r"(\d+)\s*\(?\w*\)?\s*meses?\s+(?:de\s+)?vig[eê]ncia"], texto)

    return {
        "arquivo"       : pdf_path.name,
        "num_contrato"  : num_contrato,
        "contratante"   : limpar(contratante)[:200],
        "cnpj"          : cnpj_contratante,
        "objeto"        : limpar(objeto)[:400],
        "valor_bruto"   : valor_bruto,
        "vig_ini"       : vig_ini,
        "vig_fim"       : vig_fim,
        "prazo_meses"   : prazo_m,
    }

# ── Mapeamento arquivo → numContrato no banco ────────────────────────────
MAPA_NUM = {
    "CONTRATO 05-2025 UFT MOTORISTA" : "UFT MOTORISTA 05/2025",
    "CONTRATO 29 UFT"                : "UFT 16/2025",          # contrato mais recente
    "CONTRATO 30 UFNT"               : "UFNT 30/2022",
    "CONTRATO 022-2022 UNITINS"      : "UNITINS 003/2023 + 3°TA",
    "CONTRATO 178-2022 SESAU"        : "SESAU 178/2022",
    "CONTRATO 062-2024 INFRAESTRUTURA": "PREFEITURA 062/2024",
    "CONTRATO DETRAN 02-2024"        : "DETRAN 41/2023 + 2°TA",
    "CONTRATO PREVIPALMAS 03-2024"   : "PREVI PALMAS — em vigor",
    "CONTRATO SEDUC 016-2023"        : "SEDUC Limpeza/Copeiragem",
    "CONTRATO SEMARH 32-2024"        : "SEMARH 32/2024",
    "CONTRATO TCE 26-2025"           : "TCE 117/2024",
    "CONTRATO TRIBUNAL DE JUSTICA 73-2020"  : "TJ 73/2020",
    "CONTRATO TRIBUNAL DE JUSTIÇA 440-2024" : "TJ 440/2024",
}

# ── Main ─────────────────────────────────────────────────────────────────
def main():
    resultados = []
    pdfs = []
    for d in PDF_DIRS:
        if d.exists():
            pdfs += sorted(d.glob("*.pdf"))

    print(f"📄 {len(pdfs)} PDFs encontrados\n")

    for pdf in pdfs:
        dados = processar_pdf(pdf)
        if dados:
            resultados.append(dados)
            print(f"✅ {pdf.name}")
            print(f"   Nº: {dados['num_contrato']} | Contratante: {dados['contratante'][:60]}")
            print(f"   CNPJ: {dados['cnpj']} | Valor: R$ {dados['valor_bruto']:,.2f}")
            print(f"   Vig: {dados['vig_ini']} – {dados['vig_fim']} | Prazo: {dados['prazo_meses']} meses")
            print()

    # Salva JSON para auditoria
    json_path = BASE_DIR / "scripts" / "contratos_extraidos.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(resultados, f, ensure_ascii=False, indent=2)
    print(f"💾 JSON salvo: {json_path}\n")

    if DRY_RUN:
        print("⚠️  DRY RUN — banco não alterado")
        return

    # ── Atualiza banco ───────────────────────────────────────────────────
    conn = sqlite3.connect(str(DB_PATH))
    cur  = conn.cursor()

    ok_update = 0; ok_insert = 0
    for d in resultados:
        stem = Path(d["arquivo"]).stem
        num_banco = MAPA_NUM.get(stem)

        if num_banco:
            # Atualiza registro existente
            campos = []
            vals   = []
            if d["cnpj"]:
                campos.append("orgao = ?"); vals.append(d["cnpj"])
            if d["valor_bruto"] > 0:
                campos.append("valor_mensal_bruto = ?"); vals.append(d["valor_bruto"])
            if d["vig_ini"]:
                campos.append("vigencia_inicio = ?"); vals.append(d["vig_ini"])
            if d["vig_fim"]:
                campos.append("vigencia_fim = ?"); vals.append(d["vig_fim"])
            if d["objeto"]:
                campos.append("obs = ?"); vals.append(d["objeto"][:400])
            if not campos: continue

            campos.append("updated_at = datetime('now')")
            vals.append(num_banco)
            cur.execute(f"UPDATE contratos SET {', '.join(campos)} WHERE numContrato = ?", vals)
            if cur.rowcount:
                print(f"  🔄 Atualizado: {num_banco}")
                ok_update += 1
            else:
                # Não existe — insere novo
                cur.execute("""
                    INSERT INTO contratos
                      (numContrato, contrato, orgao, vigencia_inicio, vigencia_fim,
                       valor_mensal_bruto, valor_mensal_liquido, total_pago, total_aberto,
                       status, obs)
                    VALUES (?,?,?,?,?,?,0,0,0,'🟡 ATENÇÃO',?)
                """, (
                    num_banco,
                    d["contratante"] or num_banco,
                    d["cnpj"],
                    d["vig_ini"], d["vig_fim"],
                    d["valor_bruto"],
                    d["objeto"][:400],
                ))
                print(f"  ✅ Inserido: {num_banco}")
                ok_insert += 1
        else:
            # Arquivo sem mapeamento → insere pelo nome do arquivo
            num = d["num_contrato"] or stem
            cur.execute("SELECT id FROM contratos WHERE numContrato LIKE ?", (f"%{num}%",))
            if not cur.fetchone():
                cur.execute("""
                    INSERT OR IGNORE INTO contratos
                      (numContrato, contrato, orgao, vigencia_inicio, vigencia_fim,
                       valor_mensal_bruto, valor_mensal_liquido, total_pago, total_aberto,
                       status, obs)
                    VALUES (?,?,?,?,?,?,0,0,0,'🟡 ATENÇÃO',?)
                """, (
                    num, d["contratante"] or num, d["cnpj"],
                    d["vig_ini"], d["vig_fim"], d["valor_bruto"], d["objeto"][:400],
                ))
                if cur.rowcount:
                    print(f"  ➕ Novo contrato: {num}")
                    ok_insert += 1

    conn.commit()
    conn.close()

    total = ok_update + ok_insert
    print(f"\n{'═'*55}")
    print(f"✅ Banco atualizado — {ok_update} atualizados | {ok_insert} inseridos ({total} total)")

    # Resumo final do banco
    conn2 = sqlite3.connect(str(DB_PATH))
    rows = conn2.execute(
        "SELECT numContrato, orgao, valor_mensal_bruto, vigencia_inicio, vigencia_fim "
        "FROM contratos ORDER BY id"
    ).fetchall()
    conn2.close()

    print(f"\n{'─'*55}")
    print(f"{'Contrato':<30} {'CNPJ':^20} {'Valor Mensal':>14}")
    print(f"{'─'*55}")
    for r in rows:
        v = f"R$ {r[2]:,.2f}" if r[2] else "—"
        print(f"{str(r[0]):<30} {str(r[1] or '—'):^20} {v:>14}")
    print(f"{'─'*55}")
    print(f"Total: {len(rows)} contratos")

if __name__ == "__main__":
    main()
