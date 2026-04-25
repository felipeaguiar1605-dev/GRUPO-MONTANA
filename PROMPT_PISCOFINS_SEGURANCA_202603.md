# PROMPT — Apuração PIS/COFINS Março/2026 com Regra de Transição
## Montana Segurança Privada Ltda | Lucro Real Cumulativo 3,65% | Mudança Competência → Caixa

> **Como usar:** Cole este prompt em uma nova conversa com o Claude (ou outro modelo) e anexe os
> arquivos listados na Seção 2. O prompt contém dados já extraídos do ERP — o trabalho principal
> é classificar os 36 créditos ainda sem NF identificada.

---

## ⚠️ PONTO CRÍTICO — LEIA ANTES DE TUDO

**A empresa adotou regime de CAIXA para PIS/COFINS a partir de janeiro/2026.**
**Nos exercícios de 2024 e 2025, a empresa apurava por COMPETÊNCIA.**

Isso cria uma regra de transição obrigatória:

| Competência da NF | Regime vigente na emissão | Tratamento em março/2026 |
|-------------------|--------------------------|--------------------------|
| 2024 ou 2025 | Competência — **já tributou** quando emitiu a NF | **NÃO TRIBUTAR** — pagamento em 2026 é simples liquidação de receita já tributada |
| Jan/2026 em diante | Caixa — **só tributa no recebimento** | **TRIBUTAR** quando o dinheiro entrar |

> **Erro a evitar:** Incluir na base de março/2026 os pagamentos referentes a NFs de 2024/2025.
> Isso geraria bitributação — a empresa já pagou PIS/COFINS sobre essas notas no exercício de emissão.

---

## 1. CONTEXTO DA EMPRESA

**Empresa:** Montana Segurança Privada Ltda
**Regime PIS/COFINS atual:** Lucro Real — **Cumulativo** — **Caixa (desde jan/2026)**
**Regime anterior:** Lucro Real — **Cumulativo** — **Competência (até dez/2025)**
**Alíquotas:** PIS 0,65% + COFINS 3,00% = **3,65%**  *(regime cumulativo — sem créditos de entrada)*
**Atividade:** Vigilância e segurança para órgãos públicos municipais, estaduais e federais em Tocantins
**Bancos:**
- **BB (Banco do Brasil):** conta corrente principal — recebe pagamentos dos clientes
- **BRB:** exclusivo para investimentos (CDB/RDB/FI) — zero receita de serviços

---

## 2. ARQUIVOS NECESSÁRIOS (anexar ao prompt)

| Arquivo | Descrição | Prioridade |
|---------|-----------|-----------|
| Extrato BB março/2026 (PDF ou OFX) | Extrato oficial do período | ✅ Obrigatório |
| NFs 2026 emitidas — jan, fev, mar (WebISS/ABRASF) | Lista com número, competência, tomador, valor bruto e líquido | ✅ Obrigatório |
| NFs 2024/2025 PENDENTES (WebISS) — **só as que devem ter sido pagas em março/2026** | Para confirmar que já foram tributadas em exercício anterior | ✅ Obrigatório |
| Guias DARF de PIS/COFINS pagas em 2024 e 2025 | Comprovam que as NFs de 2024/2025 já foram tributadas (evita questionamento) | Recomendado |

---

## 3. O QUE O ERP JÁ IDENTIFICOU — SITUAÇÃO ATUAL

O sistema ERP da empresa analisou os **49 créditos BB CONCILIADO de março/2026** (R$ 1.521.746,81) e chegou ao seguinte cenário:

### 3.1 — Créditos JÁ vinculados a NFs de 2026 (TRIBUTÁVEIS em março/2026)
**12 créditos | R$ 516.420,14 — BASE CONFIRMADA**

