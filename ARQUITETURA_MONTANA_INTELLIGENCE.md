# Montana Intelligence — Arquitetura da Base de Conhecimento
**Grupo Montana SEC | Versão 1.0 | Abril/2026**

---

## O que muda na prática

**Antes:**
> Felipe precisa saber o total a receber do Estado do Tocantins em maio.
> Abre o sistema → filtra por contrato → soma NFs pendentes → abre Excel de despesas → calcula...
> **Tempo: 20-40 minutos.**

**Depois:**
> Felipe digita: *"Qual o total a receber do Estado do Tocantins em maio?"*
> Claude consulta o servidor Montana Intelligence → processa 4 empresas → responde:
> *"SESAU 178/2022: R$193.623 (3 NFs fev/26+mar/26 pendentes). DETRAN 41/2023: R$420.000 estimado. TCE 117/2024: R$681.992 (2 NFs em aberto). Total projetado: R$1.295.615."*
> **Tempo: 3 segundos.**

---

## Visão Geral da Arquitetura

```
┌─────────────────────────────────────────────────────────────────────┐
│                    GRUPO MONTANA SEC                                │
│                                                                     │
│  PC Escritório    PC RH      PC Contabilidade   PC Operações        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Planilhas│  │Folha/RH  │  │SPED/EFD/ECF  │  │Contratos PDF │   │
│  │ Excel    │  │Ponto     │  │DAS/DCTF      │  │Boletins      │   │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  └──────┬───────┘   │
└───────┼─────────────┼───────────────┼─────────────────┼───────────┘
        │             │               │                 │
        └─────────────┴───────────────┴─────────────────┘
                                  │
                         (pasta compartilhada /
                          upload via app /
                          script agendado)
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 SERVIDOR GCP — 104.196.22.170                       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  CAMADA 1 — ETL (Python)                                    │   │
│  │  Coleta → Limpa → Normaliza → Classifica                    │   │
│  └──────────────────────┬──────────────────────────────────────┘   │
│                         │                                           │
│  ┌──────────────────────▼──────────────────────────────────────┐   │
│  │  CAMADA 2 — BANCO DE CONHECIMENTO                           │   │
│  │                                                             │   │
│  │  ┌─────────────────┐  ┌────────────────┐  ┌─────────────┐  │   │
│  │  │ SQLite Montana  │  │ Fatos em Texto │  │ Documentos  │  │   │
│  │  │ (já existe)     │  │ (linguagem     │  │ (PDFs/Word  │  │   │
│  │  │ 4 empresas      │  │  natural)      │  │  indexados) │  │   │
│  │  └─────────────────┘  └────────────────┘  └─────────────┘  │   │
│  └──────────────────────┬──────────────────────────────────────┘   │
│                         │                                           │
│  ┌──────────────────────▼──────────────────────────────────────┐   │
│  │  CAMADA 3 — SERVIDOR MCP (Python FastAPI)                   │   │
│  │  Porta 8001 | Autenticado | Ferramentas para o Claude       │   │
│  └──────────────────────┬──────────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │   CLAUDE (você)       │
              │   Pergunta em PT-BR   │
              │   Recebe resposta     │
              │   com dados reais     │
              └───────────────────────┘
```

---

## Camada 1 — Coleta e ETL

### Fontes de dados a integrar

| Fonte | Onde está | Ferramenta Python | Prioridade |
|-------|-----------|-------------------|------------|
| SQLite Montana App | GCP (já no servidor) | `sqlite3` | ✅ Imediato |
| Extrato bancário BB | Excel XLS nos PCs | `pandas` + parser BB | 🔥 Alta |
| NFS-e WebISS | WebISS online | `requests` + scraper | 🔥 Alta |
| Contratos PDF | Pasta compartilhada | `pdfplumber` | Média |
| Folha de pagamento | Excel RH | `pandas` | Média |
| SPED EFD/ECF | Contador externo | Parser SPED | Baixa |
| Notas fiscais entrada | XML NF-e | `xmltodict` | Baixa |

### Como a coleta funciona

**Opção A — Pasta compartilhada na rede (recomendado para início):**
Cada PC salva arquivos em uma pasta de rede que o servidor GCP monitora.
O script Python detecta arquivos novos e processa automaticamente.

**Opção B — Upload manual via App Montana:**
Botão "Importar Documento" no app já existente.
Arrasta o arquivo → sistema classifica e indexa.

**Opção C — Script agendado nos PCs:**
Um pequeno script Python roda à meia-noite em cada computador,
compacta os arquivos novos e envia para o servidor via HTTPS.

---

## Camada 2 — Banco de Conhecimento

### A conversão para linguagem natural

O segredo está aqui. Em vez de guardar apenas:
```
NF: 202600000000154 | competencia: fev/26 | valor: 43762.60 | status: CONCILIADO
```

O sistema gera e armazena também:
```
"NF nº 154 emitida para a UFT (Fundação Universidade Federal do Tocantins)
referente a fevereiro/2026, valor líquido R$43.762,60, paga em 07/04/2026
via PIX. Contrato UFT 16/2025."
```

