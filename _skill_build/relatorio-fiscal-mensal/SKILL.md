# Skill: Relatório Fiscal Mensal — Montana ERP

## O que faz
Gera os relatórios para a **contabilidade / Receita Federal** de cada mês:
- **receita_federal_assessoria_AAAA-MM.xlsx** — Montana Assessoria (Lucro Real)
- **receita_federal_seguranca_AAAA-MM.xlsx** — Montana Segurança (Lucro Presumido)

Identifica nota por nota qual **competência** (mês do serviço) cada recebimento representa,
separando o que já foi tributado no ano anterior do que deve ser tributado agora.

## Quando usar
No início de cada mês, após importar os extratos bancários do BB do mês anterior.
O relatório usa **regime de caixa** — as NFs importadas pelo WebISS + extratos conciliados no banco.

## Pré-requisitos antes de gerar
1. Extratos BB do mês anterior importados (CSV → `importar_extrato_bb.js`)
2. Conciliação executada para o mês (`conciliacao_2025_2026.js` ou `conciliacao_seguranca.js`)
3. NFs WebISS atualizadas se necessário (`importar_nfs_abril.js` ou equivalente do mês)

## Como executar (Windows — forma fácil)
```
scripts\RELATORIO_FISCAL.bat
```
Pergunta o mês e o ano, envia o script ao servidor, gera e baixa automaticamente.

## Como executar manualmente (linha de comando)
```bash
# Gerar no servidor
ssh -i ~/.ssh/id_montana diretoria@104.196.22.170 \
  "cd /opt/montana/app_unificado && node scripts/gerar_relatorio_receita_federal.js --mes=03 --ano=2026 --empresa=todas"

# Baixar
scp -i ~/.ssh/id_montana \
  "diretoria@104.196.22.170:/opt/montana/app_unificado/relatorios/receita_federal_*_2026-03.xlsx" \
  relatorios/
```

## Sem argumentos → mês anterior automático
```bash
node scripts/gerar_relatorio_receita_federal.js
# Rodando em abril/2026 → gera março/2026 automaticamente
```

## Estrutura do XLSX gerado (4 abas)
| Aba | Conteúdo |
|-----|----------|
| 1. Resumo | Totais por competência, lista de créditos sem NF categorizados |
| 2. NFs Pagas | 24 colunas: contrato, NF, tomador, CNPJ, competência, valores, retenções, PIS/COFINS próprios |
| 3. Apuração Fiscal | Separado em "Tributar Agora" (verde) e "Já Tributado" (amarelo), subtotais por seção |
| 4. Créditos sem NF | Lançamentos bancários não vinculados a NF: conta vinculada, depósito garantia, interno, verificar |

## Regimes tributários configurados
| Empresa | Regime | PIS | COFINS |
|---------|--------|-----|--------|
| Montana Assessoria | Lucro Real (não-cumulativo) | 1,65% | 7,60% |
| Montana Segurança | Lucro Presumido (cumulativo) | 0,65% | 3,00% |

## Lógica de matching NF → Extrato
1. **Pix/OB individual**: valor_liquido da NF = crédito do extrato (exato)
2. **TED em lote** (Estado, órgãos públicos): keyword do contrato (DETRAN, UNITINS, UFT…) + janela de 90 dias

## Campo "Já Tributado?"
- **NÃO** (verde): competência do serviço é do ano atual → **tributar agora**
- **SIM** (amarelo): competência é de ano anterior → imposto já declarado → **não tributar novamente**
  - Informar ao contador que o pagamento chegou atrasado

## Créditos sem NF — categorias
- 🔒 CONTA VINCULADA: depósitos escrow UFT/UFNT — **não tributável**
- 🔒 RESGATE DEPÓSITO GARANTIA: devolução de caução — **não tributável**
- 🔄 TRANSFERÊNCIA INTERNA: entre contas Montana — **não tributável**
- ⚖️ DESBLOQUEIO JUDICIAL: verificar NF correspondente
- ⚠️ VERIFICAR: possível NF não importada

## Servidor de produção
- Host: `104.196.22.170` (sistema.grupomontanasec.com)
- Caminho: `/opt/montana/app_unificado/`
- Relatórios gerados em: `/opt/montana/app_unificado/relatorios/`
- SSH key: `~/.ssh/id_montana`

## Arquivo fonte
`scripts/gerar_relatorio_receita_federal.js`