| Data | Valor (R$) | Tomador | NF | Competência |
|------|-----------|---------|-----|------------|
| 03/03 | 20.749,12 | MINISTÉRIO PÚBLICO DO TO | 202600000000107 | fev/26 |
| 03/03 | 39.653,99 | MUNICÍPIO DE PALMAS | 202600000000304 | mar/26 |
| 03/03 | 42.618,71 | MUNICÍPIO DE PALMAS | 202600000000289 | mar/26 |
| 03/11 | 3.262,39 | MINISTÉRIO PÚBLICO DO TO | 202600000000143 | fev/26 |
| 03/16 | 3.274,25 | MINISTÉRIO PÚBLICO DO TO | 202600000000167 | fev/26 |
| 03/16 | 6.002,80 | MINISTÉRIO PÚBLICO DO TO | 202600000000173 | fev/26 |
| 03/16 | 6.548,50 | MINISTÉRIO PÚBLICO DO TO | 202600000000045 | jan/26 |
| 03/16 | 13.097,01 | MINISTÉRIO PÚBLICO DO TO | 202600000000160 | fev/26 |
| 03/19 | 99.390,38 | FUNDAÇÃO CULTURAL DE PALMAS (FCP) | 191 | fev/26 |
| 03/19 | 122.784,51 | FUNDAÇÃO CULTURAL DE PALMAS (FCP) | 202600000000191 | fev/26 |
| 03/19 | 147.341,41 | MUNICÍPIO DE PALMAS | 202600000000233 | mar/26 |
| 03/26 | 11.697,07 | MUNICÍPIO DE PALMAS | 202600000000294 | mar/26 |

### 3.2 — Crédito JÁ vinculado a NF de 2025 (JÁ TRIBUTADO — EXCLUIR)
**1 crédito | R$ 26.194,03 — EXCLUIR DA BASE**

| Data | Valor (R$) | Tomador | NF | Competência | Motivo |
|------|-----------|---------|-----|------------|--------|
| 03/19 | 26.194,03 | FUNDAÇÃO UNIVERSIDADE FEDERAL DO TO | 202500000001384 | dez/2025 | NF emitida em 2025 — já tributada sob competência em dez/2025 |

### 3.3 — Créditos SEM NF vinculada no ERP (INVESTIGAR — TAREFA PRINCIPAL)
**36 créditos | R$ 979.132,64 — CLASSIFICAR COMO 2024/2025 OU 2026**

> Esta é a tarefa central da apuração. Para cada crédito abaixo, identifique a NF correspondente
> e determine o exercício (competência). Se NF for de 2024/2025 → excluir. Se for de 2026 → tributar.

| # | Data | Valor (R$) | Histórico | Tomador suspeito | NF / Comp |
|---|------|-----------|-----------|-----------------|-----------|
| 1 | 03/03 | 41.933,74 | Pix — CNPJ 05.149.726/0001-04 FUNDACAO UN | ❓ Identificar | ? |
| 2 | 03/03 | 51.013,11 | Pix — CNPJ 05.149.726/0001-04 FUNDACAO UN | ❓ Identificar | ? |
| 3 | 03/06 | 8.312,40 | TED GOVERNO DO EST — CNPJ 01.786.029/0001-03 | Estado TO | ? |
| 4 | 03/06 | 18.228,77 | TED GOVERNO DO EST — CNPJ 01.786.029/0001-03 | Estado TO | ? |
| 5 | 03/06 | 28.474,95 | TED GOVERNO DO EST — CNPJ 01.786.029/0001-03 | Estado TO | ? |
| 6 | 03/12 | 56.545,49 | TED GOVERNO DO EST — CNPJ 01.786.029/0001-03 | Estado TO | ? |
| 7 | 03/16 | 1.637,13 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 8 | 03/16 | 2.182,83 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 9 | 03/16 | 2.182,84 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 10 | 03/16 | 3.429,28 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 11 | 03/16 | 4.502,10 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 12 | 03/16 | 4.502,11 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 13 | 03/16 | 6.139,22 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 14 | 03/16 | 6.139,23 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 15 | 03/16 | 8.185,63 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 16 | 03/16 | 8.185,64 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 17 | 03/16 | 9.563,24 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 18 | 03/16 | 12.859,84 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 19 | 03/16 | 18.008,39 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 20 | 03/16 | 19.645,52 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 21 | 03/16 | 24.556,90 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 22 | 03/16 | 28.474,95 | TED GOVERNO DO EST — CNPJ 01.786.029/0001-03 | Estado TO | ⚠️ 2024/25? |
| 23 | 03/16 | 35.862,16 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 24 | 03/17 | 1.637,13 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 25 | 03/17 | 36.016,79 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 26 | 03/17 | 49.113,80 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 27 | 03/17 | 49.113,81 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 28 | 03/18 | 19.038,27 | Ordem Bancária ORDENS BANCARIAS | ❓ Identificar | ? |
| 29 | 03/18 | 193.359,33 | TED GOVERNO DO EST — CNPJ 01.786.029/0001-03 | Estado TO — grande valor | ⚠️ 2024/25? |
| 30 | 03/19 | 24.556,90 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 31 | 03/19 | 35.862,16 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 32 | 03/19 | 73.670,71 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ⚠️ 2024/25? |
| 33 | 03/26 | 9.667,72 | Ordem Bancária MUNICIPIO DE PALMAS | Palmas/SIAFEM | ? |
| 34 | 03/26 | 12.859,84 | Ordem Bancária ORDENS BANCARIAS | ❓ Identificar | ⚠️ 2024/25? |
| 35 | 03/26 | 24.556,90 | Ordem Bancária ORDENS BANCARIAS | ❓ Identificar | ⚠️ 2024/25? |
| 36 | 03/26 | 49.113,81 | Ordem Bancária ORDENS BANCARIAS | ❓ Identificar | ⚠️ 2024/25? |