Quando Felipe pergunta algo, Claude encontra a resposta relevante em milissegundos
sem precisar fazer queries complexas.

### Estrutura do banco central

```sql
-- Fatos em linguagem natural (para Claude ler)
CREATE TABLE knowledge_chunks (
    id          INTEGER PRIMARY KEY,
    empresa     TEXT,        -- assessoria / seguranca / mustang / portodovau
    categoria   TEXT,        -- contrato / nf / pagamento / despesa / funcionario
    referencia  TEXT,        -- ID do registro original
    conteudo    TEXT,        -- O TEXTO EM LINGUAGEM NATURAL
    dados_json  TEXT,        -- Dados brutos em JSON (backup)
    data_ref    DATE,        -- Data de referência do fato
    atualizado  TIMESTAMP
);

-- Documentos (PDFs, Word, Excel)
CREATE TABLE documentos (
    id          INTEGER PRIMARY KEY,
    empresa     TEXT,
    tipo        TEXT,        -- contrato / boleto / relatorio / certidao
    nome        TEXT,
    conteudo    TEXT,        -- Texto extraído
    caminho     TEXT,        -- Caminho original do arquivo
    importado   TIMESTAMP
);

-- Índice de perguntas frequentes (aprende com uso)
CREATE TABLE consultas_cache (
    pergunta    TEXT,
    resposta    TEXT,
    empresa     TEXT,
    validade    TIMESTAMP
);
```

### Exemplos de textos gerados automaticamente

**Contrato:**
> "Contrato SESAU 178/2022 com a Secretaria de Estado da Saúde do Tocantins.
> Vigência até dez/2026. Valor mensal bruto R$216.143. Total emitido em 2026:
> R$1.296.858 (12 NFs). Conciliado: R$346.507 (jan+fev parcial). A receber: R$950.351.
> Status: ATIVO. Último pagamento: fev/2026."

**Fluxo do mês:**
> "Abril/2026 — Montana Assessoria: Entradas confirmadas R$227.816 (7 NFs conciliadas).
> Pendente de identificação: R$1.697.117 em 23 créditos bancários.
> Investimentos (Rende Fácil): R$4.148.620. Saída inter-empresa: R$3.700.000."

---

## Camada 3 — Servidor MCP

### O que é MCP

MCP (Model Context Protocol) é o protocolo nativo do Claude para usar ferramentas.
Em vez de navegar em sites ou ler arquivos, Claude chama funções diretamente —
como um funcionário com acesso ao sistema.

### Ferramentas disponíveis para o Claude

```python
# O Claude pode chamar qualquer uma dessas funções naturalmente

def pendencias_financeiras(empresa=None, contrato=None):
    """Retorna NFs em aberto e créditos não conciliados"""

def fluxo_caixa(empresa, mes, ano):
    """Entradas, saídas e saldo do período"""

def status_contratos(empresa=None):
    """Resumo saúde de todos os contratos"""

def apuracao_fiscal(empresa, competencia):
    """PIS/COFINS/ISS do período — regime de caixa"""

def buscar_nfs(tomador=None, contrato=None, status=None, periodo=None):
    """Busca notas fiscais com filtros"""

def buscar_documento(termo, empresa=None):
    """Pesquisa semântica nos documentos indexados"""

def funcionarios_contrato(contrato):
    """Lista funcionários alocados e custo por contrato"""

def alerta_vencimentos(dias=30):
    """Contratos, certidões e documentos vencendo em X dias"""
```

### Instalação no servidor GCP

```bash
# 1. Instalar dependências
pip install fastapi uvicorn anthropic sqlite3

# 2. Criar o serviço
nano /opt/montana/mcp_server.py

# 3. Configurar como serviço permanente
pm2 start mcp_server.py --interpreter python3 --name montana-mcp

# 4. Configurar no Claude Desktop (claude_desktop_config.json)
{
  "mcpServers": {
    "montana": {
      "url": "http://104.196.22.170:8001",
      "token": "SEU_TOKEN_AQUI"
    }
  }
}
```

---

## Roadmap de Implementação

### Fase 1 — Esta semana (dados já existentes)
**Custo adicional: R$0 | Tempo: 2-3 dias**

- [ ] Criar script Python `montana_etl.py` que lê os 4 SQLites do Montana App
- [ ] Gerar textos automáticos para todos os contratos, NFs e extratos
- [ ] Subir MCP server básico no GCP com as 8 ferramentas
- [ ] Configurar Claude Desktop para conectar ao servidor Montana
- [ ] Testar: perguntar sobre qualquer contrato e receber resposta em segundos

**Resultado:** Claude já sabe tudo que está no Montana App (NFs, contratos, extratos, RH)

### Fase 2 — Próximas 2-4 semanas (documentos)
**Custo adicional: ~R$50/mês (armazenamento GCP) | Tempo: 1 semana de trabalho**

- [ ] Indexar PDFs de contratos (pdfplumber)
- [ ] Importar extratos bancários históricos
- [ ] Integrar WebISS para NFS-e em tempo real
- [ ] Upload de documentos via interface no Montana App

