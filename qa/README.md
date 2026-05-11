# QA Noturno — Sistema Montana Unificado

Rotina de QA E2E que valida os fluxos críticos do ERP via API REST. Foi
migrada do antigo *scheduled task* do Cowork (`SKILL.md` em `uploads/`) para
viver dentro do próprio repositório, versionada junto com o código que ela
testa.

## Como rodar

```bash
# Da raiz do app_unificado/:
npm run qa:noturno
```

Ou diretamente:

```bash
node qa/run.js
```

## Saída

Um relatório Markdown é gerado em `relatorios_qa/QA_AAAA-MM-DD.md`
(default) ou no caminho indicado por `QA_OUT_DIR` / `QA_OUT_FILE`.

Exit codes:

| Code | Significado |
|---|---|
| 0 | Todos os checks passaram (apenas WARNs são tolerados) |
| 1 | Ao menos 1 check FALHOU |
| 2 | Falha de infraestrutura (login, baseUrl inacessível, etc.) |

Útil para CI: bloquear merge/deploy quando exit ≠ 0.

## Configuração

Por env vars (ver `qa/config.js`):

| Variável | Default | Descrição |
|---|---|---|
| `QA_BASE_URL` | `https://sistema.grupomontanasec.com` | URL do backend |
| `QA_USER` | `admin` | Usuário admin |
| `QA_PASS` | `montana2026` | Senha |
| `QA_COMPETENCIA` | mês anterior (`AAAA-MM`) | Competência usada nos checks de INSS/PIS-COFINS |
| `QA_ANO` | ano atual | Ano usado em filtros de extratos/despesas |
| `QA_OUT_DIR` | `app_unificado/relatorios_qa/` | Pasta de saída |
| `QA_OUT_FILE` | `QA_AAAA-MM-DD.md` | Nome do arquivo |
| `QA_TIMEOUT_MS` | `15000` | Timeout por requisição |
| `QA_RECEITA_MIN_ASSESSORIA` | `10000000` | Piso para sanity check (R$) |
| `QA_RECEITA_MIN_SEGURANCA` | `5000000` | Piso para sanity check (R$) |

## Estrutura

```
qa/
├── README.md           ← este arquivo
├── config.js           ← carrega env vars + defaults
├── run.js              ← entrypoint (npm run qa:noturno)
├── lib/
│   ├── api.js          ← cliente HTTP com login JWT
│   ├── checks.js       ← runner com soft-assert (OK/WARN/FAIL)
│   └── report.js       ← gerador de relatório Markdown
└── checks/
    ├── 01-auth.js
    ├── 02-consolidado.js
    ├── 03-pagamentos.js
    ├── 04-inss.js
    ├── 05-piscofins.js
    ├── 06-despesas.js
    ├── 07-extratos.js
    ├── 08-contratos.js
    └── 99-data-integrity.js
```

Para adicionar um novo check, basta criar um arquivo `NN-nome.js` em
`qa/checks/` exportando uma função `async ({ api, runner, config }) => …`
que chame `runner.ok / warn / fail / expect / assert`. O `run.js` carrega
automaticamente em ordem alfabética.

## O que é verificado

| Módulo | Verificações principais |
|---|---|
| **01-auth** | login JWT funciona, endpoint protegido sem token retorna 401 |
| **02-consolidado** | 4 empresas presentes; Assessoria/Segurança ≥ piso; Porto/Mustang zerados; soma = total |
| **03-pagamentos** | KPIs faturado/recebido/em aberto; status válidos; lista de inadimplentes |
| **04-inss** | `/apuracao` e `/relatorio` consistentes (mesma competência → mesmos totais) |
| **05-piscofins** | Alíquotas 0.65% / 3% corretas; `pis = base × 0.65%`; valida formato `AAAA-MM` |
| **06-despesas** | Endpoints de categorias e lista respondem 200; ambos para Assessoria e Segurança |
| **07-extratos** | Lista paginada com `status_conciliacao`; existe pelo menos 1 conciliado |
| **08-contratos** | Lista carrega; ativos têm `valor_mensal_bruto`; taxonomia de status consistente |
| **99-integrity** | Sanidade matemática (`receita_liquida ≤ receita_bruta`); rotas obsoletas dão 404 |

## Por que nem tudo dá FAIL

A suíte usa **soft-assert** (`runner.warn(...)`) para situações que são
alertas mas não bloqueadores — por exemplo, contratos sem
`valor_mensal_bruto` é problema de dados que vai sendo corrigido aos
poucos, não é razão para travar deploy. Já uma divergência matemática
(soma ≠ total) é sempre `FAIL` porque indica bug real.

## Histórico de execuções

Cada rodada gera um arquivo novo em `relatorios_qa/`. Para evitar acúmulo,
sugiro um cron de limpeza guardando os últimos 30 dias:

```bash
find app_unificado/relatorios_qa -name 'QA_*.md' -mtime +30 -delete
```
