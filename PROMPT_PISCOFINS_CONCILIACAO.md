# PROMPT — Conciliação e Apuração de PIS/COFINS
## Montana Assessoria em Segurança Ltda | Regime: Lucro Real Não-Cumulativo

> **Como usar:** Cole este prompt inteiro em uma nova conversa com o Claude (ou outro modelo) junto com os arquivos necessários. Ele fornece todo o contexto para que a IA consiga realizar a apuração com precisão fiscal.

---

## 1. CONTEXTO DA EMPRESA

**Empresa:** Montana Assessoria em Segurança Ltda
**Regime tributário:** Lucro Real — PIS/COFINS não-cumulativo
**Alíquotas:** PIS 1,65% + COFINS 7,6% = **9,25% sobre receita tributável**
**Base de cálculo:** Regime de **caixa** — considera os créditos efetivamente recebidos no mês
**Atividade:** Prestação de serviços de segurança e vigilância para órgãos públicos estaduais e federais em Tocantins
**Banco:** Banco do Brasil — Conta corrente principal

**Particularidade crítica dos pagadores:**
O histórico bancário registra "Ordem Bancária - MUNICIPIO DE PALMAS" para pagamentos de múltiplos órgãos (UFNT, UNITINS, DETRAN-TO, SEDUC-TO, UFT, SESAU-TO, PREVIPALMAS, SEMARH). Isso ocorre porque esses órgãos liquidam pelo caixa único do Tesouro Municipal via sistema SIAFEM/SIAFI. O pagador real está no CNPJ da nota fiscal emitida — não no histórico bancário.

---

## 2. FONTES DE DADOS (anexe ao prompt)

| Arquivo | Descrição | Confiabilidade |
|---------|-----------|----------------|
| `PIS_COFINS_CAIXA_assessoria_AAAAMM_vNN.xlsx` | Planilha de trabalho do contador — extrato classificado | ★★★★★ FONTE PRIMÁRIA |
| Extrato OFX / PDF bancário (Banco do Brasil) | Extrato oficial do período | ★★★★★ FONTE PRIMÁRIA |
| Notas fiscais emitidas (WebISS / ABRASF) | NFS-e emitidas no período pelo portal da Prefeitura | ★★★★★ |
| Relatório ERP (`Comparativo_PISCOFINS_*.xlsx`) | Comparativo ERP × planilha | ★★★★ dado que planilha já foi reconciliada |

---

## 3. CLASSIFICAÇÃO DOS CRÉDITOS

Cada crédito bancário deve ser classificado em uma das categorias abaixo:

| Categoria | PIS/COFINS | Critério |
|-----------|-----------|---------|
| **TRIBUTÁVEL** | ✅ Incide 9,25% | Receita de prestação de serviços — pagamento de cliente por NF emitida |
| **INTERNO** | ❌ Não tributa | Transferência entre contas do próprio grupo Montana (inter-empresas) |
| **INVESTIMENTO** | ❌ Não tributa | Resgate de aplicação financeira, CDB, poupança, depósito de garantia |
| **DEVOLVIDO** | ❌ Não tributa | PIX/TED rejeitado ou devolvido pelo banco |
| **NÃO TRIBUTA** | ❌ Não tributa | Empréstimo recebido, adiantamento, reembolso, depósito caução |
| **DIFERIDO** | ⏳ Aguarda NF | Recebimento sem nota fiscal emitida ainda — tributar no mês da NF |

---

## 4. VERIFICAÇÕES OBRIGATÓRIAS (checklist para o auditor/contador)

### 4.1 Integridade do extrato
- [ ] Total de créditos da planilha bate com o extrato OFX/PDF oficial do Banco do Brasil
- [ ] Nenhuma linha do extrato foi omitida na planilha (contar linhas de crédito)
- [ ] Saldos de abertura e encerramento conferem

### 4.2 Classificação dos créditos
- [ ] Todo crédito classificado como TRIBUTÁVEL tem NF correspondente emitida (verificar no WebISS)
- [ ] NFs emitidas e NFs recebidas (créditos) estão no mesmo mês — se não, verificar regime de competência vs. caixa
- [ ] Créditos INTERNO têm CNPJ do grupo Montana como origem (confirmar via CNPJ no histórico)
- [ ] Créditos INVESTIMENTO têm comprovante de resgate da aplicação
- [ ] Crédito DIFERIDO: identificar qual NF está pendente e em qual mês será lançado

### 4.3 Apuração final
- [ ] Base tributável = soma dos créditos TRIBUTÁVEL do período
- [ ] PIS = base × 1,65%
- [ ] COFINS = base × 7,6%
- [ ] Total PIS+COFINS = base × 9,25%
- [ ] Verificar créditos de PIS/COFINS sobre despesas (regime não-cumulativo pode gerar créditos a abater)
- [ ] DARF emitido com código correto (PIS: 6912 | COFINS: 5856) e vencimento no 25º dia do mês seguinte

### 4.4 Reconciliação NF × extrato
- [ ] Cada NF emitida no período tem um crédito correspondente no extrato (ou está em aberto/inadimplente)
- [ ] NFs em aberto (sem crédito) estão listadas como contas a receber
- [ ] Sem NFs duplicadas no WebISS para o mesmo tomador/período/valor