**Resultado:** Claude lê contratos, extrato e documentos fiscais

### Fase 3 — 1-2 meses (automação total)
**Custo adicional: ~R$100/mês | Tempo: 2-3 semanas**

- [ ] Scripts automáticos nos PCs da empresa (rodam à meia-noite)
- [ ] Integração com folha de pagamento
- [ ] Parser SPED EFD/ECF para dados contábeis
- [ ] Dashboard: "índice de cobertura" mostrando % dos dados indexados

**Resultado:** Base de conhecimento se atualiza sozinha, sem intervenção manual

### Fase 4 — Contínua (inteligência)
- [ ] Claude aprende com as perguntas mais frequentes
- [ ] Alertas automáticos: *"SESAU tem NF de R$102k vencida há 45 dias"*
- [ ] Relatórios gerados automaticamente toda segunda-feira
- [ ] Integração com contador externo via email/API

---

## Começar agora — Script de início rápido

Este script já pode rodar hoje no servidor GCP e cria a primeira versão
do banco de conhecimento usando os dados do Montana App:

```python
# inicio_rapido.py — Roda no servidor GCP
import sqlite3, json
from datetime import datetime

EMPRESAS = {
    'assessoria': '/opt/montana/app_unificado/data/assessoria/montana.db',
    'seguranca':  '/opt/montana/app_unificado/data/seguranca/montana.db',
    'mustang':    '/opt/montana/app_unificado/data/mustang/montana.db',
    'portodovau': '/opt/montana/app_unificado/data/portodovau/montana.db',
}

def gerar_texto_contrato(c):
    return (
        f"Contrato {c['numContrato']} com {c['orgao']}. "
        f"Vigência: {c['vigencia_inicio']} a {c['vigencia_fim']}. "
        f"Valor mensal bruto: R${c['valor_mensal_bruto']:,.2f}. "
        f"Total pago: R${c['total_pago']:,.2f}. "
        f"A receber: R${c['total_aberto']:,.2f}. "
        f"Status: {c['status']}."
    )

def gerar_texto_nf(nf):
    status = "PAGA" if nf['status_conciliacao'] == 'CONCILIADO' else "PENDENTE"
    return (
        f"NF {nf['numero']} emitida para {nf['tomador'][:40]} "
        f"competência {nf['competencia']}, "
        f"valor líquido R${nf['valor_liquido']:,.2f}. "
        f"Contrato: {nf['contrato_ref'] or 'não vinculado'}. "
        f"Status: {status}."
    )

# Cria banco central
kb = sqlite3.connect('/opt/montana/knowledge_base.db')
kb.execute('''CREATE TABLE IF NOT EXISTS knowledge_chunks
    (id INTEGER PRIMARY KEY, empresa TEXT, categoria TEXT,
     referencia TEXT, conteudo TEXT, atualizado TEXT)''')

total = 0
for empresa, db_path in EMPRESAS.items():
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        # Contratos
        for c in conn.execute("SELECT * FROM contratos WHERE status='ATIVO'"):
            texto = gerar_texto_contrato(dict(c))
            kb.execute("INSERT OR REPLACE INTO knowledge_chunks VALUES (NULL,?,?,?,?,?)",
                      (empresa, 'contrato', c['numContrato'], texto, datetime.now().isoformat()))
            total += 1

        # NFs recentes (últimos 6 meses)
        for nf in conn.execute(
            "SELECT * FROM notas_fiscais WHERE data_emissao >= date('now','-6 months')"
        ):
            texto = gerar_texto_nf(dict(nf))
            kb.execute("INSERT OR REPLACE INTO knowledge_chunks VALUES (NULL,?,?,?,?,?)",
                      (empresa, 'nf', nf['numero'], texto, datetime.now().isoformat()))
            total += 1

        conn.close()
        print(f"✓ {empresa} processado")
    except Exception as e:
        print(f"✗ {empresa}: {e}")

kb.commit()
print(f"\n✅ {total} registros indexados em linguagem natural!")
print("   Banco salvo em: /opt/montana/knowledge_base.db")
```

---

## Segurança

- Token de autenticação no servidor MCP (sem token, sem resposta)
- Acesso apenas de IPs autorizados (seu computador + servidor)
- Dados nunca saem do seu servidor GCP — Claude consulta localmente
- Backup automático do knowledge_base.db junto com os demais bancos

---

## Custo total do projeto

| Fase | Infraestrutura extra | Custo/mês |
|------|---------------------|-----------|
| 1 (MCP básico) | Zero — usa servidor existente | R$ 0 |
| 2 (documentos) | +10GB armazenamento GCP | ~R$ 15 |
| 3 (automação) | +CPU para ETL noturno | ~R$ 30 |
| 4 (inteligência) | API Claude (se usar embeddings) | ~R$ 50-200 |

**O servidor GCP atual já comporta as fases 1 e 2 sem custo adicional.**

---

*Documento gerado em 13/04/2026 | Montana Intelligence v1.0*
*Próximo passo: implementar `inicio_rapido.py` no servidor GCP*
