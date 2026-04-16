# Montana Intelligence — Guia Rápido

## O que é
Servidor MCP que permite ao Claude consultar os dados do Grupo Montana SEC em tempo real.
Uma vez configurado, você pergunta em português e recebe resposta com dados reais em segundos.

## Arquivos
- `etl.py` — Gera o banco de conhecimento a partir dos SQLites do Montana App
- `server.py` — Servidor MCP/FastAPI com 8 ferramentas para o Claude
- `setup_gcp.sh` — Instala tudo no servidor GCP (roda uma vez)
- `claude_desktop_config.json` — Configuração do Claude Desktop

## Como instalar (no servidor GCP)

```bash
# 1. Conectar ao servidor
ssh diretoria@104.196.22.170

# 2. Ir para a pasta
cd /opt/montana/app_unificado/montana_intelligence

# 3. Executar o setup
chmod +x setup_gcp.sh && ./setup_gcp.sh

# Anote o TOKEN gerado!
```

## Como configurar no Claude Desktop (Windows)

1. Abra o arquivo:
   `C:\Users\Avell\AppData\Roaming\Claude\claude_desktop_config.json`

2. Cole o conteúdo de `claude_desktop_config.json`
   (substituindo o token pelo gerado no setup)

3. Reinicie o Claude Desktop

4. Pronto — o Claude terá acesso ao Montana!

## Ferramentas disponíveis

| Ferramenta | O que faz |
|-----------|-----------|
| `pendencias_financeiras` | NFs em aberto e créditos não identificados |
| `fluxo_caixa` | Entradas e saídas por mês/empresa |
| `status_contratos` | Saúde de todos os contratos ativos |
| `apuracao_fiscal` | PIS/COFINS/ISS de uma competência |
| `buscar_nfs` | Busca NFs por tomador, contrato, status |
| `buscar_conhecimento` | Pesquisa texto livre no knowledge base |
| `alerta_vencimentos` | Contratos e certidões vencendo |
| `funcionarios_contrato` | Funcionários e folha por contrato |

## Exemplos de perguntas

- "Quais NFs da UFT estão pendentes de pagamento?"
- "Qual o fluxo de caixa da Assessoria em março/26?"
- "Quais contratos vencem nos próximos 60 dias?"
- "Qual a apuração de PIS/COFINS de março/26 da Assessoria?"
- "Quantos funcionários estão alocados no contrato SESAU?"
- "Buscar informações sobre o contrato DETRAN"

## Atualização automática
O ETL roda todo dia à meia-noite, mantendo o knowledge base atualizado.
Para rodar manualmente: `python3 etl.py`
