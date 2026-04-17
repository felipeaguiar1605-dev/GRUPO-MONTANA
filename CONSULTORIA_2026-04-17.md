# Consultoria Empresarial e Tributária — Grupo Montana
**Data:** 2026-04-17
**Escopo:** Diagnóstico a partir dos dados do sistema Montana (4 empresas, ~11k NFs, ~21k extratos, 13 contratos Assessoria + 6 Segurança)

---

## 1. Diagnóstico Financeiro — Receita Potencial vs. Realizada

### Faturamento mensal contratual (apenas contratos ativos com valor):

| Empresa | Faturamento mensal bruto | Cobertura atual | Gap |
|---|---:|---:|---:|
| Montana Assessoria | **~R$ 1,83M** | ~R$ 0,7M efetivo* | **60% ocioso** |
| Montana Segurança | **~R$ 2,13M** | Prefeitura 077/2025 + MP dominam | — |
| **Grupo ativo** | **~R$ 3,97M** | | |

\* **SEMUS 192/2025 (R$ 672.720,48/mês) tem `total_pago = 0`.** É o maior contrato individual ativo do grupo e não está faturando um centavo no banco. **Investigue esta semana** — ou não iniciou execução, ou as NFs estão com tomador errado, ou os pagamentos não foram importados.

### Contratos com `valor_mensal_bruto = 0` (dados incompletos)
- `SEDUC Limpeza/Copeiragem` (Assessoria)
- `UFT Segurança Privada` (Segurança)
- `Prefeitura Palmas 007/2023` (Segurança)
- `SEMARH 32/2024` (só ativo em boletins, ausente da tabela contratos com valor)
- `TJ 440/2024`

→ Essas 5 linhas distorcem qualquer cálculo de margem, DRE, e projeção de caixa. Até preencher os valores, suas análises financeiras têm ponto cego de provavelmente **R$ 500k-1M/mês**.

---

## 2. Otimizações Tributárias Concretas

### 2.1 Montana Assessoria — Lucro Real não-cumulativo (maior oportunidade)

**Atual:** PIS 1,65% + COFINS 7,60% = **9,25% sobre receita**, com direito a crédito de fornecedores em Lucro Real/Presumido.

**Problema estrutural:** Assessoria contrata serviços de Nevada, Porto do Vau e Mustang (todas Simples Nacional = **ZERO crédito**). Para cada R$ 100k pago internamente a essas empresas, perde ~R$ 9.250 de crédito que teria se contratasse fornecedor Lucro Real/Presumido.

**Ação 1 — Revisar estrutura de subcontratação:**
Se Nevada e Mustang fazem serviços essenciais, exercício:
*"Sairia mais barato migrá-las para Lucro Presumido?"*
Simples paga ~6-11% total — ao sair dele, Nevada gera crédito 9,25% para Assessoria. Se o volume interno for alto, **pode compensar migração**. Preciso da DRE dessas 3 para calcular o ponto de corte.

**Ação 2 — Mapear fornecedores externos por regime:**
No módulo PIS/COFINS (aba Despesas) já destacado em vermelho para Simples. Filtre por valor mensal descendente e veja os top 10 — se algum é >R$ 30k/mês e está no Simples, vale conversa comercial para avaliar migração ou substituição.

### 2.2 Montana Segurança — Lucro Real Cumulativo

**Atual:** PIS 0,65% + COFINS 3% = **3,65%** sem direito a créditos.

**Consequência ainda não explorada:** como não gera crédito, **toda subcontratação interna para Porto do Vau/Nevada/Mustang é tributariamente neutra**. Então aqui o fator decisivo é operacional (carga horária, posto, especialização), não fiscal.

**Atenção:** Prefeitura de Palmas 077/2025 (R$ 1,33M/mês) é o coração da Segurança. Cumulativo bate duro aqui — sem crédito de fardamento, armamento, veículos, treinamentos. **Quantificar o que pagaria em Lucro Real não-cumulativo**, ainda que com alíquota de 9,25%, é exercício que compensa fazer anualmente. A cada virada de ano há opção, e conforme matriz de custos, não-cumulativo pode vencer.

### 2.3 Retenções na fonte (crédito a deduzir)

Tomadores federais (UFT, UFNT) retêm PIS 0,65% + COFINS 3% + IRRF 1,5% + CSLL 1% + INSS 11% = **15,15-16,65% crédito** que reduz apuração própria.

**Verificar no sistema:** NFs do UFT/UFNT têm campos de retenção preenchidos? Se não, o DARF/apuração mensal pode estar pagando a maior. Ajuste simples no módulo NF mas com impacto direto em caixa.

---

## 3. Estrutura Societária — Pontos de Atenção

### Porto do Vau (CNPJ 41.034.574/0001-68) — banco 100% vazio

Dois cenários se operacional:
1. **Empresa "pronta para uso"** guardada para quando vencer Simples da Mustang/Nevada ou atender contratos específicos. OK, mas revisar custos mínimos anuais (DAS mínimo, contador, DEFIS) — ~R$ 3-6k/ano ocioso.
2. **Operou e migrou dados para outra empresa.** Nesse caso, atualizar o sistema é trivial.

**Pergunta crítica:** Porto do Vau ainda é Simples ou já virou Lucro Presumido? Simples tem sublimite de R$ 4,8M/ano. Se Segurança subcontratou Porto do Vau e volume passou disso, há risco de **desenquadramento retroativo com multa**.

### Mustang — apenas 23 funcionários RH

Comparado a Assessoria (592) e Segurança (2 — claramente incompleto), Mustang parece sub-utilizada. Se objetivo era terceirizar serviço do grupo, ROI está baixo. Avaliar se faz sentido manter ativa ou consolidar folha em outra empresa.

