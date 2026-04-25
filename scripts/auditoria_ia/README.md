# Montana ERP — Auditoria IA (grupo de agentes)

Suíte de agentes Claude que roda **aos sábados de madrugada** e produz um
relatório consolidado em `output/auditoria_ia_YYYY-MM-DD.md` com os achados
priorizados por severidade (CRÍTICO / ALTO / MÉDIO / BAIXO).

Foco atual: **financeiro**. Três agentes cobrem contábil/fiscal, conciliação
de caixa e lógica sistêmica (multi-empresa).

## Arquitetura

```
scripts/auditoria_ia/
├── orquestrador.js        ← entrada; paraleliza agentes, escreve relatório
├── enviar_relatorio.js    ← envia o último relatório por e-mail (SMTP)
├── instalar_cron.sh       ← instala os 2 crons (execução + e-mail)
├── lib/
│   ├── claude.js          ← wrapper do SDK com prompt caching + custo em R$
│   ├── coleta.js          ← queries SQL que extraem só o essencial
│   └── relatorio.js       ← consolida em markdown
└── agentes/
    ├── contabil_fiscal.js
    ├── conciliacao.js
    └── logica_sistemica.js
```

**Por que o custo fica baixo:**
1. Coleta feita via SQL pré-agregado — a IA recebe só o que já é suspeito.
2. Prompt caching no `system` imutável (regras fiscais, contexto do ERP).
3. Modelo padrão: `claude-haiku-4-5`. Sonnet só se for pedido.
4. Execução semanal (sábado), não diária.

Estimativa de custo com Haiku 4.5 + cache + 2 empresas: **~R$ 0,10 a R$ 0,30
por execução**. Teto padrão do orquestrador: R$ 10.

## Pré-requisitos

- `ANTHROPIC_API_KEY` no `.env` (já usado por `src/routes/ia.js`).
- Dependências: `@anthropic-ai/sdk` e `better-sqlite3` — já estão no
  `package.json`.

## Uso manual

```bash
# Tudo, janela de 7 dias (padrão)
node scripts/auditoria_ia/orquestrador.js

# Só uma empresa, janela de 14 dias
node scripts/auditoria_ia/orquestrador.js --empresas=assessoria --dias=14

# Só o agente fiscal (teste rápido)
node scripts/auditoria_ia/orquestrador.js --somente=contabil_fiscal

# Teto de custo (aborta com exit code 2 se ultrapassar)
node scripts/auditoria_ia/orquestrador.js --teto-brl=2
```

## Agendamento (cron semanal)

Use o instalador idempotente no servidor de produção, como o usuário que
roda o ERP:

```bash
bash /opt/montana/app_unificado/scripts/auditoria_ia/instalar_cron.sh
```

O script:
- cria `/var/log/montana/` se precisar,
- verifica se `ANTHROPIC_API_KEY` e `SMTP_*` existem em `.env`,
- adiciona (sem duplicar) **duas** linhas no crontab:

```cron
0 4 * * 6 cd /opt/montana/app_unificado && node scripts/auditoria_ia/orquestrador.js  >> /var/log/montana/auditoria_ia.log 2>&1        # montana-auditoria-ia
0 8 * * 1 cd /opt/montana/app_unificado && node scripts/auditoria_ia/enviar_relatorio.js >> /var/log/montana/auditoria_ia_email.log 2>&1  # montana-auditoria-ia-email
```

- **Sábado 04h** → roda a auditoria, grava `output/auditoria_ia_YYYY-MM-DD.md`.
- **Segunda 08h** → envia por e-mail o relatório mais recente.

Para desinstalar (remove as duas linhas): `bash instalar_cron.sh --remover`.

### E-mail — variáveis no `.env`

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sistema@suaempresa.com
SMTP_PASS=...
SMTP_FROM="Montana Auditoria <sistema@suaempresa.com>"
SMTP_TO=financeiro@suaempresa.com
```

O `enviar_relatorio.js` também aceita `--data=YYYY-MM-DD` (enviar um relatório
específico) e `--para=outro@email.com` (override do destinatário).

## Saída esperada

Cada agente produz uma seção markdown com:

- **Panorama** — parágrafo com a visão geral.
- **Achados priorizados** — lista `[CRÍTICO|ALTO|MÉDIO|BAIXO]` com descrição,
  exposição em R$ e ação sugerida.
- **OK** — resumo do que foi verificado e está saudável.

O relatório final inclui também a tabela de custo por agente (tokens IN/OUT,
cache hit, R$) e um apêndice com o JSON exato enviado à IA — útil para
auditoria reversa do que a IA "viu".

## Expansão futura (depois que estabilizar)

- Agente de **RH/Folha** — cruza `rh_folha` com boletins de medição.
- Agente de **Contratos** — alerta de reajuste INPC vencido, vigências
  expirando.
- Abertura automática de issue no GitHub quando houver achado **CRÍTICO**
  (hoje só grava em markdown — passo deliberado para validar sinal/ruído
  antes de poluir o tracker).

## Regras fiscais aplicadas (hoje)

- **IRRF** IN RFB 1.234/2012 Anexo I:
  - Código 6147 → 1,20% (vigilância, limpeza, conservação, mão-de-obra)
  - Código 6190 → 4,80% (serviços profissionais)
- **PIS/COFINS/CSLL federal**: 4,65% agregado para tomador federal.
- **Tomador público + bruto > R$ 5.000 sem retenção federal = CRÍTICO.**
- **Divergência portal vs. NF > 1% e > R$ 50 → investigar.**

Fonte das regras: `PARECER_IRRF_VIGILANCIA_LIMPEZA_2026-04-17.md` e scripts
`confrontar_retencoes_pagamentos.js` / `apuracao_piscofins_seguranca_mensal.py`.
