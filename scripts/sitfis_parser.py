#!/usr/bin/env python3
"""
SITFIS PDF Parser -> SQLite (v2 — layout-aware)

Parses the Receita Federal "Informações de Apoio para Emissão de Certidão"
(a.k.a. Situação Fiscal / SITFIS) PDF into normalized tables.

Usage:
    python3 sitfis_parser.py <pdf>               [--db /opt/montana/data/sitfis.db]
    python3 sitfis_parser.py --dir /path/to/pdfs [--db ...]
"""
import argparse
import hashlib
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("pip install pymupdf", file=sys.stderr)
    sys.exit(1)

DEFAULT_DB = "/opt/montana/data/sitfis.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sitfis_snapshots (
    id INTEGER PRIMARY KEY,
    cnpj TEXT NOT NULL,
    razao_social TEXT,
    emissao DATE,
    validade_certidao DATE,
    tipo_certidao TEXT,
    codigo_controle TEXT,
    ua_domicilio TEXT,
    situacao_cadastral TEXT,
    hash_pdf TEXT UNIQUE,
    arquivo TEXT,
    paginas INTEGER,
    importado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_snap_cnpj ON sitfis_snapshots(cnpj);
CREATE INDEX IF NOT EXISTS idx_snap_emissao ON sitfis_snapshots(emissao);

CREATE TABLE IF NOT EXISTS sitfis_debitos (
    id INTEGER PRIMARY KEY,
    snapshot_id INTEGER REFERENCES sitfis_snapshots(id) ON DELETE CASCADE,
    sistema TEXT,
    receita TEXT,
    periodo_apuracao TEXT,
    data_vencimento DATE,
    valor_original REAL,
    saldo_devedor REAL,
    multa REAL,
    juros REAL,
    saldo_consolidado REAL,
    situacao TEXT
);
CREATE INDEX IF NOT EXISTS idx_deb_snap ON sitfis_debitos(snapshot_id);