---

## 4. Riscos Críticos (próximos 30 dias)

### 4.1 Certidões vencendo
- **ESTADUAL: 24/04**
- **FGTS: 25/04**
- **MUNICIPAL: 25/04**
- FALÊNCIA: 02/05
- FEDERAL: 04/05

**Implicação prática:** UFT, UFNT, DETRAN, TCE, UNITINS, SEMUS exigem CNDs válidas para **cada pagamento**. Certidão vencida = pagamento suspenso automaticamente. Se ESTADUAL vence dia 24/04 e demora 3-5 dias úteis para emitir, **comece imediatamente**.

### 4.2 570 NFs da Segurança contaminadas (status = ASSESSORIA)
- UNITINS 255
- DETRAN 142
- FUNJURIS 93
- TCE 49
- CBMTO 31

NFs que pertencem à Assessoria mas foram importadas erroneamente via WebISS para o banco da Segurança.

**Risco fiscal:** se contabilizadas na apuração da Segurança, calculou-se PIS/COFINS cumulativo (3,65%) em receita que deveria estar na Assessoria não-cumulativa (9,25%). Dependendo do volume, pode ter ocorrido recolhimento **a maior OU a menor** em 2024/2025. **Revisão de apuração dos últimos 12 meses é obrigatória.**

### 4.3 Conciliação UFT motorista histórico
NFs 2025 sem discriminação não distinguíveis de UFT limpeza → risco de declarações acessórias inconsistentes. Para UFT, a **conta vinculada** (IN SEGES/MP 05/2017) exige segregação rigorosa por contrato. Auditoria MPF/CGU pode pedir esse breakdown.

### 4.4 RH fevereiro/2026 duplicado
2 entradas `rh_folha` para 2026-02 na Assessoria. Se foi alimentado em folha e pago em duplicidade, caixa indo embora. Se é cadastro errado, limpar antes que alguém calcule provisão em cima.

---

## 5. Oportunidade — Conta Vinculada UFT/UFNT

IN SEGES/MP 05/2017 — 31,04% de provisões mensais **depositados em conta vinculada**, movimentados só mediante autorização do contratante. Dinheiro que já foi faturado mas ainda não é seu.

**Valor estimado bloqueado:** UFT 16/2025 R$ 323k/mês × 31,04% ≈ R$ 100k/mês travados. Em 12 meses de contrato, **~R$ 1,2M imobilizados**.

**Recomendação:**
1. Puxe o extrato da conta vinculada UFT (separado da conta corrente) e importe no sistema — aba dedicada pronta
2. Confira se todas as **liberações** mensais (13º proporcional, férias, rescisão) estão sendo requisitadas no prazo. Há prefeituras/universidades que só liberam com solicitação formal, e empresas perdem liquidez por esquecimento burocrático
3. Saldo final, ao término do contrato, é resgatável. Mapear quanto está represado e fazer cronograma de liberações é **caixa potencial identificado**

---

## 6. Top 5 Ações Priorizadas (Próximos 30 dias)

| # | Ação | Impacto estimado | Prazo |
|---|---|---:|---|
| 1 | Renovar 5 certidões vencendo | Evita suspensão de ~R$ 1,5M pagamentos | ⏰ Essa semana |
| 2 | Investigar SEMUS 192/2025 (R$ 672k/mês não faturados) | R$ 8M/ano potencial | 7 dias |
| 3 | Reclassificar 570 NFs contaminadas Segurança→Assessoria + refazer apuração PIS/COFINS 2024-2025 | Provável restituição ou ajuste | 15 dias |
| 4 | Preencher `valor_mensal_bruto` dos 5 contratos zerados + reconciliar | Ponto cego de ~R$ 500k-1M/mês | 10 dias |
| 5 | Solicitar liberações pendentes conta vinculada UFT/UFNT | R$ 100-300k de caixa | 30 dias |

---

## 7. Dados Necessários para Aprofundar

1. **DRE das 4 empresas últimos 12 meses** (mesmo que manual) — para calcular ponto de break-even para migrar Nevada/Porto do Vau para Lucro Presumido
2. **Matriz de custos diretos Segurança** (fardamento, armas, veículos, treinamentos por contrato) — para simular Cumulativo vs Não-Cumulativo 2026
3. **Volume anual de subcontratação interna** (Assessoria→Nevada, Assessoria→Mustang) — para quantificar perda de crédito PIS/COFINS
4. **Folhas UFT/UFNT com competência** — para calcular se conta vinculada está sendo apropriadamente provisionada (31,04% exato)

---

## 8. Contexto Regime Tributário (referência rápida)

| Empresa | Regime | PIS+COFINS próprio | Crédito de fornecedores |
|---------|--------|---:|:---:|
| Montana Assessoria | **Lucro Real não-cumulativo** | 9,25% | ✅ Sim (exceto Simples) |
| Montana Segurança | **Lucro Real Cumulativo** | 3,65% | ❌ Não |
| Porto do Vau | Simples Nacional | DAS unificado | ❌ Não |
| Mustang | Simples Nacional | DAS unificado | ❌ Não |
| Nevada M Limpeza | Simples Nacional | DAS unificado | ❌ Não |

**Retenções na fonte tomadores federais** (UFT, UFNT): PIS 0,65% + COFINS 3% + IRRF 1,5% + CSLL 1% + INSS 11% = 16,15% — **todos creditáveis na apuração própria da Assessoria.**

---

*Relatório gerado a partir de dados em `data/assessoria/montana.db` e `data/seguranca/montana.db` — consolidação 2024-2026.*
