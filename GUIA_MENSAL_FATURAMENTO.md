# Guia Mensal de Faturamento — Equipe Montana

> Documento operacional. Cole na parede do financeiro. Toda equipe deve seguir.

---

## Quem faz o quê

| Quem | O que faz | Permissão no sistema |
|------|-----------|----------------------|
| **Operacional** | Preenche boletins de medição (colaboradores, glosas, faltas) | `operacional` |
| **Financeiro** | Aprova prévias + revisa antes de emitir NF | `financeiro` |
| **Admin** | Tudo (não deve operar dia-a-dia, só supervisionar) | `admin` |

---

## Calendário do Mês — TODA equipe

### 📅 Dia 1° — manhã

**O que acontece automaticamente** (cron 05h30):
- Sistema gera boletins **rascunho** pra cada posto de cada contrato ativo
- Você não precisa fazer nada — só conferir que rolou

**Como conferir:**
1. Login em `sistema.grupomontanasec.com`
2. Menu **Financeiro → Boletins**
3. Filtrar por competência atual
4. Deveria ter ~60 boletins (1 por posto)

Se aparecer **"0 boletins"**, avisar admin.

---

### 📅 Dias 2 a 4 — Operacional preenche

**Tarefa diária do operacional:**

1. Menu **Financeiro → Boletins**
2. Filtrar status = **rascunho**
3. Para cada boletim:
   - Clicar **Editar**
   - Aba **Colaboradores**: confirmar quem trabalhou no posto, faltas, horas extras
   - Aba **Glosas** (se houver): subtrair valor de período não-prestado
   - Salvar
4. Quando todos os dados estiverem certos: clicar **"Submeter pra prévia"**
   - Status muda de `rascunho` → `previa`
   - Financeiro vai ver na lista pra aprovar

**Atalho de teclado:** `Alt+B` abre Boletins

---

### 📅 Dia 5 — Financeiro aprova

**Tarefa do financeiro:**

1. Menu **Financeiro → Boletins**
2. Filtrar status = **previa**
3. Revisar cada boletim:
   - Valor bate com contrato?
   - Glosas justificadas?
   - Período correto?
4. Aprovar:
   - **1 a 1**: clicar **Aprovar** em cada
   - **Em lote**: botão **Aprovar Lote** (aprova todos da competência com valor > 0)

Status muda: `previa` → `aprovado`

---

### 📅 Dia 5 a 8 — Admin/Financeiro emite NFs

> ⚠ **Hoje (Maio/2026): emissão automática NÃO está ativa** porque falta certificado A1 + senha configurados. Veja `WEBISS_SETUP_EMISSAO.md`.
>
> **Workaround atual**: emitir NF manualmente no portal Palmas (https://palmasto.webiss.com.br/) e depois importar no sistema.

**Quando emissão estiver configurada:**

1. Menu **Financeiro → Boletins → Aba Aprovados**
2. Botão **Emitir NF** ao lado de cada
3. Sistema chama API WebISS (GerarNfse) automaticamente
4. NF emitida em ~5 segundos
5. Status muda: `aprovado` → `gerado` (NFs emitida e vinculada)

---

### 📅 Dia 10 a 30 — Conciliação

**Tarefa do financeiro:**

1. Menu **Financeiro → Conciliação**
2. Lista de extratos pendentes
3. Para cada crédito do banco:
   - Sistema sugere a NF/boletim correspondente
   - Confirmar match → status `CONCILIADO`
4. Cron **automático** roda toda noite (04h) e tenta vincular sozinho — só os complicados ficam pra revisão manual

---

## Sintomas de Problema (e o que fazer)

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| Lista de boletins aparece vazia dia 1° | Cron de geração não rodou | Avisar admin: `pm2 logs cron-boletins` |
| Boletim em rascunho com valor R$ 0,00 | Posto sem colaboradores cadastrados | Cadastrar colaboradores em **Pessoas → Posto X** |
| Não consigo aprovar prévia | Sem permissão (role = visualizador?) | Pedir admin pra trocar role |
| NF emitida no Palmas não aparece no sistema | Sync WebISS falhou ou pendente | Forçar import: **NFs → Importar do WebISS** |
| Crédito do banco sem match | Valor não bate com NF, ou cliente pagou parcial | Verificar histórico do extrato |

---

## Indicadores que você deve checar diariamente

No **Dashboard**, paineis principais:

- **🟡 Boletins em prévia (aguardando aprovação)** — financeiro deve zerar isso até dia 7
- **🟢 NFs emitidas no mês** — deve ser igual ao número de boletins aprovados (~60)
- **🔵 Conciliados** — meta 80% até dia 20

Se algum estiver **vermelho ou amarelo**, alguém da equipe está atrasado.

---

## Atalhos úteis

- `Alt+B` — Boletins
- `Alt+C` — Contratos
- `Alt+N` — Notas Fiscais
- `Alt+E` — Extratos
- `Alt+D` — Dashboard
- `Alt+P` — Prévias / Emissão
- `Alt+A` — Aditivos
- `Ctrl+/` — Buscar global (NF, contrato, cliente)
- `?` — Ver todos atalhos

---

## Quem chamar

- **Dúvida operacional** (como preencher) → financeiro chefe
- **Boletim com valor errado** → revisar contrato + aditivos
- **Sistema travou ou erro técnico** → Felipe (admin)
- **NF do Palmas não chega** → suporte WebISS Palmas (portal)
- **Conciliação não fecha** → Felipe (cron BB sync)

---

**Atualizado:** 2026-05-03
**Próxima revisão:** quando emissão automática WebISS for ativada