CREATE TABLE IF NOT EXISTS sitfis_parcelamentos (
    id INTEGER PRIMARY KEY,
    snapshot_id INTEGER REFERENCES sitfis_snapshots(id) ON DELETE CASCADE,
    sistema TEXT,
    numero TEXT,
    modalidade TEXT,
    conta TEXT,
    parcelas_em_atraso INTEGER,
    valor_em_atraso REAL,
    situacao TEXT,
    exigibilidade_suspensa INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_parc_snap ON sitfis_parcelamentos(snapshot_id);

CREATE TABLE IF NOT EXISTS sitfis_inscricoes (
    id INTEGER PRIMARY KEY,
    snapshot_id INTEGER REFERENCES sitfis_snapshots(id) ON DELETE CASCADE,
    inscricao TEXT,
    receita TEXT,
    inscrito_em DATE,
    ajuizado_em DATE,
    processo TEXT,
    tipo_devedor TEXT,
    situacao TEXT,
    exigibilidade_suspensa INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_insc_snap ON sitfis_inscricoes(snapshot_id);
"""

# ------------------------- helpers -------------------------

def parse_br_date(s):
    if not s:
        return None
    s = s.strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_br_money(s):
    if not s:
        return None
    s = s.strip().replace("R$", "").replace(" ", "")
    # Brazilian format: 1.234.567,89
    s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
MONEY_RE = re.compile(r"^\d{1,3}(?:\.\d{3})*,\d{2}$")

HEADER_NOISE = {
    "MINISTÉRIO DA FAZENDA",
    "Por meio do Portal de Serviços da Receita Federal",
    "SECRETARIA ESPECIAL DA RECEITA FEDERAL DO BRASIL",
    "PROCURADORIA-GERAL DA FAZENDA NACIONAL",
    "INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO",
}


def clean_lines(text):
    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s:
            continue
        if s in HEADER_NOISE:
            continue
        if s.startswith("CNPJ do certificado"):
            continue
        if re.match(r"^\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2}$", s):
            continue
        if re.match(r"^Página:\s*\d+\s*/\s*\d+$", s):
            continue
        if s == "Final do Relatório":
            continue
        out.append(s)
    return out


# ------------------------- header -------------------------

def extract_header(lines):
    h = {
        "cnpj": None,
        "razao_social": None,
        "ua_domicilio": None,
        "situacao_cadastral": None,
        "tipo_certidao": None,
        "codigo_controle": None,
        "emissao": None,
        "validade_certidao": None,
    }
    text = "\n".join(lines)

    m = re.search(
        r"CNPJ:\s*(\d{2}\.\d{3}\.\d{3})\s*-\s*([A-ZÁ-Ú0-9/&.\-\s]+)", text
    )
    if m:
        raiz = m.group(1)
        h["razao_social"] = m.group(2).strip()
    m = re.search(r"CNPJ:\s*(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", text)
    if m:
        h["cnpj"] = m.group(1)

    m = re.search(r"UA de Domicílio:\s*([^\n]+)", text)
    if m:
        h["ua_domicilio"] = m.group(1).strip()
    m = re.search(r"Situação:\s*([A-ZÁ-Ú]+)", text)
    if m:
        h["situacao_cadastral"] = m.group(1).strip()

    if "Certidão Positiva com Efeitos de Negativa" in text:
        h["tipo_certidao"] = "CPEN"
    elif "Certidão Negativa" in text:
        h["tipo_certidao"] = "CND"
    elif "Certidão Positiva" in text:
        h["tipo_certidao"] = "CPD"

    m = re.search(
        r"Certidão Positiva com Efeitos de Negativa:\s*([0-9A-F.]+)", text
    )
    if m:
        h["codigo_controle"] = m.group(1)

    m = re.search(r"Emissão:\s*(\d{2}/\d{2}/\d{4})", text)
    if m:
        h["emissao"] = parse_br_date(m.group(1))
    m = re.search(r"Data de Validade:\s*(\d{2}/\d{2}/\d{4})", text)
    if m:
        h["validade_certidao"] = parse_br_date(m.group(1))
    return h


# ------------------------- section splitter -------------------------

SECTION_HEADERS = [
    ("sief_debito", re.compile(r"Pend[eê]ncia\s*-\s*Débito\s*\(SIEF\)")),
    ("siefpar_parcelamento", re.compile(r"Pend[eê]ncia\s*[–-]\s*Parcelamento\s*\(SIEFPAR\)")),
    ("sida_inscricao", re.compile(r"Pend[eê]ncia\s*-\s*Inscrição\s*\(SIDA\)")),
    ("sida_suspensa", re.compile(r"Inscrição com Exigibilidade Suspensa\s*\(SIDA\)")),
    ("sispar_suspenso", re.compile(r"Parcelamento com Exigibilidade Suspensa\s*\(SISPAR\)")),
]


def split_sections(lines):
    sections = {}
    current = None
    for ln in lines:
        matched = None
        for key, rx in SECTION_HEADERS:
            if rx.search(ln):
                matched = key
                break
        if matched:
            current = matched
            sections.setdefault(current, [])
            continue
        if current:
            sections[current].append(ln)
    return sections


# ------------------------- SIEF débitos -------------------------

def parse_sief_debitos(lines):
    """Parse blocks of 10 lines (varies) per débito."""
    out = []
    # Skip until after column headers
    i = 0
    while i < len(lines) and not re.match(r"^\d{4}-\d{2}\s*-\s*", lines[i]):
        i += 1
    while i < len(lines):
        if not re.match(r"^\d{4}-\d{2}\s*-\s*", lines[i]):
            i += 1
            continue
        receita = lines[i]
        i += 1
        # Period: "1º" "TRIM/2022"  OR  just "2022"  OR "JAN/2023"
        pa_parts = []
        while i < len(lines) and not DATE_RE.match(lines[i]):
            pa_parts.append(lines[i])
            i += 1
            if len(pa_parts) > 3:
                break
        periodo = " ".join(pa_parts).strip()
        dt_vcto = None
        if i < len(lines) and DATE_RE.match(lines[i]):
            dt_vcto = parse_br_date(lines[i])
            i += 1
        # Next expected: 5 money values, then situacao word
        money_vals = []
        while i < len(lines) and MONEY_RE.match(lines[i]) and len(money_vals) < 5:
            money_vals.append(parse_br_money(lines[i]))
            i += 1
        situacao = None
        if i < len(lines) and re.match(r"^[A-ZÁ-Ú ]+$", lines[i]) and not re.match(r"^\d", lines[i]):
            situacao = lines[i]
            i += 1
        rec = {
            "sistema": "SIEF",
            "receita": receita,
            "periodo_apuracao": periodo,
            "data_vencimento": dt_vcto,
            "valor_original": money_vals[0] if len(money_vals) > 0 else None,
            "saldo_devedor": money_vals[1] if len(money_vals) > 1 else None,
            "multa": money_vals[2] if len(money_vals) > 2 else None,
            "juros": money_vals[3] if len(money_vals) > 3 else None,
            "saldo_consolidado": money_vals[4] if len(money_vals) > 4 else None,
            "situacao": situacao,
        }
        out.append(rec)
    return out


# ------------------------- SIEFPAR -------------------------

def parse_siefpar(lines):
    out = []
    i = 0
    while i < len(lines):
        m = re.match(r"^Parcelamento:\s*([0-9.\-]+)$", lines[i])
        if not m:
            i += 1
            continue
        numero = m.group(1)
        parc_atraso = None
        valor_atraso = None
        modalidade = None
        j = i + 1
        while j < len(lines) and not lines[j].startswith("Parcelamento:"):
            ln = lines[j]
            m2 = re.match(r"^Parcelas em Atraso:\s*(\d+)", ln)
            if m2:
                parc_atraso = int(m2.group(1))
            m2 = re.match(r"^Valor em Atraso:\s*(\S+)", ln)
            if m2:
                valor_atraso = parse_br_money(m2.group(1))
            if ln in ("Parcelamento Simplificado", "Parcelamento Ordinário", "Parcelamento Especial"):
                modalidade = ln
            j += 1
        out.append({
            "sistema": "SIEFPAR",
            "numero": numero,
            "modalidade": modalidade,
            "conta": None,
            "parcelas_em_atraso": parc_atraso,
            "valor_em_atraso": valor_atraso,
            "situacao": "EM ATRASO" if parc_atraso and parc_atraso > 0 else None,
            "exigibilidade_suspensa": 0,
        })
        i = j
    return out


# ------------------------- SIDA -------------------------

INSCRICAO_RE = re.compile(r"^\d{2}\.\d\.\d{2}\.\d{6}-\d{2}$")
PROCESSO_RE = re.compile(r"^\d{5}\.\d{3}\.\d{3}/\d{4}-\d{2}$")


def parse_sida(lines, suspensa=False):
    out = []
    i = 0
    while i < len(lines):
        if not INSCRICAO_RE.match(lines[i]):
            i += 1
            continue
        inscricao = lines[i]
        i += 1
        receita = lines[i] if i < len(lines) else None
        i += 1
        inscrito_em = parse_br_date(lines[i]) if i < len(lines) and DATE_RE.match(lines[i]) else None
        if inscrito_em:
            i += 1
        ajuizado_em = parse_br_date(lines[i]) if i < len(lines) and DATE_RE.match(lines[i]) else None
        if ajuizado_em:
            i += 1
        processo = None
        if i < len(lines) and PROCESSO_RE.match(lines[i]):
            processo = lines[i]
            i += 1
        tipo_dev = None
        if i < len(lines) and re.match(r"^DEVEDOR\b", lines[i]):
            tipo_dev = lines[i]
            i += 1
        situacao = None
        if i < len(lines) and lines[i].startswith("Situação:"):
            situacao = lines[i].split(":", 1)[1].strip()
            i += 1
        out.append({
            "inscricao": inscricao,
            "receita": receita,
            "inscrito_em": inscrito_em,
            "ajuizado_em": ajuizado_em,
            "processo": processo,
            "tipo_devedor": tipo_dev,
            "situacao": situacao,
            "exigibilidade_suspensa": 1 if suspensa else 0,
        })
    return out


# ------------------------- SISPAR -------------------------

def parse_sispar(lines):
    out = []
    i = 0
    while i < len(lines):
        if lines[i] != "Conta":
            i += 1
            continue
        i += 1
        conta = lines[i] if i < len(lines) else None
        i += 1
        tipo = lines[i] if i < len(lines) else None
        i += 1
        modalidade = None
        if i < len(lines) and lines[i].startswith("Modalidade:"):
            modalidade = lines[i].split(":", 1)[1].strip()
            i += 1
        out.append({
            "sistema": "SISPAR",
            "numero": None,
            "modalidade": modalidade or tipo,
            "conta": conta,
            "parcelas_em_atraso": None,
            "valor_em_atraso": None,
            "situacao": tipo,
            "exigibilidade_suspensa": 1,
        })
    return out


# ------------------------- pipeline -------------------------

def ensure_schema(conn):
    conn.executescript(SCHEMA)
    conn.commit()


def process_pdf(conn, pdf_path):
    pdf_path = str(pdf_path)
    with open(pdf_path, "rb") as f:
        blob = f.read()
    hsh = hashlib.sha256(blob).hexdigest()

    row = conn.execute(
        "SELECT id FROM sitfis_snapshots WHERE hash_pdf = ?", (hsh,)
    ).fetchone()
    if row:
        # Delete related children + snapshot to re-parse (useful while iterating)
        conn.execute("DELETE FROM sitfis_debitos WHERE snapshot_id = ?", (row[0],))
        conn.execute("DELETE FROM sitfis_parcelamentos WHERE snapshot_id = ?", (row[0],))
        conn.execute("DELETE FROM sitfis_inscricoes WHERE snapshot_id = ?", (row[0],))
        conn.execute("DELETE FROM sitfis_snapshots WHERE id = ?", (row[0],))
        conn.commit()

    doc = fitz.open(pdf_path)
    raw_text = "\n".join(page.get_text() for page in doc)
    paginas = len(doc)
    doc.close()

    lines = clean_lines(raw_text)
    header = extract_header(lines)
    sections = split_sections(lines)

    cur = conn.execute(
        """INSERT INTO sitfis_snapshots
           (cnpj, razao_social, emissao, validade_certidao, tipo_certidao,
            codigo_controle, ua_domicilio, situacao_cadastral,
            hash_pdf, arquivo, paginas)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (header["cnpj"], header["razao_social"], header["emissao"],
         header["validade_certidao"], header["tipo_certidao"],
         header["codigo_controle"], header["ua_domicilio"],
         header["situacao_cadastral"], hsh, pdf_path, paginas),
    )
    sid = cur.lastrowid

    debitos = parse_sief_debitos(sections.get("sief_debito", []))
    for d in debitos:
        conn.execute(
            """INSERT INTO sitfis_debitos
               (snapshot_id, sistema, receita, periodo_apuracao, data_vencimento,
                valor_original, saldo_devedor, multa, juros,
                saldo_consolidado, situacao)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, d["sistema"], d["receita"], d["periodo_apuracao"],
             d["data_vencimento"], d["valor_original"], d["saldo_devedor"],
             d["multa"], d["juros"], d["saldo_consolidado"], d["situacao"]),
        )

    parcelamentos = (
        parse_siefpar(sections.get("siefpar_parcelamento", []))
        + parse_sispar(sections.get("sispar_suspenso", []))
    )
    for p in parcelamentos:
        conn.execute(
            """INSERT INTO sitfis_parcelamentos
               (snapshot_id, sistema, numero, modalidade, conta,
                parcelas_em_atraso, valor_em_atraso, situacao,
                exigibilidade_suspensa)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (sid, p["sistema"], p["numero"], p["modalidade"], p["conta"],
             p["parcelas_em_atraso"], p["valor_em_atraso"], p["situacao"],
             p["exigibilidade_suspensa"]),
        )

    inscricoes = (
        parse_sida(sections.get("sida_inscricao", []), suspensa=False)
        + parse_sida(sections.get("sida_suspensa", []), suspensa=True)
    )
    for i in inscricoes:
        conn.execute(
            """INSERT INTO sitfis_inscricoes
               (snapshot_id, inscricao, receita, inscrito_em, ajuizado_em,
                processo, tipo_devedor, situacao, exigibilidade_suspensa)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (sid, i["inscricao"], i["receita"], i["inscrito_em"],
             i["ajuizado_em"], i["processo"], i["tipo_devedor"],
             i["situacao"], i["exigibilidade_suspensa"]),
        )

    conn.commit()
    return {
        "status": "ok",
        "snapshot_id": sid,
        "file": pdf_path,
        "cnpj": header["cnpj"],
        "razao": header["razao_social"],
        "emissao": header["emissao"],
        "validade": header["validade_certidao"],
        "tipo": header["tipo_certidao"],
        "paginas": paginas,
        "debitos": len(debitos),
        "parcelamentos": len(parcelamentos),
        "inscricoes": len(inscricoes),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?")
    ap.add_argument("--dir")
    ap.add_argument("--db", default=DEFAULT_DB)
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    conn = sqlite3.connect(args.db)
    ensure_schema(conn)

    targets = []
    if args.pdf:
        targets.append(args.pdf)
    if args.dir:
        targets.extend(str(p) for p in Path(args.dir).rglob("*.pdf"))
    if not targets:
        ap.error("provide <pdf> or --dir")

    for t in targets:
        try:
            r = process_pdf(conn, t)
            print(
                f"[{r['status']}] {r.get('cnpj') or '?':<20} "
                f"{r.get('tipo') or '':<5} deb={r['debitos']} "
                f"parc={r['parcelamentos']} insc={r['inscricoes']} :: {t}"
            )
        except Exception as e:
            print(f"[error] {t}: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()

    conn.close()


if __name__ == "__main__":
    main()
