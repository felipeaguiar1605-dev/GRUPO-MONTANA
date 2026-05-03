"""Temporary: fixes broken print statements in apuracao_piscofins_seguranca_mensal.py"""
import pathlib, sys

p = pathlib.Path(__file__).parent / 'apuracao_piscofins_seguranca_mensal.py'
txt = p.read_text(encoding='utf-8')

# Target the broken section (everything from 'ano_mes = args.ano_mes.strip()' onward)
ANCHOR = '    ano_mes = args.ano_mes.strip()\n'
idx = txt.find(ANCHOR)
if idx == -1:
    print('ANCHOR NOT FOUND'); sys.exit(1)

# Keep everything before and including the anchor setup
header = txt[:idx]

# Write the correct main body
body = r"""    ano_mes = args.ano_mes.strip()
    if len(ano_mes) != 7 or ano_mes[4] != '-':
        print("ERRO: formato invalido '" + ano_mes + "'. Use AAAA-MM (ex: 2026-03).")
        sys.exit(1)

    print("\n  Montana Seguranca - Apuracao PIS/COFINS " + ano_mes)
    print("  Banco: " + str(DB_PATH))

    if not DB_PATH.exists():
        print("\n  ERRO: Banco nao encontrado em " + str(DB_PATH))
        sys.exit(1)

    d = apurar(ano_mes)

    print("\n  --- Resultado -------------------------------------------")
    print("  Base tributavel:  " + brl(d['base_tributavel']))
    print("  PIS  (0,65%):     " + brl(d['pis']) + "    DARF " + DARF_PIS)
    print("  COFINS (3,00%):   " + brl(d['cofins']) + "    DARF " + DARF_COFINS)
    print("  TOTAL a recolher: " + brl(d['total_darf']))
    print("  Vencimento DARF:  " + d['vencimento'])
    print("\n  --- Classificacao dos creditos --------------------------")
    print("  Tributaveis:   %4d creditos" % len(d['tributaveis']))
    print("  Excluidos:     %4d creditos  (NFs emitidas 2024/2025)" % len(d['excluidos']))
    print("  Nao tributa:   %4d creditos  (internos / investimentos)" % len(d['nao_tributa']))
    print("  PENDENTES:     %4d creditos  <- classificar no Portal" % len(d['pendentes']))

    if d['pendentes']:
        print("\n  ATENCAO: %d creditos sem NF vinculada - verifique e vincule no ERP." % len(d['pendentes']))

    out = gerar_excel(d)
    print("\n  OK - Excel gerado: " + str(out) + "\n")


if __name__ == '__main__':
    main()
"""

p.write_text(header + body, encoding='utf-8')
print('OK - script fixed')