**Alertas sobre valores repetidos** (forte indicativo de liquidações de múltiplas competências):
- R$ 24.556,90 aparece em 03/16, 03/19 e 03/26 — 3 pagamentos distintos, possivelmente 3 competências diferentes
- R$ 35.862,16 aparece em 03/16 e 03/19 — 2 competências
- R$ 49.113,81 aparece em 03/17 e 03/26 — 2 competências
- R$ 12.859,84 aparece em 03/16 e 03/26 — 2 competências
- R$ 1.637,13 aparece em 03/16 e 03/17 — 2 competências

> Se essas competências forem de 2024 ou 2025, os valores correspondentes **saem da base tributável**.

---

## 4. COMO OS PAGADORES APARECEM NO EXTRATO BB

### SIAFEM / SIAFI — rota dos pagamentos governamentais
O histórico bancário registra o nome do sistema/tesouro, não o órgão real.

| O que aparece no extrato | O que é na prática |
|-------------------------|--------------------|
| "Ordem Bancária — MUNICIPIO DE PALMAS" | Pode ser: Palmas direto, UNITINS, FCP, ATCP, PREVIPALMAS, AGETO, ARCAF, etc. |
| "TED — GOVERNO DO EST / 01.786.029/0001-03" | Pode ser: DETRAN-TO, SEDUC-TO, SESAU-TO, CBMTO, TCE-TO, SEMARH, SEINF, etc. |
| "Pix — 05.149.726/0001-04 FUNDACAO UN" | **PENDENTE DE IDENTIFICAÇÃO** — consultar Receita Federal |

O pagador real está sempre na **NF emitida**, identificado pelo CNPJ do tomador.

### CNPJs conhecidos dos tomadores de Segurança
| CNPJ | Tomador |
|------|---------|
| 05.149.726/0001-04 | ❓ **Identificar** — "FUNDACAO UN" |
| 01.786.029/0001-03 | Governo do Estado do Tocantins (SIAFI) |
| 01.637.536/0001-85 | UNITINS |
| 14.092.519/0001-51 | UFT |
| 01.060.887/0001-95 | DETRAN-TO |
| 25.053.083/0001-08 | SEDUC-TO |
| 25.053.117/0001-64 | SESAU-TO |
| 07.955.067/0001-40 | CBMTO |
| 25.053.039/0001-02 | TCE-TO |
| 04.673.357/0001-05 | FCP — Fundação Cultural de Palmas |

---

## 5. BACKLOG DE NFs 2024/2025 (referência — já tributadas sob competência)

O ERP registra o seguinte volume de NFs emitidas em 2024/2025 ainda aguardando pagamento.
**Esses valores foram tributados nos respectivos exercícios de emissão e NÃO devem ser tributados novamente quando recebidos em 2026.**