---

## 5. TAREFAS PARA A IA — passo a passo

Ao receber este prompt com os arquivos, execute na ordem:

**Passo 1 — Leia o extrato bancário**
Extraia todas as linhas de crédito (entradas) do período. Para cada linha: data, valor, histórico, CNPJ origem (se disponível).

**Passo 2 — Leia a planilha de classificação**
Compare com o extrato. Identifique:
- Créditos presentes no extrato mas ausentes na planilha (faltantes)
- Créditos presentes na planilha mas ausentes no extrato (divergência grave)
- Créditos classificados diferente do esperado (ex: INTERNO onde deveria ser TRIBUTÁVEL)

**Passo 3 — Leia as NFs emitidas (WebISS)**
Para cada crédito TRIBUTÁVEL, localize a NF correspondente. Verifique:
- CNPJ do tomador bate com o CNPJ que fez o pagamento
- Valor da NF bate com o crédito recebido (considerar retenções: ISS, INSS, IR)
- NF foi emitida antes ou no mesmo mês do recebimento

**Passo 4 — Apure o imposto**
Calcule: base tributável, PIS, COFINS, total devido. Liste cada crédito tributável com seu valor e NF vinculada.

**Passo 5 — Gere o relatório**
Produza uma planilha Excel com 4 abas:
1. **Resumo** — base tributável, PIS, COFINS, total, vencimento DARF
2. **Créditos Tributáveis** — data, valor, histórico, NF, tomador, CNPJ
3. **Créditos Não Tributáveis** — data, valor, histórico, classificação, motivo
4. **Divergências** — itens faltantes, classificações questionáveis, NFs sem crédito

---

## 6. DADOS DO PERÍODO MARÇO/2026 (para referência)

> Este bloco é específico para Mar/2026. Atualize para outros períodos.

| Item | Valor |
|------|-------|
| Total créditos (planilha v11) | R$ 9.713.526,90 |
| Qtde transações | 133 |
| Base TRIBUTÁVEL apurada | ~R$ 9.240.000 (inclui R$430K DETRAN Fev/2026) |
| Créditos INVESTIMENTO (resgates) | R$ 467.608,28 (3 Resgates Depósito Garantia — não tributa) |
| Crédito DETRAN Fev/2026 | R$ 430.496,43 — TED GOVERNO DO EST — **TRIBUTÁVEL** (pgto ref. fev/2026, NF já emitida) |
| Crédito INTERNO | R$ 5.637,13 (transferência interna Montana Serviços) |

**Principais tomadores tributáveis (Março/2026):**
- UFNT — CNPJ 38.178.825/0001-73
- DETRAN-TO — CNPJ 01.060.887/0001-95
- SEDUC-TO — CNPJ 25.053.083/0001-08
- UFT — CNPJ 14.092.519/0001-51
- UNITINS — CNPJ 01.637.536/0001-85
- SESAU-TO — CNPJ 25.053.117/0001-64

**Scripts prontos no servidor:**
```bash
# Rodar no servidor GCP antes de fechar a apuração:
cd /opt/montana/app_unificado
python3 scripts/fix_nfs_duplicadas_assessoria.py       # limpa 2 NFs duplicadas
python3 scripts/importar_extratos_faltantes_assessoria_202603.py  # importa 51 créditos faltantes
python3 scripts/migrate_dedup_fase1.py                  # proteção anti-duplicatas futura
pm2 restart montana
```

---

## 7. AVALIAÇÃO DE CONFIABILIDADE — Planilha v11

| Aspecto | Status | Observação |
|---------|--------|-----------|
| Fonte do extrato | ✅ Confiável | Gerada do OFX/extrato BB oficial |
| Cobertura do período | ✅ 133 transações identificadas | Validado contra extrato bancário |
| Classificação tributável | ✅ Confiável | Baseada em CNPJs e histórico — confirmado pelos pagadores reais |
| Créditos INVESTIMENTO | ✅ Correto | 3 Resgates Depósito Garantia — natureza não tributável confirmada |
| Crédito DETRAN R$430K | ✅ TRIBUTÁVEL | TED GOVERNO DO EST = DETRAN-TO, pagamento ref. Fev/2026. NF emitida. CONCILIADO |
| ERP vs planilha | ⚠️ Divergência | ERP estava com 51 lançamentos faltantes — script de correção preparado |
| NFs duplicadas | ⚠️ Corrigir antes | 2 NFs duplicadas identificadas no ERP (NF 301 e NF 347) — script pronto |

**Conclusão:** A planilha v11 é **confiável como base de apuração**, desde que:
1. Os 51 lançamentos faltantes sejam importados no ERP (script pronto)
2. As 2 NFs duplicadas sejam removidas (script pronto)
3. ✅ O crédito de R$430.496,43 = DETRAN-TO ref. Fev/2026 — TRIBUTÁVEL, já classificado como CONCILIADO no script de importação

---

*Documento gerado automaticamente pelo sistema Montana em 18/04/2026.*
*Atualizar dados dos blocos 6 e 7 para cada novo período.*
