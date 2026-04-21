# Roadmap — Substituição gradual do Omie pelo ERP Montana

> **Contexto**: o ERP Montana já cobre ~70% das funcionalidades do Omie (contratos,
> NFS-e WebISS, extratos BB, conciliação, fluxo de caixa, DRE, PIS/COFINS, folha,
> boletins, ponto, estoque, comprovantes). A proposta aqui é mapear os **gaps**
> restantes e as **dívidas técnicas** que precisam cair antes de desligar o Omie,
> para podermos evoluir em pequenas ondas sem risco de parar a operação.

## Convenções
- **Prioridade**: `A` (crítico) · `B` (importante) · `C` (nice-to-have)
- **Ordem**: numérica dentro da seção, define sequência de execução
- **Status**: `pendente` → `em-andamento` → `em-review` → `concluído` → `cancelado`
- **Branch por item**: `feat/<id>-<slug>` (ex.: `feat/A2-contas-a-pagar`)

---

## A · Onda 1 — Parar de depender do Omie para financeiro operacional

| ID  | Item                                                                 | Prioridade | Ordem | Status |
|-----|----------------------------------------------------------------------|:---:|:---:|:---:|
| A1  | Cadastro unificado de entidades (fornecedores/clientes/terceiros)    |     |     |        |
| A2  | Contas a Pagar — agendamento + conciliação automática vs extrato     |     |     |        |
| A3  | Contas a Receber — liga contratos + NFS-e + Portal Transparência     |     |     |        |
| A4  | Emissão/importação de boletos e PIX (in/out)                         |     |     |        |
| A5  | Régua de cobrança (usar módulo Alertas operacionais existente)       |     |     |        |
| A6  | UI unificada Pagar/Receber + atalhos para conciliar                  |     |     |        |

## B · Onda 2 — Parar de depender para gestão/análise

| ID  | Item                                                           | Prioridade | Ordem | Status |
|-----|----------------------------------------------------------------|:---:|:---:|:---:|
| B1  | Dashboard executivo consolidado (KPIs 4 empresas numa tela)    |     |     |        |
| B2  | Export contábil SPED Contribuições + balancete p/ contador     |     |     |        |
| B3  | RBAC (perfis: admin / financeiro / visualizador)               |     |     |        |
| B4  | Auditoria global (`audit_log` já esboçado — consolidar)        |     |     |        |
| B5  | Workflow de aprovações (ex.: despesa > R$X exige diretor)      |     |     |        |
| B6  | Montana Intelligence (MCP + Claude) — perguntas em linguagem natural |     |     |        |
| B7  | Relatórios customizáveis (filtro por conta, centro de custo)   |     |     |        |

## C · Onda 3 — Corte do Omie

| ID  | Item                                                           | Prioridade | Ordem | Status |
|-----|----------------------------------------------------------------|:---:|:---:|:---:|
| C1  | Export completo do histórico Omie (CSV/JSON)                   |     |     |        |
| C2  | Importador Omie → Montana (diário, reduz dupla entrada)        |     |     |        |
| C3  | Paralelo de negócio 1–2 ciclos fiscais (lançamento nos dois)   |     |     |        |
| C4  | Omie em **read-only** por +1–2 meses como backup               |     |     |        |
| C5  | Desligamento final do Omie                                     |     |     |        |

## D · Pré-requisitos técnicos (dívida que destrava tudo)

| ID  | Item                                                           | Prioridade | Ordem | Status |
|-----|----------------------------------------------------------------|:---:|:---:|:---:|
| D1  | Testes automatizados dos fluxos críticos (conciliação, fluxo, webiss, bb-sync) |     |     |        |
| D2  | Migração SQLite → PostgreSQL (destrava blue/green + multi-writer) |     |     |        |
| D3  | Limpeza das 570 NFs contaminadas (Segurança marcadas como Assessoria) |     |     |        |
| D4  | Resolver SEMUS 192/2025 total_pago = 0 (mapeamento unclear)    |     |     |        |
| D5  | Renovar certificados digitais A1 (.pfx WebISS/BB)              |     |     |        |
| D6  | Backup automatizado (cron `.backup` SQLite já roda às 03h — validar) |     |     |        |
| D7  | CI/CD mínimo (GitHub Actions → staging → prod com approval)    |     |     |        |