| Exercício | NFs PENDENTE | Valor total a receber |
|-----------|-------------|----------------------|
| 2024 | 1.119 NFs | R$ 36.506.340,46 |
| 2025 | 1.289 NFs | R$ 38.082.933,01 |
| **Total** | **2.408 NFs** | **R$ 74.589.273,47** |

Desse total, o mês com maior backlog 2024 é **novembro/2024 (168 NFs | R$ 5,5M)** e o maior backlog 2025 é **maio/2025 (142 NFs | R$ 5,7M)**.

---

## 6. CRÉDITOS NÃO TRIBUTÁVEIS (já identificados — fora da base em qualquer cenário)

| Banco | Categoria | Qtd | Valor (R$) |
|-------|-----------|-----|-----------|
| BB | Rende Fácil / aplicação automática | 10 | 1.802.218,07 |
| BB | Transferências internas grupo Montana | 5 | 415.000,00 |
| BB | PENDENTE sem NF (pequenos valores) | 2 | 883,52 |
| BRB | Resgates CDB/RDB/FI BRB | 11 | 1.478.810,89 |
| **Total** | | **28** | **R$ 3.696.912,48** |

---

## 7. NFs 2026 EMITIDAS E AINDA NÃO RECEBIDAS ATÉ 31/03 (DIFERIDO — regime caixa)

Estas NFs tributarão **no mês do recebimento** — não entram na base de março/2026.

| Competência | NFs emitidas | NFs já pagas | NFs DIFERIDO | Valor DIFERIDO |
|------------|-------------|-------------|-------------|----------------|
| jan/26 | 97 | 13 | 84 | ~R$ 700K |
| fev/26 | 146 | 24 | 122 | ~R$ 3,5M |
| mar/26 | 228 | 77 | 151 | ~R$ 7,2M |

> Os valores exatos serão confirmados após a Tarefa 1 abaixo.

---

## 8. TAREFAS PARA A IA — PASSO A PASSO

### Tarefa 1 — Identifique a NF correspondente a cada um dos 36 créditos sem vínculo (Seção 3.3)

Para cada crédito da lista da Seção 3.3:
1. Busque no extrato bancário original o CNPJ completo do pagador
2. Localize no WebISS a NF emitida para esse CNPJ com valor próximo ao crédito recebido (considere retenções de ISS, INSS, IR — o valor líquido pago pode ser menor que o bruto da NF)
3. Verifique a **competência** e o **ano de emissão** da NF encontrada
4. Registre: NF número, competência, tomador, valor bruto NF, valor recebido, diferença (retenções)

### Tarefa 2 — Classifique cada crédito da Seção 3.3

Para cada crédito identificado na Tarefa 1:

- **NF de jan/2026 em diante** → coluna "TRIBUTÁVEL em mar/26" = SIM
- **NF de 2024 ou 2025** → coluna "JÁ TRIBUTADO sob competência" = SIM → **EXCLUIR DA BASE**
- **Sem NF identificada** → coluna "PENDENTE — aguarda investigação" = SIM → conservadoramente incluir na base (ou tratar como DIFERIDO até esclarecimento)

### Tarefa 3 — Identifique o CNPJ 05.149.726/0001-04 ("FUNDACAO UN")

- Consulte a Receita Federal (CNPJ 05.149.726/0001-04)
- Os 3 créditos ainda sem vínculo dessa entidade: R$41.933,74 + R$51.013,11 = R$92.946,85 (mais os R$20.749,12 e R$42.618,71 já identificados como MPTO e Palmas respectivamente)
- Localize as NFs emitidas para esse CNPJ e determine se são de 2024, 2025 ou 2026

### Tarefa 4 — Calcule a base tributável final

```
BASE CONFIRMADA 2026 (Seção 3.1)                  R$ 516.420,14
(+) Créditos sem vínculo classificados como 2026   R$ ?
(-) Créditos sem vínculo classificados como 2024/25 R$ ?
(-) Crédito NF dez/25 já tributado (Seção 3.2)    R$ (26.194,03)
= BASE TRIBUTÁVEL FINAL                           R$ ?

PIS (0,65%)  = base × 0,0065
COFINS (3,00%) = base × 0,030
TOTAL        = base × 0,0365

⚠ Regime CUMULATIVO — NÃO há créditos de entrada a abater.
= PIS/COFINS A RECOLHER (valor bruto = valor líquido)  R$ ?
```

