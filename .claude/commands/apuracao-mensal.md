# Agente: Apuração Mensal PIS/COFINS — Grupo Montana

Executa o ciclo completo de apuração PIS/COFINS mensal do Grupo Montana (Assessoria + Segurança).

## Como usar

```
/apuracao-mensal --mes=4 --ano=2026
/apuracao-mensal --mes=3 --ano=2026 --validar-apenas
/apuracao-mensal   (usa mês anterior ao atual automaticamente)
```

## Fluxo que este agente executa

Ao ser invocado, siga os passos abaixo **na ordem**. Após cada passo informe o resultado resumido antes de prosseguir.

---

### PASSO 0 — Determinar período

Se `--mes` e `--ano` não foram fornecidos, use o mês anterior ao dia de hoje.
Calcule `d0 = AAAA-MM-01` e `d1 = AAAA-MM-31` (ou último dia do mês).

---

### PASSO 1 — Verificar pré-requisitos

Execute as verificações no banco de dados:

```js
// Assessoria
const extA = db.prepare(
  "SELECT COUNT(*) c, SUM(credito) total FROM extratos WHERE data_iso LIKE ? || '%'"
).get(mes);

// Segurança
const extS = dbSeg.prepare(
  "SELECT COUNT(*) c, SUM(credito) total FROM extratos WHERE data_iso LIKE ? || '%'"
).get(mes);
```

**Se extratos = 0 para uma empresa:** avisar o usuário e perguntar se quer continuar mesmo assim.

Verificar também NFs Prodata no mês (Segurança):
```js
const prodataMes = dbSeg.prepare(
  "SELECT COUNT(*) c FROM pagamentos_portal WHERE data_pagamento_iso LIKE ? || '%'"
).get(mes);
```

---

### PASSO 2 — Gerar relatório Excel

```bash
node scripts/_gerar_apuracao_caixa_puro.js --mes=<MM> --ano=<AAAA>
```

Capturar saída e mostrar o resumo console (empresas, base, DARFs).

---

### PASSO 3 — Validação cruzada automática

Executar as queries de validação independente (sem depender do script):

**3a. Conferir totais Assessoria:**
```sql
SELECT COUNT(*) nfs, SUM(valor_bruto) bruto, SUM(pis) pis_ret, SUM(cofins) cof_ret
FROM notas_fiscais nf JOIN extratos e ON e.id = nf.extrato_id
WHERE e.data_iso BETWEEN '<d0>' AND '<d1>'
  AND nf.data_emissao >= '<ANO>-01-01'
  AND nf.status_conciliacao NOT IN ('CANCELADA','ASSESSORIA');
```
Recalcular: PIS = MAX(bruto×0.0165 − pis_ret, 0), COFINS = MAX(bruto×0.076 − cof_ret, 0)
✅ Deve bater com o relatório ao centavo.

**3b. Conferir Segurança (BB + Prodata sem sobreposição):**
- COUNT NFs BB
- COUNT NFs Prodata (nf_id linkado, extrato_id IS NULL)
- Verificar que nenhuma NF aparece nas duas fontes

**3c. Checar duplicatas:**
```sql
SELECT nf.id, COUNT(*) c FROM notas_fiscais nf ... GROUP BY nf.id HAVING COUNT(*) > 1
```

**3d. Inspecionar NFs excluídas:**
- Listar NFs pagas no mês mas emitidas em ano anterior
- Confirmar que fazem sentido (atraso de pagamento, não erro)

**3e. Checar alerta "sem NF linkada":**
- Se > R$50k: listar os extratos sem NF e classificar (UFT Pix lote? OB sem NF? Outro?)
- Se < R$50k: registrar mas não bloquear

---

### PASSO 4 — Emitir parecer de validação

Apresentar tabela resumida:

| Item | Assessoria | Segurança |
|---|---|---|
| NFs na base | N (sem duplicatas) | N (sem duplicatas) |
| Sobreposição BB/Prodata | — | 0 ✓ |
| Retenções federais | R$X ✓ | R$0 ✓ |
| NFs excluídas (ano ant.) | N NFs, R$X | N NFs, R$X |
| **PIS DARF** | **R$X** | **R$X** |
| **COFINS DARF** | **R$X** | **R$X** |
| **TOTAL DARF** | **R$X** | **R$X** |

**GRUPO TOTAL: R$X — Vencimento: 25/MM_SEGUINTE/AAAA**

---

### PASSO 5 — Registrar resultado no histórico

Atualizar a tabela de histórico em `skill_apuracao_piscofins_mensal.md`:

```
| <Mês/Ano> | R$ <Assessoria_DARF> | R$ <Segurança_DARF> | **R$ <Total>** |
```

---

### PASSO 6 — Git commit

```bash
git add scripts/_gerar_apuracao_caixa_puro.js
git commit -m "feat(apuracao): relatório PIS/COFINS <MES>/<ANO> gerado e validado"
git push origin main
```

---

## Regras de negócio importantes (relembrar a cada execução)

1. **Filtro de ano:** `data_emissao >= '<ANO>-01-01'` — NFs de anos anteriores EXCLUÍDAS (já apuradas por competência)
2. **Caixa puro:** entra quem foi PAGO no mês, independente de quando foi emitido (dentro do ano corrente)
3. **Assessoria:** crédito de retenção SOMENTE de UFT/UFNT (federais). DETRAN/UNITINS/SESAU = 0.
4. **Segurança:** regime cumulativo → PIS/COFINS retido pelos clientes = IRRELEVANTE para o DARF
5. **Prodata/BRB:** Segurança recebe de Palmas via BRB — verificar `pagamentos_portal` mensalmente
6. **PREVI PALMAS:** costuma pagar NF do mês no dia ~27 → pode aparecer no mês seguinte
7. **UFT Motorista:** 6 NFs por mês (6 campuses), `contrato_ref = 'UFT MOTORISTA 05/2025'`

## Referência completa

Ver `skill_apuracao_piscofins_mensal.md` na pasta memory do projeto.