## E · Melhorias em módulos existentes

| ID  | Item                                                           | Prioridade | Ordem | Status |
|-----|----------------------------------------------------------------|:---:|:---:|:---:|
| E1  | Conciliação — regra automática para tarifas bancárias (TARIFA/CESTA/TED) |     |     |        |
| E2  | Fluxo de caixa — cenários (otimista/realista/pessimista)       |     |     |        |
| E3  | Contratos — alerta de vencimento de apólices de seguro-garantia |     |     |        |
| E4  | NFS-e — suporte a certificado A1 .pfx (WebISS)                 |     |     |        |
| E5  | Folha — CPFs faltantes (130/592 Assessoria, 2 Segurança)       |     |     |        |
| E6  | Ponto eletrônico — integração com folha                        |     |     |        |
| E7  | Estoque — consumo vinculado a contratos/postos                 |     |     |        |
| E8  | Comprovantes — OCR para extração automática                    |     |     |        |
| E9  | Boletins — deduplicação UFT motorista vs limpeza (discriminação NULL) |     |     |        |
| E10 | Conciliação Segurança — importar extratos pré-nov/2024 + MP/TO |     |     |        |

## F · Gaps vs Omie ainda não cobertos

| ID  | Item                                                           | Prioridade | Ordem | Status |
|-----|----------------------------------------------------------------|:---:|:---:|:---:|
| F1  | NFe de produto (se Porto/Mustang precisarem emitir)            |     |     |        |
| F2  | NFC-e (venda consumidor final)                                 |     |     |        |
| F3  | Módulo de vendas (pedidos, orçamentos, propostas)              |     |     |        |
| F4  | Módulo de compras (cotações, ordens de compra)                 |     |     |        |
| F5  | Ordens de serviço                                              |     |     |        |
| F6  | CRM básico (contatos, oportunidades, histórico)                |     |     |        |
| F7  | Portal do cliente (segunda via boleto, NFs, contratos)         |     |     |        |
| F8  | App mobile / PWA (consulta + aprovações)                       |     |     |        |
| F9  | Integração bancária além do BB (Itaú/Bradesco/Caixa/Santander) |     |     |        |
| F10 | Emissão de MDF-e / CT-e (se houver logística própria)          |     |     |        |
| F11 | Conciliação de cartão de crédito/débito (maquininhas)          |     |     |        |
| F12 | Integração com e-commerce / marketplaces                       |     |     |        |

---

## Arquitetura de deploy durante a migração

### Paralelo de negócio (Omie + Montana juntos)
Durante 1–2 ciclos fiscais operador lança nos dois sistemas; no fim do mês
compara o fechamento. Divergência = bug no Montana. Para reduzir a dor da
dupla entrada, o item **C2** (importador diário Omie → Montana) elimina o
retrabalho: o operador lança só no Omie, o Montana se enche sozinho, até o
dia em que inverte.

### Paralelo de deploy (código novo sem quebrar produção)
- **Staging separado**: segunda instância na mesma VM GCP, porta 3003,
  `data/stg/`, domínio `staging.grupomontanasec.com`. Baixo custo, viável
  com SQLite.
- **Feature flags**: módulos novos ocultos atrás de flag (`ENABLE_CP=true`)
  para rollout progressivo (admin → todos).
- **Blue/green**: **não viável com SQLite** (single-writer). Só após D2
  (PostgreSQL).

### Fluxo de deploy proposto
1. Commit na branch `feat/<id>-<slug>`
2. Push → CI roda testes (D1/D7) → deploy automático em staging
3. Time testa em `staging.grupomontanasec.com`
4. Feature flag liga só para admin em prod → valida com 1 usuário real
5. Liga para todos → monitora 1 semana
6. Remove flag → feature oficial

## Ordem recomendada de execução
Antes de qualquer item de A/B/C, resolver bloqueadores:
1. **D5** — certificados A1 (se vencerem, WebISS/BB param)
2. **D6** — backup automatizado (rede de segurança)
3. **D7** — CI/CD + staging (destrava tudo)
4. **D1** — testes nos fluxos críticos
5. **D2** — PostgreSQL (só depois de D1)
6. **D3 + D4** — limpeza de dados (antes de qualquer import do Omie)

Só então atacar **A1** (cadastro unificado) → **A2/A3** (CP/CR) → demais.