**Vencimento DARF:** 27/04/2026 (25/04 cai em sábado)
**PIS — cód. DARF:** 6912
**COFINS — cód. DARF:** 5856

### Tarefa 5 — Gere o Excel com 5 abas

**Aba 1 — Resumo Executivo**
Base tributável final, PIS (0,65%), COFINS (3,00%), total a recolher, vencimento DARF
*(Regime cumulativo — não há créditos de entrada para abater)*

**Aba 2 — Créditos Tributáveis (2026)**
Colunas: Data | Valor | Tomador | CNPJ | NF | Competência NF | Tributável? | Observação

**Aba 3 — Excluídos — Exercício Anterior (2024/2025)**
Todos os créditos identificados como NFs de 2024/2025 com: NF número, competência original, DARF de referência em que foi tributada, valor excluído

**Aba 4 — Não Tributa (Investimentos / Internos)**
BB Rende Fácil + INTERNO + BRB + PENDENTE pequenos

**Aba 5 — Diferido (NFs 2026 não recebidas)**
NFs jan/fev/mar 2026 emitidas e ainda não pagas — tributar no recebimento

---

## 9. CHECKLIST FINAL

- [ ] CNPJ 05.149.726/0001-04 identificado e NFs localizadas
- [ ] Todos os 36 créditos sem vínculo (Seção 3.3) classificados como 2024/25 ou 2026
- [ ] R$ 26.194,03 (NF 202500000001384 — dez/25) excluído da base
- [ ] Base tributável calculada com apenas NFs de 2026
- [ ] *(Regime cumulativo — não há créditos de entrada para apurar)*
- [ ] Aba 3 do Excel documenta todos os pagamentos de exercícios anteriores com referência às DARFs de 2024/2025
- [ ] DARF vencimento: **27/04/2026** (não 25/04 — é sábado)

---

## 10. CENÁRIOS DE BASE TRIBUTÁVEL (estimativa antes da investigação completa)

| Cenário | Hipótese | Base (R$) | PIS+COFINS 3,65% (R$) |
|---------|---------|-----------|----------------------|
| **Mínimo** | Todos os 36 sem vínculo são NFs de 2024/2025 | 516.420,14 | **18.849,34** |
| **Médio** | Metade dos R$979K é 2026, metade é 2024/2025 | 1.005.986,46 | **36.718,41** |
| **Máximo** | Todos os 36 sem vínculo são NFs de 2026 | 1.495.552,78 | **54.587,68** |
| ~~Base sem transição (incorreta)~~ | ~~Ignorando competência anterior~~ | ~~1.521.746,81~~ | ~~55.543,76~~ |

> **O contador deve confirmar** qual dos cenários é o real após identificar as NFs dos 36 créditos.
> O cenário mínimo é o mais provável dado o grande volume de NFs de 2024/2025 ainda em aberto dos
> mesmos pagadores (Município de Palmas e Governo do Estado).

---

## 11. OBSERVAÇÃO CONTÁBIL — DOCUMENTAÇÃO PARA EVENTUAL AUDITORIA

Ao excluir pagamentos de exercícios anteriores da base do regime de caixa, o contador deve manter:
1. Cópia das NFs de 2024/2025 correspondentes (WebISS)
2. Referência às guias DARF em que essas NFs foram tributadas (período de competência)
3. Planilha de controle ligando crédito bancário de 2026 ↔ NF de 2024/2025 ↔ DARF do exercício anterior

Isso garante, em caso de fiscalização, a comprovação de que não houve omissão de receita, apenas
aplicação correta da regra de transição competência → caixa.

---

*Gerado em 18/04/2026 — Montana Segurança Privada Ltda — Sistema ERP Montana*
*Base de dados: extrato BB mar/2026 + NFs do ERP (backup 17/04/2026)*
