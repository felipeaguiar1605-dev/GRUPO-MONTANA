# Revisão crítica — Painel de Faturamento

**Data:** 2026-05-15 · **Escopo:** Cadastro de Contrato → Boletins por Posto → Previsão NFS-e → Alíquotas/Códigos · **Status do doc:** rascunho para discussão com operação.

---

## 1. Sumário Executivo

O Painel de Faturamento atende o ciclo de receita, mas hoje carrega **dois pesos**:
(a) UI antiga de baixo custo (CRUD via `prompt()`, modais HTML inline de 200+ linhas) presa a um arquivo único de 3.220 linhas em [public/app-boletins.js](public/app-boletins.js); e
(b) **regra de negócio fiscal** que evoluiu rápido nos últimos 30 dias — Opção A (1 NF = 1 boletim), 27 colunas fiscais novas em `bol_contratos`, edição manual, prévia de retenções, base reduzida INSS — sem o formulário acompanhar.

Resultado prático: **operadora não consegue configurar contrato sozinha**. Cada novo cliente exige um seed por script ou ALTER no banco — o que vira gargalo de TI e ponto único de falha fiscal.

### Top 5 ofensores (por impacto na operadora)

| # | Ofensor | Onde | Por que dói |
|---|---|---|---|
| 1 | Modal de edição de contrato **não tem alíquotas/códigos fiscais** | [app-boletins.js:439-481](public/app-boletins.js#L439) vs schema [boletins.js:67-93](src/routes/boletins.js#L67) | 17 dos 27 campos novos só configuráveis por SQL/seed. Bloqueia operadora. |
| 2 | "Novo Contrato" abre **11 `prompt()` nativos do navegador** | [app-boletins.js:382-410](public/app-boletins.js#L382) | Sem voltar atrás, sem validação, sem opção de "salvar rascunho". 1 contrato = 11 popups. |
| 3 | Coluna "Postos" da listagem **sempre mostra `—`** | [app-boletins.js:97](public/app-boletins.js#L97) | Quebra de promessa: o cabeçalho diz "Postos" e o conteúdo é hardcoded em traço. |
| 4 | Modal de prévia NFS-e: **12 inputs de retenção** sem hierarquia visual + jargão fiscal sem tooltip | [app-boletins.js:2106-2132](public/app-boletins.js#L2106) | Camila trava: PIS/COFINS/INSS/IR/CSLL/Deduções cada um com % e R$ na mesma tela. |
| 5 | Conceito "boletim consolidado" vs "boletim por posto" **invisível no UI** | índices parciais em [boletins.js:148-163](src/routes/boletins.js#L148) | `posto_id IS NULL` vaza como "consolidado", sem glossário. Manutenção 🛠️ assume conhecimento de schema. |

### Backlog P0 (precisa cair antes da Reforma Tributária 2026)

| ID | Item | Esforço |
|----|------|---------|
| C-P0-01 | Substituir `prompt()` por modal único reutilizado entre Novo/Editar | M |
| C-P0-02 | Modal de contrato em abas (Identificação · Fiscal · Postos · Bancário) | G |
| C-P0-03 | Validações inline (CNPJ, percentuais, obrigatórios) | S |
| B-P0-01 | Glossário visível "consolidado vs por posto" no painel + tooltip nos botões | S |
| N-P0-01 | Reagrupar modal de prévia em blocos (Bruto · Tributação federal · ISS · Líquido) | M |
| F-P0-01 | Aba Fiscal expondo os 17 campos invisíveis hoje | G |

### Próximos passos depois deste doc

1. Operação valida com Camila (1h, screen-share)
2. P0 vira 4 PRs (`feat/painel-faturamento-contrato-p0`, `-boletim-p0`, `-previa-p0`, `-fiscal-p0`)
3. Cada PR sob feature flag (`ENABLE_NEW_PAINEL_FATURAMENTO=true`)
4. Rollout: admin → operadora → todos

---

## 2. Persona e jornada atual

### Camila — operadora financeira

- **Não é técnica**, não conhece schema, não fala "ISS Retido", fala "o cliente desconta".
- **Abre o sistema 2× por mês**: fechamento (dias 1-3) e emissão de NF (dias 4-10).
- **Tem ao lado**: planilha do contador (ground truth), os contratos físicos, e o WhatsApp do TI ("Felipe, sobe a alíquota da UFT pra 5%?").
- **Métrica que importa pra ela**: "todos os contratos do mês emitiram com valor batendo com a planilha do contador?"

### Jornada atual (mês fechado, dia 4)

```
                                                       ┌─ ponto de fricção
                                                       │
  abrir painel  →  ver lista de contratos  →  clicar 📄 Gerar
                                                       │
                                                       ▼
  ⚠ confusão: "Gerar" do consolidado ou "🧩 Gerar (N postos)"?
                                                       │
                                                       ▼
  gera boletim(s) em rascunho  →  abrir cada um  →  ✏️ Editar
                                                       │
                                                       ▼
  ⚠ valores não batem com planilha do contador?
       → glosa? acréscimo? override?
       → mas alíquota ISS está em outra tela (Prévia, só depois de aprovar)
                                                       │
                                                       ▼
  ✅ Aprovar  →  🚀 Emitir  →  Prévia NFS-e abre
                                                       │
                                                       ▼
  ⚠ 12 inputs de retenção: %  e  R$ pra cada um
       → "o que é 'Deduções'? é vale alimentação?"
       → "ISS Retido o UNITINS retém ou eu retenho?"
       → "Por que a base do INSS está diferente do bruto?"
                                                       │
                                                       ▼
  manda print pro contador  →  conferido  →  🚀 Emitir definitivo
                                                       │
                                                       ▼
  ⚠ erro de validação WebISS volta como string crua
       → "Falha SOAP: cstAuth" sem indicação do que fazer
```

Pontos de fricção marcados ⚠️: **5 pontos em uma jornada de 8 passos** — sinal claro de que a UI fala "linguagem do programador" e não da operadora.

### Jornada-alvo (após P0)

```
abrir painel  →  filtrar mês  →  ver semáforo verde/amarelo/vermelho por contrato
                  │
                  ▼
clicar contrato amarelo  →  modal aponta "falta aprovar 2/5 postos"
                  │
                  ▼
revisar valores agrupados (Bruto · Retenções · Líquido)
                  │
                  ▼
emitir em lote os verdes  →  resolver caso a caso os amarelos
```

---

## 3. Etapa 1 — Cadastro de Contrato

### 3.1 Estado atual

**Listagem** ([app-boletins.js:65-118](public/app-boletins.js#L65)) — tabela simples, 6 colunas:

```
Nome  |  Contratante  |  Nº Contrato  |  Postos  |  Status  |  Ações
─────────────────────────────────────────────────────────────────────
UFT   | Univ. Fed. TO |   16/2025     |    —     |  Ativo   | 📄 ✏️ 🗑️
UNITINS| Univ. Tocantins|   09/2022     |    —     |  Ativo   | 📄 ✏️ 🗑️
DETRAN| Estado do TO  |   45/2024     |    —     | Inativo  | 📄 ✏️ 🗑️
```

- **Sem busca, sem filtro, sem paginação** — carrega todos via `GET /api/boletins/contratos` ([app-boletins.js:51](public/app-boletins.js#L51)).
- KPI no topo: "Contratos Cadastrados / Ativos" — ok.
- "📄 Gerar" da linha vai pra um painel separado (`bolGerarBoletim`) — **fluxo paralelo** ao novo painel multi-mês.

**Criação (`bolNovoContrato`)** ([app-boletins.js:382-410](public/app-boletins.js#L382)) — sequência de **11 `prompt()` nativos**:

```js
const nome = prompt('Nome do contrato (ex: UFT, UNITINS):');
const contratante = prompt('Nome do contratante:');
const numero = prompt('Número do contrato:');
// ... 8 mais (processo, pregão, descrição, escala, razão social,
//          CNPJ, endereço, email, telefone)
```

Se a operadora aperta ESC ou Cancelar em qualquer um, **perde tudo**. Nenhuma validação de CNPJ, email, percentual. Sem opção de "salvar parcial" e voltar depois.

**Edição (`bolEditarContrato`)** ([app-boletins.js:424-483](public/app-boletins.js#L424)) — modal HTML inline com 14 campos divididos em 3 blocos visuais:

```
┌─ ✏️ Editar Contrato de Boletim ─────────────────────┐
│ Nome              │ Nº Contrato                     │
│ Contratante (Razão Social do Órgão)                 │
│ Processo          │ Pregão                          │
│ Descrição do Serviço                                │
│ Escala                                              │
│                                                     │
│ 🔗 Vinculação Financeira (necessário p/ NFS-e)      │
│ Referência do Contrato Financeiro                   │
│ CNPJ do Tomador (hint: "18 caracteres c/ máscara")  │
│ Orgão/Campo auxiliar                                │
│                                                     │
│ Dados da Empresa Emitente                           │
│ Razão Social      │ CNPJ                            │
│ Endereço                                            │
│ E-mail            │ Telefone                        │
│                                                     │
│                          [Cancelar]  [💾 Salvar]    │
└─────────────────────────────────────────────────────┘
```

Comparado com o schema atual (17 colunas a mais existem mas estão **invisíveis**):

| Campo no schema | No form? |
|---|:---:|
| `nome`, `contratante`, `numero_contrato`, `processo`, `pregao`, `descricao_servico`, `escala` | ✅ |
| `empresa_razao`, `empresa_cnpj`, `empresa_endereco`, `empresa_email`, `empresa_telefone` | ✅ |
| `contrato_ref`, `orgao`, `insc_municipal` | ✅ |
| `item_lista_servico` | ❌ |
| `codigo_tributacao_municipal` | ❌ |
| `codigo_cnae` | ❌ |
| `codigo_nbs` | ❌ |
| `aliquota_iss_padrao` | ❌ |
| `iss_retido_padrao` | ❌ |
| `optante_simples_nacional` | ❌ |
| `incentivo_fiscal` | ❌ |
| `ciclo_dia_inicio` | ❌ |
| `dados_bancarios` | ❌ |
| `template_discriminacao` | ❌ |
| `inss_aliquota` | ❌ |
| `inss_base_reduzida` | ❌ |
| `irrf_aliquota`, `pis_aliquota`, `cofins_aliquota`, `csll_aliquota` | ❌ |
| `retencoes_padrao` (JSON) | ❌ |

Fonte do schema: [src/routes/boletins.js:67-93](src/routes/boletins.js#L67).

**Detalhamento do contrato** ([app-boletins.js:188-266](public/app-boletins.js#L188)) — após clicar no nome, abre tela read-only mostrando: contratante, nº, processo, pregão, escala, empresa. Postos listados como cards. Cards de posto mostram itens em tabela. **Não há card "Configuração Fiscal" nem "Dados Bancários"**.

### 3.2 Fraquezas catalogadas

| ID | Fraqueza | Pri | Onde | Como reproduzir |
|---|---|:---:|---|---|
| F1.1 | "Novo Contrato" usa 11 `prompt()` em série, sem voltar atrás | **P0** | [app-boletins.js:382-410](public/app-boletins.js#L382) | Clicar "+ Novo Contrato" no painel |
| F1.2 | Modal de edição esconde 17 campos fiscais do schema | **P0** | [app-boletins.js:439-481](public/app-boletins.js#L439) | Clicar ✏️ em qualquer contrato, contar campos |
| F1.3 | Hint enganoso: "CNPJ do Tomador — 18 caracteres c/ máscara" (CNPJ tem 14, ou 18 com `.`/`/`/`-`) | P1 | [app-boletins.js:458](public/app-boletins.js#L458) | Mesmo modal de edição |
| F1.4 | Key `insc_municipal` exibida como "CNPJ do Tomador" — nomenclatura herdada do WebISS vaza pro operador | P1 | [app-boletins.js:458](public/app-boletins.js#L458) | Mesmo |
| F1.5 | Coluna "Postos" da listagem hardcoded como `—` | P1 | [app-boletins.js:97](public/app-boletins.js#L97) | Abrir painel; ver tabela |
| F1.6 | Sem busca, filtro por status, paginação | P2 | [app-boletins.js:65-107](public/app-boletins.js#L65) | Com 14+ contratos ativos, achar um vira rolagem |
| F1.7 | Detalhamento read-only não mostra alíquotas/códigos/dados bancários | P1 | [app-boletins.js:200-265](public/app-boletins.js#L200) | Clicar em "UFT" → vê só dados administrativos |
| F1.8 | Botões 📄 Gerar (linha) e Painel Faturamento mensal (outro fluxo) coexistem sem clareza de qual usar quando | P1 | [app-boletins.js:100](public/app-boletins.js#L100) vs painel | Operadora pergunta: "qual gera certo?" |
| F1.9 | Sem validação inline (CNPJ válido? % entre 0 e 100? campos obrigatórios marcados?) | P0 | [app-boletins.js:485-522](public/app-boletins.js#L485) | Salvar contrato com CNPJ inválido — backend aceita |
| F1.10 | Sem auditoria visível ("quem editou e quando") | P2 | schema tem `updated_at` mas UI não mostra | — |

### 3.3 Wireframe ASCII proposto

**Listagem (substitui [app-boletins.js:65-118](public/app-boletins.js#L65))**:

```
┌─ Contratos de Faturamento ────────────────────────────────────────┐
│  [🔍 Buscar contrato...]   Status: [ Ativos ▾]   Mês: [05/2026 ▾] │
│                                            [ + Novo contrato ]     │
│ ─────────────────────────────────────────────────────────────────  │
│ Nome      │ Contratante       │ Nº       │ Postos │ Status │       │
│ UFT       │ Univ. Fed. TO     │ 16/2025  │  5     │ ●      │ [✏️]  │
│ UNITINS   │ Univ. Tocantins   │ 09/2022  │  3     │ ●      │ [✏️]  │
│ DETRAN    │ Estado do TO      │ 45/2024  │  1     │ ○      │ [✏️]  │
│ SEDUC     │ Secret. Educação  │ 12/2025  │  4     │ ⚠ falta│ [✏️]  │
│                                                  │ config  │       │
│                                                  │ fiscal  │       │
│ ─────────────────────────────────────────────────────────────────  │
│  4 contratos · 3 ativos · 1 com configuração fiscal incompleta     │
└────────────────────────────────────────────────────────────────────┘
```

- Coluna "Postos" funcional (contar `bol_postos`).
- Status "⚠ falta config fiscal" quando `aliquota_iss_padrao IS NULL` ou `item_lista_servico IS NULL`.
- Único botão de ação por linha (✏️ abre modal completo). "Gerar" sai daqui — fica no painel mensal.

**Modal de edição em abas (substitui [app-boletins.js:439-481](public/app-boletins.js#L439))**:

```
┌─ Editar contrato — UFT 16/2025 ────────────────────────── [✕] ┐
│ ┌───────────────┬───────────┬─────────┬────────────┬────────┐ │
│ │ Identificação │ ● Fiscal  │ Postos  │ Bancário   │ Hist.  │ │
│ └───────────────┴───────────┴─────────┴────────────┴────────┘ │
│                                                                │
│   ─── Identificação ──────────────────────────────────────     │
│   Nome*           [UFT                                  ]     │
│   Contratante*    [Universidade Federal do Tocantins    ]     │
│   Nº contrato*    [16/2025          ]                          │
│   Processo        [23101.xxxxxx/2025-xx]                      │
│   Pregão          [009/2022]                                  │
│   Descrição       [Vigilância armada e desarmada — campi …]   │
│   Escala          [12x36 ▾]                                   │
│                                                                │
│   ─── Vinculação NFS-e ─────────────────────────────────       │
│   Razão social tomador*   [Universidade Federal do TO   ]     │
│   CNPJ tomador*           [00.000.000/0000-00] [✓ válido]     │
│   Inscrição municipal     [237319]                            │
│   Referência financeira   [UFT 16/2025] ⓘ deve bater com a    │
│                            tabela `contratos`                  │
│                                                                │
│        [Cancelar]    [Salvar e ir p/ Fiscal →]                │
└────────────────────────────────────────────────────────────────┘
```

Demais abas detalhadas nas seções 5 (Fiscal) e abaixo. Princípios:
- **Asteriscos** marcam obrigatórios.
- **Status ✓/⚠** ao lado do CNPJ (validação inline).
- **Ícone ⓘ** com tooltip explicando jargão técnico.
- **Botão "Salvar e ir p/ próxima aba"** guia o fluxo de cadastro de um contrato novo (substitui prompt()s).

### 3.4 Backlog vinculado

| ID | Item | Pri | Esforço | Critério de aceite |
|----|------|:---:|:---:|---|
| C-P0-01 | Form único reutilizado por Novo e Editar | P0 | M | `bolNovoContrato` aciona o mesmo modal de `bolEditarContrato` com state vazio |
| C-P0-02 | Tabs Identificação · Fiscal · Postos · Bancário no modal | P0 | G | Abas implementadas com persistência de tab atual em localStorage |
| C-P0-03 | Validações inline: CNPJ (regex+DV), %, obrigatórios | P0 | S | Salvar bloqueado se CNPJ inválido; campos `*` com asterisco vermelho |
| C-P1-01 | Coluna "Postos" funcional (`COUNT bol_postos`) | P1 | S | Listagem mostra número de postos por contrato |
| C-P1-02 | Renomear "CNPJ do Tomador" para "CNPJ do tomador" + corrigir hint; separar `insc_municipal` em coluna própria | P1 | S | Hint correto: "14 dígitos (000.000.000/0000-00)" |
| C-P1-03 | Detalhamento mostra cards "Configuração Fiscal" e "Dados Bancários" | P1 | M | Após clicar contrato, ver alíquotas + códigos sem precisar editar |
| C-P1-04 | Unificar "📄 Gerar" da linha com Painel mensal (botão "Ir para faturamento de YYYY-MM") | P1 | S | Apenas um caminho pra gerar boletins |
| C-P2-01 | Busca, filtro por status, paginação | P2 | M | Input de busca filtra cliente-side; >20 contratos pagina |
| C-P2-02 | Histórico de edições (audit log) na aba "Hist." | P2 | M | Quem alterou alíquota, quando, valor anterior |

---

## 4. Etapa 2 — Boletins por Posto

### 4.1 Estado atual

Após PR #13 (Opção A — 1 NF = 1 boletim) o sistema passou a aceitar **dois modos coexistentes**:

| Modo | `posto_id` | Índice | Quando aparece |
|------|:---:|---|---|
| Consolidado (legado) | `NULL` | `idx_bol_boletins_contrato_comp_null` | Contratos antigos sem postos cadastrados (Assessoria, Mustang interno) |
| Por posto (Opção A) | `NOT NULL` | `idx_bol_boletins_contrato_posto_comp` | Contratos novos com `bol_postos` (UFT, UNITINS) |

Fonte: [src/routes/boletins.js:144-163](src/routes/boletins.js#L144).

**Geração de boletins** — dois caminhos paralelos:

1. **`POST /api/boletins/gerar-boletim`** (legado, 1 consolidado por contrato/mês) — disparado de [app-boletins.js:2308](public/app-boletins.js#L2308) via "📄 Gerar" da linha de contrato.
2. **`POST /api/boletins/gerar-boletim-postos`** (Opção A, N boletins por contrato/mês) — disparado via 🧩 "Gerar (N postos)" no painel mensal.

**Edição de boletim** (`painelPostoEditar`) ([app-boletins.js:1780-1969](public/app-boletins.js#L1780)) — modal grande (max-width 900px), header laranja, 3 blocos:

```
┌─ ✏️ Editar Boletim #1234 ────────────────────── [×] ┐
│ UFT · Campus Palmas — PALMAS/TO · Competência 2026-04 │
├──────────────────────────────────────────────────────┤
│ ⚠ Este boletim já tem itens customizados (override)  │ ← se houver
│                                                       │
│ 📋 Itens do boletim                 [+ Adicionar item]│
│ ┌──────────────────────┬────┬─────────┬──────────┬─┐ │
│ │ Descrição            │Qtd │ Vl. Un. │ Subtotal │×│ │
│ │ [Vigia Diurno 12x36 ]│[2 ]│[5400.00]│ R$10.800 │×│ │
│ │ [Vigia Noturno 12x36]│[2 ]│[6200.00]│ R$12.400 │×│ │
│ └──────────────────────┴────┴─────────┴──────────┴─┘ │
│                              Valor Base: R$ 23.200,00 │
│                                                       │
│ Glosas (R$)    [   0.00 ]    Acréscimos (R$) [ 0.00 ] │
│                                                       │
│ ┌─ Valor Final do Boletim: ───── R$ 23.200,00 ─────┐ │
│                                                       │
│ Discriminação (em branco = usa template do contrato): │
│ [textarea 4 linhas                              ]    │
│                                                       │
│              [Cancelar]    [💾 Salvar alterações]     │
└──────────────────────────────────────────────────────┘
```

Comportamento [app-boletins.js:1948-1969](public/app-boletins.js#L1948): a cada `oninput`, `_gbeRecalcular` percorre os itens, soma, aplica glosas/acréscimos e atualiza Valor Base + Valor Final.

**Cadastro de posto** (`bolNovoPosto`) ([app-boletins.js:524-541](public/app-boletins.js#L524)) — **5 `prompt()` em série**:

```js
const campus_key = prompt('Chave do campus (ex: PALMAS):');
const campus_nome = prompt('Nome completo do campus:');
const municipio = prompt('Município (ex: PALMAS/TO):');
const descricao_posto = prompt('Descrição do posto:');
const label_resumo = prompt('Label no resumo:', campus_key);
```

Cinco colunas-chave do `bol_postos` ficam **invisíveis** (vão por SQL):
- `codigo_municipio_ibge` (necessário pra NFS-e: município do serviço)
- `aliquota_iss_local` (override do ISS por posto)
- `deducao_vale_alimentacao` (base reduzida INSS — UFT)
- `deducao_materiais` (base reduzida INSS — UFT)
- `mostrar_colaboradores` (boolean, default TRUE)

Fonte: [boletins.js:98-108](src/routes/boletins.js#L98).

**Dedup / duplicatas** ([app-boletins.js:2389-2500](public/app-boletins.js#L2389)) — botão 🛠️ Manutenção dispara 5 passos automáticos. O modal de listagem de duplicatas mostra grupos `(contrato_id, competencia)` mas **não explica visualmente** se são consolidados ou por posto.

### 4.2 Fraquezas catalogadas

| ID | Fraqueza | Pri | Onde | Como reproduzir |
|---|---|:---:|---|---|
| F2.1 | Conceito "consolidado vs por posto" sem glossário no UI; usuária não sabe quando aparece um vs outro | **P0** | painel inteiro; índice [boletins.js:148](src/routes/boletins.js#L148) | Abrir contrato com postos e sem postos lado a lado |
| F2.2 | Dois botões "Gerar" coexistindo (📄 linha legado + 🧩 painel mensal) sem distinção visual de qual usar | **P0** | [app-boletins.js:100](public/app-boletins.js#L100) e [app-boletins.js:1549](public/app-boletins.js#L1549) | Comparar contrato UFT (tem ambos) |
| F2.3 | Cadastro de posto via 5 `prompt()`, sem voltar atrás | P1 | [app-boletins.js:524-541](public/app-boletins.js#L524) | Detalhe do contrato → "+ Novo Posto" |
| F2.4 | Modal de edição esconde 5 colunas do `bol_postos` (IBGE, ISS local, deduções, mostrar_colaboradores) | **P0** | [app-boletins.js:543-560](public/app-boletins.js#L543) | Editar posto — pergunta só `campus_key` |
| F2.5 | "Valor Base" e "Valor do Boletim" coexistem na listagem; usuária não sabe qual é o "certo" | P2 | painel mensal | `bol_contratos.valor_mensal_bruto` ≠ Σ itens atuais |
| F2.6 | Edição não mostra alíquotas/retenções — só aparecem em modal de prévia separado, após aprovar | P1 | [app-boletins.js:1780-1969](public/app-boletins.js#L1780) | Editar boletim → não vê INSS/ISS |
| F2.7 | Glosas/Acréscimos sem motivo/descrição obrigatórios (`bol_boletim_glosas` aceita `motivo` mas UI agrupa em campo único) | P1 | [app-boletins.js:1860-1866](public/app-boletins.js#L1860) vs schema [boletins.js:131-142](src/routes/boletins.js#L131) | Editar boletim — glosa R$ 500 sem explicação |
| F2.8 | Aviso de override (`tem_override`) é informativo mas não permite **reverter** ao template | P1 | [app-boletins.js:1824-1828](public/app-boletins.js#L1824) | Editar boletim com override; sem botão "voltar ao template" |
| F2.9 | Status do boletim (rascunho/aprovado/emitido) não tem badge no modal de edição | P2 | header laranja sem indicador | Editar boletim já emitido — pode salvar mudança que diverge da NF? |
| F2.10 | Manutenção 🛠️ ("dedup, criar fantasmas, stats") roda 5 ações sem explicar o que cada uma faz | P1 | [app-boletins.js:1409](public/app-boletins.js#L1409) | Clicar 🛠️ — modal mostra resultado, mas não pergunta antes |

### 4.3 Wireframe ASCII proposto

**Glossário fixo no topo do painel mensal** (resolve F2.1):

```
┌─ Faturamento — Maio/2026 ────────────────────────────────────┐
│ ⓘ Como funciona o faturamento:                                │
│   • Cada contrato com postos cadastrados gera 1 boletim por  │
│     posto/mês (Opção A — 1 NF por boletim).                  │
│   • Contratos sem postos geram 1 boletim consolidado/mês.    │
│   • [Saiba mais ▾]                                           │
│ ────────────────────────────────────────────────────────────  │
│ Contrato  │ Modelo          │ Boletins │ Status emissão       │
│ UFT       │ ●●●●● 5 postos  │ 5/5 ✓   │ 3 emitidos · 2 pend. │
│ UNITINS   │ ●●● 3 postos    │ 3/3 ✓   │ 3 emitidos           │
│ DETRAN    │ ◯ consolidado   │ 1/1 ✓   │ 1 emitido            │
│ SEDUC     │ ●●●● 4 postos   │ 0/4 ⚠   │ Falta gerar          │
│                                                                │
│           [ 🧩 Gerar pendentes ]   [ 🛠️ Manutenção ]           │
└────────────────────────────────────────────────────────────────┘
```

- Coluna "Modelo" deixa explícito: pontinhos coloridos = postos; ◯ = consolidado.
- "Gerar" único — backend decide chamar `gerar-boletim` ou `gerar-boletim-postos` baseado em `bol_postos.count`.
- Botão 🛠️ Manutenção abre modal **explicando cada ação** com checkboxes opt-in.

**Modal de edição de boletim — com fiscal embutido** (resolve F2.6):

```
┌─ Boletim #1234 — UFT · Campus Palmas · 2026-04 ─── [Rascunho ▾] ┐
│ ┌─────────┬──────────┬───────────┬──────────┐                    │
│ │ Itens   │ ● Fiscal │ Retenções │ Discrim. │                    │
│ └─────────┴──────────┴───────────┴──────────┘                    │
│                                                                    │
│ ─── Configuração fiscal aplicada a este boletim ─────────────     │
│                                                                    │
│   Alíquota ISS    [5.00 %]  ⓘ herdada do contrato (5.00%)        │
│   ISS Retido      [☑]       ⓘ tomador desconta antes de pagar    │
│   Item LC 116     [07.17 — Vigilância ▾]                          │
│                                                                    │
│   ─── Base INSS ────────────────────────────────────────────      │
│   Modelo de base  ● Bruto    ○ Reduzida (vale + materiais)        │
│   Vale alimentação        R$ [ 1.234,56 ]                         │
│   Materiais               R$ [   234,00 ]                         │
│   ⓘ Aplicável a contratos UFT — herdado de bol_postos             │
│                                                                    │
│       [Cancelar]   [💾 Salvar]   [🔄 Voltar ao template]          │
└────────────────────────────────────────────────────────────────────┘
```

- Cada campo mostra a **fonte do valor** (herdado/sobrescrito) — resolve F3.2 também.
- "Voltar ao template" limpa `itens_override` e reaplica `bol_itens` do contrato (resolve F2.8).
- Status no header como dropdown muda etapa do boletim com confirmação (resolve F2.9).

**Cadastro/edição de posto (resolve F2.3 e F2.4)**:

```
┌─ Novo Posto — UFT ──────────────────────────────────── [✕] ┐
│ ┌─────────────┬──────────┐                                  │
│ │Identificação│● Fiscal  │                                  │
│ └─────────────┴──────────┘                                  │
│                                                              │
│   Chave do campus*   [PALMAS]                ⓘ ex: PALMAS    │
│   Nome do campus*    [Campus Palmas]                         │
│   Município*         [PALMAS/TO]                             │
│   Cód. IBGE          [1721000]   [↻ buscar pelo nome]        │
│   Descrição          [Vigilância armada 24h — Bloco A]      │
│   Label resumo       [PALMAS]                                │
│                                                              │
│   Mostrar colaboradores na NF?   [☑] ⓘ desligue para         │
│                                       vigilância sigilosa    │
│                                                              │
│        [Cancelar]    [Salvar e ir p/ Fiscal →]              │
└──────────────────────────────────────────────────────────────┘
```

Aba "Fiscal" do posto: `aliquota_iss_local` (override do contrato), `deducao_vale_alimentacao`, `deducao_materiais`.

### 4.4 Backlog vinculado

| ID | Item | Pri | Esforço | Critério de aceite |
|----|------|:---:|:---:|---|
| B-P0-01 | Glossário "consolidado vs por posto" no topo do painel mensal | P0 | S | Box informativo expansível; texto revisado por Camila |
| B-P0-02 | Unificar geração: 1 botão "Gerar pendentes" que decide modelo | P0 | M | Backend escolhe `gerar-boletim` ou `gerar-boletim-postos` conforme `COUNT(postos)` |
| B-P0-03 | Form de posto com modal de 2 abas (substitui `prompt()`) | P0 | M | Mesmo modal reutilizado por Novo/Editar |
| B-P0-04 | Modal de edição de boletim com aba Fiscal embutida | P0 | G | Alíquota ISS, ISS retido, base INSS editáveis sem precisar abrir Prévia |
| B-P1-01 | Botão "🔄 Voltar ao template" no modal de edição | P1 | S | Limpa `itens_override` e reaplica `bol_itens`; confirma antes |
| B-P1-02 | Glosas detalhadas (motivo + valor) usando `bol_boletim_glosas` | P1 | M | UI permite N linhas de glosa, cada uma com motivo |
| B-P1-03 | Status do boletim como badge clicável no header do modal | P1 | S | Rascunho/Aprovado/Emitido com cor; troca confirma destrutivo |
| B-P1-04 | Modal de Manutenção 🛠️ explica cada uma das 5 ações com checkbox opt-in | P1 | M | Operadora decide se quer "criar fantasmas" ou só "dedup" |
| B-P2-01 | Definir e usar uma única "Valor Boletim" — descontinuar `valor_mensal_bruto` no UI | P2 | S | Listagem mensal só mostra Σ itens atuais |

---

## 5. Etapa 3 — Previsão NFS-e (modal de prévia)

### 5.1 Estado atual

O modal abre quando a operadora clica "🚀 Emitir" num boletim aprovado ([app-boletins.js:2045-2166](public/app-boletins.js#L2045)). Endpoint backend: `GET /api/boletins/:id/preview-nfse` ([boletins.js:1114](src/routes/boletins.js#L1114)).

Layout atual (largura 920px, altura ~660px):

```
┌─ 🧾 Prévia NFS-e — antes de emitir ─────────────────── [✕] ┐
│ ⚠ Boletim em status RASCUNHO — só é possível emitir após    │  ← às vezes
│   aprovação. Você está vendo a prévia somente p/ conferência.│
│                                                              │
│ ┌────────── 📋 RPS ──────────┐ ┌──── 👤 Tomador ──────────┐  │
│ │ Número: 12345              │ │ Razão: UFT               │  │
│ │ Série:  RPS                │ │ CNPJ:  00.000.000/0000-00│  │
│ │ Emissão: 2026-05-15        │ │                          │  │
│ │ Competência: 2026-04       │ │                          │  │
│ │ Item lista serv.: 07.17    │ │                          │  │
│ └────────────────────────────┘ └──────────────────────────┘  │
│                                                              │
│ Discriminação dos Serviços                                  │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ Prestação de serviço de vigilância armada e desarmada    ││
│ │ no Campus Palmas da UFT, conforme Pregão 009/2022,       ││
│ │ Processo 23101.xxxxxx/2025-xx. Período: 05/04 a 04/05.   ││
│ │ Dados bancários: BB 1234-5 / 6789-0 — Montana SEC LTDA   ││
│ └──────────────────────────────────────────────────────────┘│
│                                                              │
│ ┌─ ⚙️ Retenções ─────── editado nesta sessão / ✓ padrão ──┐│
│ │  PIS              COFINS              INSS               ││
│ │  [0.65%][R$ 50.00] [3.00%][R$230.00] [11%][R$1078.00]   ││
│ │                                                          ││
│ │  IR               CSLL                Deduções           ││
│ │  [1.20%][R$ 92.00] [1.00%][R$77.00]  [0%][R$ 0.00]      ││
│ │                                                          ││
│ │  ☐ ISS Retido    Alíquota ISS: [5.00]% · decimal: [0.05]││
│ └──────────────────────────────────────────────────────────┘│
│                                                              │
│ ┌─ BRUTO ────┐ ┌─ RETENÇÕES ─┐ ┌─ LÍQUIDO A RECEBER ────┐  │
│ │ R$ 7.700,00│ │   R$ 1.527  │ │     R$ 6.173,00       │  │
│ └────────────┘ └─────────────┘ └────────────────────────┘  │
│ ISS calculado: R$ 385,00 (somado ao retido apenas se        │
│ ISS Retido marcado)                                         │
│                                                              │
│              [Fechar]   [🚀 Emitir NFS-e definitivamente]   │
└──────────────────────────────────────────────────────────────┘
```

Aspectos **bem feitos** (que devem ser preservados):
- Três cards-resumo Bruto/Retenções/Líquido com cores semânticas (cinza/vermelho/verde).
- Aviso amarelo quando boletim não aprovado.
- Botão de emitir bloqueado fora do estado correto, com `title` explicativo.
- Cada retenção tem dual input `%` ↔ `R$` sincronizado em tempo real ([app-boletins.js:2168-2206](public/app-boletins.js#L2168)).
- Confirm() final reforçando "operação irreversível".

### 5.2 Fraquezas catalogadas

| ID | Fraqueza | Pri | Onde | Como reproduzir |
|---|---|:---:|---|---|
| F3.1 | **12 inputs de retenção** numa grid 3×2 sem hierarquia entre "incidência federal" vs "ISS municipal" vs "outros" | **P0** | [app-boletins.js:2106-2113](public/app-boletins.js#L2106) | Abrir prévia de boletim qualquer |
| F3.2 | "Fonte das retenções" (override/padrão/zerado) em fonte 10px no canto direito — quase invisível | **P0** | [app-boletins.js:2104](public/app-boletins.js#L2104) | Mesmo modal — ler texto cinza no header de Retenções |
| F3.3 | Alíquota ISS tem **dois inputs** (% + decimal 0.05) lado a lado — UX duplica esforço sem benefício pro operador comum | P1 | [app-boletins.js:2118-2131](public/app-boletins.js#L2118) | Editar % vs editar decimal — ambos sincronizam |
| F3.4 | Não há tooltip explicando o que é cada retenção, o que é "ISS Retido", quando é base reduzida | **P0** | [app-boletins.js:2107-2117](public/app-boletins.js#L2107) | Hover sobre PIS — sem ajuda |
| F3.5 | "Item lista serv." aparece como string crua (`07.17`) sem nome (`Vigilância e segurança`) | P1 | [app-boletins.js:2085](public/app-boletins.js#L2085) | Operadora não sabe se 07.17 é correto pro contrato |
| F3.6 | Alíquota ISS editada aqui **não persiste no contrato** — efeito-surpresa quando próximo boletim vem com valor antigo | P1 | endpoint emite NF sem `UPDATE bol_contratos` | Editar % aqui → próximo mês volta ao default |
| F3.7 | Discriminação read-only no modal — pra editar precisa voltar ao boletim | P1 | [app-boletins.js:2097](public/app-boletins.js#L2097) | Discriminação errada? Fechar → editar boletim → reabrir prévia |
| F3.8 | "Deduções" como input genérico sem indicação se é vale alimentação, materiais, descontos legais | P1 | [app-boletins.js:2112](public/app-boletins.js#L2112) | Operadora pergunta: "deduções de quê?" |
| F3.9 | Erro WebISS volta como string crua de SOAP ("Falha SOAP: cstAuth invalido") | P1 | [app-boletins.js:2275](public/app-boletins.js#L2275) | Tentar emitir com cert expirado |
| F3.10 | Botão "Emitir" abre `confirm()` nativo do navegador — em PWA mobile o estilo destoa | P2 | [app-boletins.js:2248](public/app-boletins.js#L2248) | Clicar emitir em mobile |
| F3.11 | Sem **comparação com boletim anterior** ("mês passado deu R$ 7.500, hoje R$ 7.700") | P2 | painel atual | Operadora cruza com planilha manualmente |
| F3.12 | Modal não mostra **breakdown do ISS** (base × alíquota = valor) — só mostra valor final | P2 | [app-boletins.js:2150](public/app-boletins.js#L2150) | Auditor pergunta: "qual base do ISS?" — operadora não sabe |

### 5.3 Wireframe ASCII proposto

Reagrupar em **3 blocos vertical-fluído** (Bruto · Tributação · Líquido), com fonte da retenção visível e tooltips:

```
┌─ Prévia NFS-e — UFT · Campus Palmas · 2026-04 ────────── [✕] ┐
│                                                                │
│   📋 Dados da nota                                            │
│   Item LC 116    [07.17 — Vigilância e segurança ▾]           │
│   Tomador        Univ. Fed. TO · 00.000.000/0000-00          │
│   Competência    Abril/2026 · período 05/04 → 04/05           │
│                                                                │
│ ╔═══════════════ 1. VALOR BRUTO DO SERVIÇO ═══════════════╗  │
│ ║                                                           ║  │
│ ║   Soma dos itens do boletim    R$ 7.700,00              ║  │
│ ║   [✏️ Editar boletim →]                                  ║  │
│ ║                                                           ║  │
│ ║   📅 Mês anterior:  R$ 7.500,00  (+2,7%)                ║  │
│ ╚═══════════════════════════════════════════════════════════╝  │
│                                                                │
│ ╔═══════════════ 2. TRIBUTAÇÃO FEDERAL ════════════════════╗  │
│ ║   ⓘ fonte: padrão do contrato UFT (clique p/ override)   ║  │
│ ║                                                           ║  │
│ ║   PIS              0,65%  ×  R$ 7.700  =  R$   50,05    ║  │
│ ║   COFINS           3,00%  ×  R$ 7.700  =  R$  231,00    ║  │
│ ║   IRRF             1,20%  ×  R$ 7.700  =  R$   92,40    ║  │
│ ║   CSLL             1,00%  ×  R$ 7.700  =  R$   77,00    ║  │
│ ║                                                           ║  │
│ ║   INSS  base reduzida ⓘ                                  ║  │
│ ║     Bruto                 R$ 7.700,00                    ║  │
│ ║     − Vale alimentação    R$   234,00                    ║  │
│ ║     − Materiais           R$   100,00                    ║  │
│ ║     = Base INSS           R$ 7.366,00                    ║  │
│ ║                                                           ║  │
│ ║   INSS            11,00%  ×  R$ 7.366  =  R$  810,26    ║  │
│ ║                                                           ║  │
│ ║                   Subtotal federal:        R$ 1.260,71   ║  │
│ ╚═══════════════════════════════════════════════════════════╝  │
│                                                                │
│ ╔═══════════════ 3. ISS MUNICIPAL ════════════════════════╗  │
│ ║   Alíquota ISS  [5,00%]  ⓘ Palmas/TO, item 07.17        ║  │
│ ║                                                          ║  │
│ ║   [☑] Tomador retém o ISS                               ║  │
│ ║       ⓘ UFT desconta antes de pagar — informe ao        ║  │
│ ║         contador na DCTF                                ║  │
│ ║                                                          ║  │
│ ║   ISS  5,00%  ×  R$ 7.700  =  R$ 385,00                 ║  │
│ ╚══════════════════════════════════════════════════════════╝  │
│                                                                │
│ ╔═══════════════ 4. LÍQUIDO A RECEBER ════════════════════╗  │
│ ║   Bruto                  R$ 7.700,00                     ║  │
│ ║   − Federal              R$ 1.260,71                     ║  │
│ ║   − ISS (retido)         R$   385,00                     ║  │
│ ║   = Líquido              R$ 6.054,29                     ║  │
│ ╚══════════════════════════════════════════════════════════╝  │
│                                                                │
│   [✏️ Editar discriminação]   [↻ Restaurar padrão do contrato]│
│                                                                │
│                       [Cancelar]   [🚀 Emitir NFS-e]          │
└────────────────────────────────────────────────────────────────┘
```

Princípios:
- **Cálculos transparentes** (mostra base × alíquota = valor) — resolve F3.12.
- **Fonte do valor** ("padrão do contrato" / "editado") em texto destacado, não 10px — resolve F3.2.
- **Tooltips ⓘ** em cada termo fiscal — resolve F3.4 e F3.8.
- **Base reduzida visualmente quebrada** (bruto − deduções = base) — resolve clareza da base INSS.
- **Alíquota única em %** (decimal sumiu) — resolve F3.3.
- **Comparativo com mês anterior** — resolve F3.11.
- Override de alíquota tem checkbox "salvar como padrão do contrato" — resolve F3.6.
- Erro WebISS traduzido pra português com sugestão de ação — resolve F3.9.

### 5.4 Backlog vinculado

| ID | Item | Pri | Esforço | Critério de aceite |
|----|------|:---:|:---:|---|
| N-P0-01 | Reagrupar modal em 4 blocos (Dados · Bruto · Tributação · Líquido) | P0 | M | Layout vertical fluído; sem grid 3×2 de inputs |
| N-P0-02 | Fonte da retenção em badge destacado (não 10px) com clique p/ override | P0 | S | "Padrão do contrato" visível à primeira leitura |
| N-P0-03 | Tooltips ⓘ em PIS, COFINS, INSS, IR, CSLL, ISS retido, base reduzida | P0 | M | Texto revisado por contador |
| N-P1-01 | Cálculo transparente: mostrar `base × alíquota = valor` em cada linha | P1 | M | Auditor consegue conferir sem abrir backend |
| N-P1-02 | Item LC 116 com autocomplete + nome (não só código) | P1 | M | "07.17 — Vigilância e segurança" |
| N-P1-03 | Override de alíquota com opção "salvar como padrão" | P1 | S | Checkbox dispara `UPDATE bol_contratos.aliquota_iss_padrao` |
| N-P1-04 | Discriminação editável no próprio modal | P1 | S | Textarea inline; reapproveita endpoint de boletim |
| N-P1-05 | Erro WebISS traduzido com ação sugerida | P1 | M | Mapeia 5 erros mais comuns (cstAuth, certificado, item_lista, …) |
| N-P1-06 | Base INSS quebrada visualmente | P1 | S | Bruto − vale − materiais = base, depois × % |
| N-P2-01 | Comparativo "mês anterior" lado do valor bruto | P2 | M | Δ em % e R$ |
| N-P2-02 | Substituir `confirm()` nativo por modal estilizado | P2 | S | Compatível com PWA mobile |
| N-P2-03 | Alíquota única em %; remover input decimal | P2 | S | Backend recebe sempre `aliquotaIss * 100` |

---

## 6. Etapa 4 — Alíquotas + Códigos fiscais

### 6.1 Estado atual

Esta etapa é **a mais grave do painel** porque **não tem UI**. Toda configuração que faz a nota fiscal sair correta vive em:

- `bol_contratos` (17 colunas adicionadas pelo PR #15) — [boletins.js:67-93](src/routes/boletins.js#L67)
- `bol_postos` (5 colunas adicionadas) — [boletins.js:98-108](src/routes/boletins.js#L98)
- `bol_contratos.retencoes_padrao` (JSON solto)

E só são preenchidas via **seed por script** ([src/seed-boletins.js](src/seed-boletins.js)) ou ALTER manual no banco.

Colunas fiscais críticas hoje sem UI:

```
bol_contratos
├── item_lista_servico            (LC 116 — define o serviço)
├── codigo_tributacao_municipal   (pode divergir de item_lista em alguns municípios)
├── codigo_cnae                   (8111700 = vigilância)
├── codigo_nbs                    (118031000)
├── aliquota_iss_padrao           (0.0200 a 0.0500 em Palmas)
├── iss_retido_padrao             (TRUE pra UFT/UNITINS; FALSE pra DETRAN)
├── optante_simples_nacional      (1=sim, 2=não)
├── incentivo_fiscal              (1=sim, 2=não)
├── ciclo_dia_inicio              (NULL=calendário; 5=UFT; 14=UNITINS)
├── dados_bancarios               (texto livre — vai pra discriminação)
├── template_discriminacao        (texto introdutório com placeholders)
├── inss_aliquota                 (0.0900 a 0.1100)
├── inss_base_reduzida            (TRUE = aplica deduções de bol_postos)
├── irrf_aliquota                 (0.0120 padrão; 0 quando isento)
├── pis_aliquota                  (0.0065 lucro presumido)
├── cofins_aliquota               (0.0300 lucro presumido)
└── csll_aliquota                 (0.0100 lucro presumido)

bol_postos
├── codigo_municipio_ibge         (necessário pro WebISS roteador)
├── aliquota_iss_local            (override — Porto Nacional pode ter 4%)
├── deducao_vale_alimentacao      (base reduzida INSS — UFT)
├── deducao_materiais             (base reduzida INSS — UFT)
└── mostrar_colaboradores         (boolean opt-in)
```

**Onde aparece pro operador hoje:**

- **Nenhuma tela de cadastro/edição.** Camila tem de pedir pro TI.
- **Modal de prévia NFS-e** ([app-boletins.js:2106](public/app-boletins.js#L2106)) — mostra **valor calculado** das retenções, mas não a alíquota fonte (exceto ISS).
- **Endpoint `_montarRpsPayload`** ([boletins.js:865-1010](src/routes/boletins.js#L865)) — usa esses campos como input direto; sem fallback se algum estiver NULL (NF sai com 0 ou erro WebISS).

**Backup dos valores corretos:** seed scripts em `scripts/seeds/` (PR #15) + `seed-boletins.js`. Mas **não há UI pra rodá-los** — também via terminal.

**Conceito de override (contrato vs posto)** invisível:

```
Camada 1  bol_contratos.aliquota_iss_padrao = 5%
Camada 2  bol_postos.aliquota_iss_local = 4%  (sobrescreve)
Camada 3  modal de prévia: campo editável (apenas sessão)
```

Camila não vê isso. Se Porto Nacional cobra 4% e Palmas 5%, e o boletim do posto de Porto Nacional sai com 5%, ela só descobre **depois** de emitir, na DCTF.

### 6.2 Fraquezas catalogadas

| ID | Fraqueza | Pri | Onde | Como reproduzir |
|---|---|:---:|---|---|
| F4.1 | **Não existe UI de configuração fiscal.** Tudo em seed/SQL | **P0** | ausência total | Tentar configurar alíquota de novo contrato sem TI |
| F4.2 | Conceito "base reduzida INSS" (UFT — vale + materiais) sem representação visual | **P0** | schema [boletins.js:88](src/routes/boletins.js#L88) + [boletins.js:102-103](src/routes/boletins.js#L102) | Contrato UFT só funciona se DBA setar manualmente |
| F4.3 | Sem visualização da herança contrato → posto pra alíquota ISS local | **P0** | [boletins.js:100](src/routes/boletins.js#L100) | Posto Porto Nacional deveria sobrescrever Palmas |
| F4.4 | `retencoes_padrao` é JSON solto — alterar por SQL é arriscado (1 vírgula errada zera todas) | P1 | [boletins.js:71](src/routes/boletins.js#L71) | Editar JSON via psql |
| F4.5 | Sem catálogo LC 116 — operadora chuta `07.17`, mas Palmas pode exigir `070700` (codigo_tributacao_municipal divergente) | P1 | [boletins.js:76-77](src/routes/boletins.js#L76) | Comparar item_lista vs codigo_tributacao_municipal em DETRAN |
| F4.6 | `dados_bancarios` é texto livre — não valida agência/conta | P2 | [boletins.js:85](src/routes/boletins.js#L85) | Erro de digitação vai pra discriminação da NF |
| F4.7 | `template_discriminacao` sem preview — operadora não sabe como vai aparecer | P1 | [boletins.js:86](src/routes/boletins.js#L86) | Tem que emitir uma NF de teste pra ver |
| F4.8 | Falta campo IBS/CBS pra Reforma Tributária 2026 (LC 214/2025) | P2 | schema atual | Reforma exige novo split de tributos em 2026/2027 |
| F4.9 | Sem audit log de mudança de alíquota — se contador percebe divergência na DCTF, ninguém sabe quem mudou | P1 | sem `audit_log` na tabela | Mudar `aliquota_iss_padrao` → não há registro |
| F4.10 | Sem cópia/duplicação de configuração entre contratos similares (UFT vs UNITINS são quase iguais) | P2 | sem botão "duplicar" | Cadastro de UNITINS exige redigitar 17 campos |

### 6.3 Wireframe ASCII proposto

**Aba Fiscal do modal de contrato** (resolve F4.1):

```
┌─ Editar contrato — UFT 16/2025 ────────────────────────── [✕] ┐
│ Identificação │ ● Fiscal │ Postos │ Bancário │ Histórico       │
│ ───────────────────────────────────────────────────────────────│
│                                                                │
│  ─── Classificação do serviço ─────────────────────────────   │
│  Item LC 116*       [07.17 — Vigilância e segurança    ▾]    │
│  Cód. tributação    [070700                           ]      │
│                     ⓘ se vazio, usa Item LC 116               │
│  CNAE               [8111-7/00 — Vigilância patrimonial ▾]   │
│  NBS                [118031000                        ]      │
│                                                                │
│  ─── Regime tributário ────────────────────────────────────   │
│  Optante Simples Nacional?  ○ Sim   ● Não                     │
│  Incentivo fiscal?          ○ Sim   ● Não                     │
│                                                                │
│  ─── Alíquotas federais (sobre o valor bruto) ────────────    │
│  PIS    [0,65 %]    COFINS [3,00 %]   CSLL [1,00 %]          │
│  IRRF   [1,20 %]                                              │
│                                                                │
│  ─── INSS ─────────────────────────────────────────────────   │
│  Alíquota INSS              [11,00 %]                         │
│  Base                       ○ Bruto                           │
│                             ● Reduzida (deduzir vale + mat.)  │
│                             ⓘ aplica deduções por posto       │
│                                                                │
│  ─── ISS (municipal) ──────────────────────────────────────   │
│  Alíquota ISS padrão        [5,00 %]                          │
│  Tomador retém ISS?         [☑] Sim                          │
│                             ⓘ ex: UFT/UNITINS retêm;          │
│                               DETRAN não retém                │
│                                                                │
│  ─── Ciclo de faturamento ────────────────────────────────    │
│  Início do ciclo            [Dia 5 ▾]                         │
│                             ⓘ UFT cicla 5→4; deixe "calend."  │
│                               para mês fechado                │
│                                                                │
│        [Cancelar]   [📋 Duplicar de outro contrato]           │
│                     [Salvar e ir p/ Postos →]                 │
└────────────────────────────────────────────────────────────────┘
```

**Aba Postos — drill-down em posto com override local** (resolve F4.3):

```
┌─ Postos do contrato UFT 16/2025 ─────────────────────── [✕] ┐
│ Identificação │ Fiscal │ ● Postos │ Bancário │ Histórico    │
│ ───────────────────────────────────────────────────────────  │
│                                                              │
│  Posto         │ Município  │ Cod. IBGE │ Alíq. ISS │ Ações  │
│  Palmas        │ Palmas/TO  │ 1721000   │   herda 5%│ ✏️ 🗑️  │
│  Porto Nacional│ Porto N./TO│ 1718204   │   4% (lcl)│ ✏️ 🗑️  │
│  Araguaína     │ Araguaína..│ 1702109   │   herda 5%│ ✏️ 🗑️  │
│  Gurupi        │ Gurupi/TO  │ 1709500   │   herda 5%│ ✏️ 🗑️  │
│  Miracema      │ Miracema..│ 1713205   │   herda 5%│ ✏️ 🗑️  │
│                                                              │
│  [+ Novo posto]                                              │
└──────────────────────────────────────────────────────────────┘
```

Editar posto abre modal com aba Fiscal própria:
```
Aba Fiscal do posto:
   Alíquota ISS local       [        %]  ⓘ vazio = herda contrato (5%)
   Vale alimentação         R$ [       ]  ⓘ deduz na base INSS reduzida
   Materiais                R$ [       ]
   Mostrar colaboradores?   [☑]
```

**Aba Bancário + Template** (resolve F4.6 e F4.7):

```
┌─ Editar contrato — UFT 16/2025 ────────────────────────── [✕] ┐
│ Identificação │ Fiscal │ Postos │ ● Bancário │ Histórico       │
│ ───────────────────────────────────────────────────────────────│
│                                                                │
│  Banco              [001 — Banco do Brasil ▾]                 │
│  Agência            [1234-5]                                  │
│  Conta              [67890-1]                                 │
│  Titular            [Montana Seg LTDA]                        │
│  Tipo               [Conta corrente ▾]                        │
│                                                                │
│  ─── Template de discriminação ────────────────────────────   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Prestação de serviço de {{descricao_servico}} no     │    │
│  │ {{campus_nome}} da {{contratante}}, conforme         │    │
│  │ Pregão {{pregao}}, Processo {{processo}}.           │    │
│  │ Período: {{ciclo_inicio}} a {{ciclo_fim}}.          │    │
│  │ Dados bancários: {{dados_bancarios}}                │    │
│  └──────────────────────────────────────────────────────┘    │
│  ⓘ Placeholders disponíveis: {{contratante}}, {{processo}},   │
│     {{pregao}}, {{competencia}}, {{ciclo_inicio}}, …          │
│                                                                │
│  ─── Preview com dados deste contrato ─────────────────────   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Prestação de serviço de vigilância armada e          │    │
│  │ desarmada no Campus Palmas da UFT, conforme          │    │
│  │ Pregão 009/2022, Processo 23101.xxxxxx/2025-xx.      │    │
│  │ Período: 05/04/2026 a 04/05/2026.                    │    │
│  │ Dados bancários: BB 1234-5 / 67890-1 — Montana…     │    │
│  └──────────────────────────────────────────────────────┘    │
│  ⓘ máx 20 linhas / 2000 caracteres (limite WebISS Palmas)     │
│                                                                │
│        [Cancelar]   [💾 Salvar]                               │
└────────────────────────────────────────────────────────────────┘
```

**Aba Histórico** (resolve F4.9):

```
Audit log das edições fiscais:
   2026-05-14 14:32  felipe@montana   ISS 4% → 5%     (motivo: ajuste DCTF)
   2026-05-10 10:15  camila@montana   Base INSS bruta → reduzida
   2026-05-01 08:00  seed-script      criação inicial
```

### 6.4 Backlog vinculado

| ID | Item | Pri | Esforço | Critério de aceite |
|----|------|:---:|:---:|---|
| F-P0-01 | Aba Fiscal no modal de contrato com todos os 17 campos | P0 | G | Camila configura UNITINS sem chamar TI |
| F-P0-02 | Aba Postos com tabela mostrando "herda X% / override Y%" | P0 | M | Override visível à primeira leitura |
| F-P0-03 | Base reduzida INSS com explicação visual no modal fiscal | P0 | M | Radio "Bruto / Reduzida" + tooltip + link p/ posto |
| F-P1-01 | Catálogo LC 116 (autocomplete) | P1 | M | Operador escolhe "07.17 — Vigilância" sem decorar código |
| F-P1-02 | Catálogo CNAE (autocomplete IBGE) | P1 | M | Idem CNAE |
| F-P1-03 | Aba Bancário + Template com preview ao vivo | P1 | M | Placeholders substituídos com dados do contrato em tempo real |
| F-P1-04 | Audit log de mudanças fiscais (nova tabela `bol_contrato_audit`) | P1 | M | Histórico mostra quem/quando/de→para |
| F-P1-05 | Botão "Duplicar de outro contrato" | P1 | S | Modal abre escolha de contrato origem; copia 17 campos |
| F-P2-01 | Campos IBS/CBS pra Reforma Tributária 2026 | P2 | S | Reserva colunas + radio "Antes/Depois da reforma" |
| F-P2-02 | Validação de dados bancários (mod 11 de conta BB) | P2 | S | Aviso amarelo se conta inválida |
| F-P2-03 | Export de configuração fiscal como JSON (backup pré-mudança) | P2 | S | Download YYYY-MM-DD-uft.json |

---

## 7. Backlog consolidado

Legenda: **Pri** P0/P1/P2 · **Esf** S=≤1d / M=1-3d / G=3-5d · **PR sugerido**: agrupamento por entrega.

### P0 — fazer antes da Reforma Tributária 2026 (janeiro/2027)

| ID | Etapa | Item | Esf | Arquivos afetados | PR sugerido |
|----|---|------|:---:|---|---|
| C-P0-01 | Contrato | Form único Novo/Editar (sai dos prompt()) | M | [public/app-boletins.js:382-522](public/app-boletins.js#L382) | feat/painel-contrato-p0 |
| C-P0-02 | Contrato | Tabs Identif./Fiscal/Postos/Bancário/Hist. | G | mesmo arquivo + CSS | feat/painel-contrato-p0 |
| C-P0-03 | Contrato | Validações inline (CNPJ, %, obrigatórios) | S | mesmo + util validation.js | feat/painel-contrato-p0 |
| F-P0-01 | Fiscal | Aba Fiscal com 17 campos invisíveis | G | [public/app-boletins.js](public/app-boletins.js), [src/routes/boletins.js:233-266](src/routes/boletins.js#L233) (alargar PUT) | feat/painel-fiscal-p0 |
| F-P0-02 | Fiscal | Aba Postos com override visível | M | mesmo + [src/routes/boletins.js:293](src/routes/boletins.js#L293) | feat/painel-fiscal-p0 |
| F-P0-03 | Fiscal | Base INSS reduzida com explicação | M | mesmo | feat/painel-fiscal-p0 |
| B-P0-01 | Boletim | Glossário "consolidado vs por posto" | S | [public/app-boletins.js](public/app-boletins.js) topo do painel | feat/painel-boletim-p0 |
| B-P0-02 | Boletim | Botão único "Gerar pendentes" | M | [public/app-boletins.js:2280-2321](public/app-boletins.js#L2280) + endpoint | feat/painel-boletim-p0 |
| B-P0-03 | Boletim | Form de posto modal (substitui prompt) | M | [public/app-boletins.js:524-560](public/app-boletins.js#L524) | feat/painel-boletim-p0 |
| B-P0-04 | Boletim | Modal de edição com aba Fiscal embutida | G | [public/app-boletins.js:1780-1969](public/app-boletins.js#L1780) | feat/painel-boletim-p0 |
| N-P0-01 | Prévia | Reagrupar em 4 blocos verticais | M | [public/app-boletins.js:2045-2166](public/app-boletins.js#L2045) | feat/painel-previa-p0 |
| N-P0-02 | Prévia | Fonte da retenção como badge | S | mesmo | feat/painel-previa-p0 |
| N-P0-03 | Prévia | Tooltips em todos os termos fiscais | M | mesmo + glossario.json | feat/painel-previa-p0 |

**Total P0: 13 itens · ~28-35 dias-dev distribuídos em 4 PRs paralelos.**

### P1 — fazer em até 90 dias

| ID | Etapa | Item | Esf | PR sugerido |
|----|---|------|:---:|---|
| C-P1-01 | Contrato | Coluna "Postos" funcional | S | feat/painel-contrato-p1 |
| C-P1-02 | Contrato | Renomear "CNPJ do Tomador" + hint | S | feat/painel-contrato-p1 |
| C-P1-03 | Contrato | Cards "Config Fiscal" e "Bancário" no detalhe | M | feat/painel-contrato-p1 |
| C-P1-04 | Contrato | Unificar "Gerar" da linha com painel mensal | S | feat/painel-contrato-p1 |
| B-P1-01 | Boletim | Botão "Voltar ao template" | S | feat/painel-boletim-p1 |
| B-P1-02 | Boletim | Glosas detalhadas (N linhas) | M | feat/painel-boletim-p1 |
| B-P1-03 | Boletim | Status como badge clicável | S | feat/painel-boletim-p1 |
| B-P1-04 | Boletim | Manutenção 🛠️ com opt-in | M | feat/painel-boletim-p1 |
| N-P1-01 | Prévia | Cálculo transparente (base × % = R$) | M | feat/painel-previa-p1 |
| N-P1-02 | Prévia | Item LC 116 com autocomplete + nome | M | feat/painel-previa-p1 |
| N-P1-03 | Prévia | Override "salvar como padrão" | S | feat/painel-previa-p1 |
| N-P1-04 | Prévia | Discriminação editável inline | S | feat/painel-previa-p1 |
| N-P1-05 | Prévia | Erro WebISS traduzido | M | feat/painel-previa-p1 |
| N-P1-06 | Prévia | Base INSS quebrada visualmente | S | feat/painel-previa-p1 |
| F-P1-01 | Fiscal | Catálogo LC 116 (autocomplete) | M | feat/painel-fiscal-p1 |
| F-P1-02 | Fiscal | Catálogo CNAE | M | feat/painel-fiscal-p1 |
| F-P1-03 | Fiscal | Aba Bancário + preview template | M | feat/painel-fiscal-p1 |
| F-P1-04 | Fiscal | Audit log de mudanças fiscais | M | feat/painel-fiscal-p1 + nova tabela |
| F-P1-05 | Fiscal | Duplicar contrato | S | feat/painel-fiscal-p1 |

### P2 — backlog técnico

| ID | Etapa | Item | Esf |
|----|---|------|:---:|
| C-P2-01 | Contrato | Busca, filtro, paginação | M |
| C-P2-02 | Contrato | Histórico de edições | M |
| B-P2-01 | Boletim | Descontinuar `valor_mensal_bruto` | S |
| N-P2-01 | Prévia | Comparativo mês anterior | M |
| N-P2-02 | Prévia | Modal estilizado (sem confirm nativo) | S |
| N-P2-03 | Prévia | Alíquota única em % | S |
| F-P2-01 | Fiscal | Reservar campos IBS/CBS | S |
| F-P2-02 | Fiscal | Validação banco | S |
| F-P2-03 | Fiscal | Export config como JSON | S |

---

## 8. Riscos e dependências

### 8.1 Tamanho do arquivo principal

[public/app-boletins.js](public/app-boletins.js) tem **3.220 linhas** e cresce a cada PR. Sem fatiar:

- Cada PR P0 vai conflitar com os demais.
- Code review fica impraticável.

**Recomendação:** antes de C-P0-02 (Tabs), quebrar o arquivo em módulos ES6:
```
public/js/painel-faturamento/
├── lista.js            (renderBolLista, KPIs)
├── contrato-modal.js   (tabs, form, validação)
├── boletim-modal.js    (edição, override, glosas)
├── previa-nfse.js      (modal NFS-e + cálculos)
├── manutencao.js       (dedup, fantasmas, stats)
└── glossario.js        (tooltips, catálogo LC 116/CNAE)
```

Esforço extra: **2 dias** pra split sem mudar comportamento (PR mecânico, fácil de revisar).

### 8.2 Compatibilidade com schema atual

Nenhum item do backlog exige migration destrutiva — todos usam colunas que **já existem** em `bol_contratos`/`bol_postos`. Apenas duas adições novas:

- `bol_contrato_audit` (P1) — tabela nova, idempotente.
- `bol_contratos.regime_pis_cofins` (P2 — Reforma Tributária) — coluna nova com default.

### 8.3 Operação durante o rollout

Camila não pode ficar sem faturar enquanto a UI muda. Estratégia:

1. **Feature flag** `ENABLE_NEW_PAINEL_FATURAMENTO` (env var no PM2).
2. Cada PR sai com flag desligada em produção.
3. Após merge, ligar para 1 usuário admin → 1 semana → ligar pra todos.
4. Manter o painel antigo em rota paralela (`/painel-legacy`) por 1 ciclo fiscal (60 dias).

### 8.4 Dependência da Reforma Tributária 2026 (LC 214/2025)

A partir de jan/2027 (regime inicial em 2026) o WebISS Palmas vai exigir split de IBS (estadual) + CBS (federal) na nota. Memória `webiss_palmas.md` sinaliza isso. Implicações:

- F-P2-01 (reservar campos IBS/CBS) sobe para **P1** se a versão final do leiaute Palmas sair antes de set/2026.
- Modal de prévia precisa ganhar 5º bloco "IBS/CBS" — encaixar agora na arquitetura.

### 8.5 Outros riscos

- **Tradução de erros WebISS** (N-P1-05) depende de coletar amostra real — pedir ao TI listar erros dos últimos 30 dias.
- **Audit log** (F-P1-04) precisa de timezone consistente (Cloud SQL está em UTC; UI mostra Brasília).
- **Catálogo LC 116** — usar a tabela oficial da LC 116/2003 (estática, ~200 itens). Não há serviço público a consultar.

---

## 9. Como confirmar que este doc está pronto

1. **Cobertura** — Etapas 1-4 têm: estado atual, ≥3 fraquezas com [file:linha], wireframe ASCII, lista de IDs do backlog. ✅
2. **Reproducibilidade das fraquezas** — cada item P0 tem coluna "Como reproduzir" preenchida. ✅
3. **Backlog acionável** — cada item tem arquivo afetado, critério de aceite e PR sugerido. ✅
4. **Revisão com Camila (operadora financeira)** — agendar 1h de screen-share. Itens a validar:
   - "A jornada da seção 2 reflete o que você faz hoje?"
   - "Quais dos termos fiscais nos wireframes você consideraria 'jargão' ainda?"
   - "Existe alguma fricção do seu dia-a-dia que não está listada?"
5. **Revisão técnica com Felipe (TI)** — validar viabilidade do backlog técnico (módulos ES6, feature flag, schema).
6. **Sem alteração de código nessa fase** — `git status` mostra apenas `REVIEW_PAINEL_FATURAMENTO.md` adicionado.

### Próximo passo

Aprovados o doc e o backlog, abrir 4 PRs paralelos em branches `feat/painel-faturamento-{contrato,boletim,previa,fiscal}-p0` sob feature flag, com Camila acompanhando o staging.

---

*Documento gerado por análise estática de [public/app-boletins.js](public/app-boletins.js) (3.220 linhas), [src/routes/boletins.js](src/routes/boletins.js), [src/seed-boletins.js](src/seed-boletins.js), [data/webiss-samples/RETOMADA.md](data/webiss-samples/RETOMADA.md) e memória `webiss_palmas.md`. Sem execução de runtime — fricções de UX foram inferidas do código, não observadas em sessão. Validar com Camila antes de priorizar.*










