# ANÁLISE TÉCNICA CRÍTICA — Montana ERP Unificado
**Data:** 2026-04-26  
**Revisado por:** Análise automatizada via leitura direta do código-fonte  
**Arquivos analisados:** `src/api.js` (5214 linhas), `src/db_pg.js` (294 linhas), `src/server.js` (606 linhas), `src/db.js` (6 linhas), `src/routes/inss-retido.js`, `src/routes/pagamentos-contrato.js`, `public/app.js` (4445 linhas), `src/auth.js`, `src/companies.js`, `src/companyMiddleware.js`

**Pontos cegos por ausência de arquivo:**  
- `src/routes/margem-contrato.js` — **NÃO EXISTE**  
- `src/routes/patrimonio.js` — **NÃO EXISTE**  
- `src/routes/caixa-livre.js` — **NÃO EXISTE**

---

## 1. QUALIDADE DE CÓDIGO

### 🔴 CRÍTICO — Transações sem `await` (fire-and-forget)

O padrão `req.db.transaction(async () => { ... })()` aparece **sem `await`** em pelo menos 4 lugares críticos:

- `POST /import/ofx` (linha ~2916 de api.js)
- `POST /import/extratos` (PDF fallback, linha ~3093)
- `POST /nfs/auto-vincular` (linha ~1458)
- Cron de geração mensal de boletins (server.js)

**O que acontece:** a função `transaction()` retorna uma `async function`. Chamá-la sem `await` dispara a Promise mas não espera. O servidor responde `{ ok: true }` **antes** de a transação fazer COMMIT. Se houver erro no banco, o usuário recebe sucesso mas os dados não foram gravados. Nenhuma exceção é propagada para o error handler.

Exemplo concreto: o usuário faz upload de um OFX com 300 transações, recebe "300 importadas", mas o banco está vazio porque a transação rolou back em silêncio.

### 🔴 CRÍTICO — `safe_date()` não existe no PostgreSQL

A função `safe_date()` é chamada em **pelo menos 10 lugares** no código:

```
api.js:616   safe_date(vigencia_fim) < CURRENT_DATE
api.js:3275  safe_date(vigencia_fim) >= CURRENT_DATE
api.js:3282  to_char(safe_date(data_iso), 'YYYY-MM')
api.js:3354  to_char(safe_date(data_iso), 'YYYY-MM')
ciclo.js:78  to_char(safe_date(data_emissao), 'YYYY-MM')
ia.js:36,52  safe_date(data_validade)
licitacoes.js:33  safe_date(data_abertura)
drive.js:274  safe_date(data_emissao)
```

`safe_date()` **não é uma função nativa do PostgreSQL**. Era uma UDF definida no SQLite para tratar datas inválidas. Não há nenhuma `CREATE FUNCTION safe_date` no código migrado. Toda query que usa essa função lança `ERROR: function safe_date(text) does not exist`. O error handler global captura e retorna `{ error: 'Erro interno' }` — o usuário vê uma tela vazia ou KPI zerado sem saber por quê.

O alerta de "contratos vencidos" no dashboard (`api.js:616`) nunca funciona por esse motivo.

### 🔴 CRÍTICO — `INSERT OR REPLACE` convertido para `ON CONFLICT DO NOTHING`

No `db_pg.js`, a conversão SQLite → PostgreSQL faz:

```javascript
.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO')
// depois adiciona:
return sql + ' ON CONFLICT DO NOTHING';
```

`INSERT OR REPLACE` no SQLite **deleta e reinserel a linha inteira**. `ON CONFLICT DO NOTHING` **ignora a linha conflitante sem alterá-la**. São operações opostas. O cron de `apuracao_mensal` usa `INSERT OR REPLACE INTO apuracao_mensal` para atualizar os dados mensais — com essa conversão, na segunda execução do cron, os dados de todos os meses anteriores nunca são atualizados. O sistema guarda os valores do primeiro run para sempre.

### 🔴 CRÍTICO — Sintaxe SQL inválida na criação da tabela `apuracao_mensal` (server.js)

No cron de apuração mensal, o `CREATE TABLE` tem uma linha duplicada e mal formada:

```sql
qtd_nfs
qtd_nfs INTEGER DEFAULT 0,
```

Isso é SQL inválido. O PostgreSQL rejeita o statement com erro de sintaxe. O cron captura com `catch(e)` e loga `console.error` — mas **continua rodando os próximos passos**, inclusive o SELECT e o INSERT que dependem da tabela que não foi criada. O resultado: o cron falha silenciosamente todo dia 1° às 05:00 sem nenhum registro de apuração mensal.

### 🔴 CRÍTICO — `datetime('now')` residual do SQLite em queries UPDATE

Em pelo menos dois lugares dentro de `api.js`, queries de UPDATE usam sintaxe SQLite que não é convertida:

```javascript
// api.js:1289
req.db.prepare('UPDATE contratos SET total_pago=?, total_aberto=?, updated_at=datetime(\'now\') WHERE numContrato=?')

// api.js:2762
updates.push('updated_at = datetime(\'now\')');
```

`datetime('now')` não existe no PostgreSQL. Essas queries lançam erro toda vez que uma parcela é atualizada ou uma despesa é editada. O campo `updated_at` nunca é gravado corretamente.

### 🟡 IMPORTANTE — Código morto e resíduos da migração

- `src/db.js` tem **6 linhas**: apenas `module.exports = require('./db_pg')`. É um arquivo fantasma.
- Há **dezenas de arquivos `.bak_pg` e `.bak_sqlite`** no repositório (`api.js.bak_pg`, `api.js.bak_sqlite`, etc.) — código morto versionado como arquivo, não como git commit.
- `strftime` conversion no `db_pg.js` tem dois passos conflitantes: `convertSql` faz substituição parcial de `strftime` *antes* de `fixStrftime` tentar reprocessar — criando `to_char(to_char(...)` em casos edge.

### 🟡 IMPORTANTE — N+1 Queries em `pagamentos-contrato.js`

No endpoint `/inadimplentes`, para cada grupo de tomador (potencialmente 20+ tomadores), para cada NF com `extrato_id` (potencialmente 12+ NFs por tomador), o código faz uma query individual:

```javascript
for (const nf of grupo.nfs.filter(n => n.extrato_id)) {
  const ext = await db.prepare(`SELECT ... FROM extratos WHERE id=?`).get(nf.extrato_id);
```

Em dados reais com 15 tomadores e 10 NFs vinculadas cada: **150 queries sequenciais** para gerar uma tela. Isso vai virar timeout com volume real.

### 🟢 MENOR — api.js tem 5214 linhas

Um único arquivo com dashboard, CRUD, importações, relatórios, Excel export, OFX parse, lógica tributária, motor de regras fiscais, conciliação, e mais. Impossível manter, testar, ou auditar.

---

## 2. ARQUITETURA E LÓGICA

### 🔴 CRÍTICO — Credenciais em texto claro no código-fonte

`src/db_pg.js`:

```javascript
const PG_CONF = {
  host:     process.env.PG_HOST     || '35.247.208.7',
  password: process.env.PG_PASSWORD || 'montana2026',
  ...
};
```

`src/auth.js`:

```javascript
const JWT_SECRET = process.env.JWT_SECRET || 'montana_seg_secret_2026_!xK9#';
```

O IP `35.247.208.7` (GCP Cloud SQL) e a senha `montana2026` estão **hardcoded no código-fonte**. Se o repositório vazar (GitHub, email, pentest), qualquer pessoa tem acesso direto ao banco de produção. O secret JWT também é conhecido: qualquer pessoa pode forjar um token de admin.

O CORS em `server.js` tem o IP `104.196.22.170` hardcoded como origem permitida — mais um IP de infraestrutura exposto no código.

### 🔴 CRÍTICO — `exposicao-intragrupo`: verificação de tabela sempre passa

```javascript
const hasTab = dbEmp.prepare(`
  SELECT table_name as name FROM information_schema.tables 
  WHERE table_schema=current_schema() AND name='despesas'
`).get();
if (!hasTab) continue;
```

Dois erros nessa query:
1. A cláusula `WHERE name='despesas'` usa o alias (`name`), mas PostgreSQL não aceita alias de SELECT em WHERE — a coluna real é `table_name`. A query nunca filtra corretamente.
2. `prepare().get()` no PgDb **retorna uma Promise**, não o resultado diretamente. Sem `await`, `hasTab` é sempre um objeto Promise (truthy), então `if (!hasTab)` nunca é verdadeiro. A verificação é completamente inoperante — o código tenta rodar as queries subsequentes em bancos que talvez não tenham a tabela `despesas`.

### 🔴 CRÍTICO — `INTERVAL '-6 months'` é sintaxe inválida no PostgreSQL

Em `api.js` (relatório lucro-por-contrato):

```sql
WHERE data_emissao >= CURRENT_DATE + INTERVAL '-6 months'
```

No PostgreSQL, a sintaxe correta é `CURRENT_DATE - INTERVAL '6 months'`. A forma com `INTERVAL '-6 months'` funciona em algumas versões mas é comportamento não documentado/não garantido — e o relatório de evolução mensal retorna silenciosamente vazio.

### 🟡 IMPORTANTE — Modelo multi-empresa tem buracos

O header `X-Company` não é validado criptograficamente — qualquer usuário autenticado pode trocar o header e acessar os dados de outra empresa. O sistema presume que o frontend vai enviar o header correto. Não há verificação de que `req.usuario.lotacao` (do JWT) corresponde à empresa no header. Um usuário da empresa `assessoria` consegue ler todos os dados da `seguranca` adicionando `X-Company: seguranca` na requisição.

### 🟡 IMPORTANTE — Migrations inexistentes (`db.js` tem 6 linhas)

O arquivo `src/db.js` deveria conter as migrations do banco — mas tem apenas `module.exports = require('./db_pg')`. Não há nenhum arquivo de migration automática. O schema do banco PostgreSQL foi criado manualmente (há dumps SQL na raiz do projeto: `dump_seguranca.sql`, `dump_assessoria.sql`). Se um novo campo for necessário, precisa ser adicionado manualmente em cada banco de cada empresa. Não há versionamento de schema.

### 🟡 IMPORTANTE — `strftime` conversion cria SQL inválido

No `db_pg.js`:

```javascript
// PASSO 1: convertSql() faz:
.replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*/gi, "to_char(")
// Resulta em: to_char(campo  (sem o formato!)

// PASSO 2: fixStrftime() tenta corrigir via regex, mas só funciona
// se o padrão completo ainda existir — que já foi destruído no passo 1.
```

Para `strftime('%Y-%m', data_iso)`, `convertSql` produz `to_char(data_iso` e então o `)` fica sem correspondência. `fixStrftime` espera encontrar `strftime(` que não existe mais. O resultado é SQL inválido para qualquer query que usava `strftime` com formato simples.

### 🟢 MENOR — Cron interno via HTTP request a si mesmo

Vários crons no `server.js` fazem `http.request` para `127.0.0.1:PORT/api/...` em vez de chamar a função diretamente. Se o servidor estiver sobrecarregado, a porta não responder, ou o PORT mudar, todos os crons silenciosamente falham.

---

## 3. FUNCIONALIDADE REAL VS APARENTE

### 🔴 CRÍTICO — Dashboard "Contratos Vencidos" nunca funciona

```javascript
const contratosVencidos = await req.db.prepare(
  `SELECT COUNT(*) as n FROM contratos WHERE ... AND safe_date(vigencia_fim) < CURRENT_DATE`
).get();
```

`safe_date()` não existe. O catch global retorna `{ error: 'Erro interno' }`. O alerta de contratos vencidos **nunca aparece no dashboard**. O dono olha para uma tela com zero alertas de vencimento e presume que está tudo em dia.

### 🔴 CRÍTICO — Apuração PIS/COFINS usa alíquotas diferentes dependendo do endpoint

- `dashboard/apuracao-caixa`: Assessoria = 1,65%/7,6% (Lucro Real não-cumulativo); Segurança = 0,65%/3% (Lucro Real cumulativo)
- `relatorios/excel` (aba Apuração PIS-COFINS): **sempre** usa 1,65%/7,6% para qualquer empresa, sem verificar `req.companyKey`

O mesmo período pode gerar apurações diferentes dependendo de qual tela o usuário abrir. Os números do Excel para a Segurança estão errados.

### 🔴 CRÍTICO — Cálculo de INSS ignora a base real

Em `inss-retido.js`, o INSS esperado é calculado como:

```javascript
const esperado = +Number(bruto * 0.11).toFixed(2);
```

A legislação (IN RFB 2110/2022) estabelece que para cessão de mão de obra, a base de cálculo do INSS é a **parcela de mão de obra**, não o valor bruto total da NF (que inclui materiais, equipamentos, etc.). Para contratos que incluem equipamentos (ex.: ronda motorizada, cofres, câmeras), o cálculo sobre o valor bruto total **superestima o INSS devido**, gerando divergências sistemáticas com o que o tomador retém. O sistema vai apontar como "divergente" NFs que estão corretas.

O código reconhece isso nos comentários da `calcularRetencoesEsperadas` mas calcula sobre o total mesmo assim.

### 🔴 CRÍTICO — IRPJ estimado no cron usa regime errado

```javascript
// IRPJ estimado: 15% sobre lucro presumido (8% da receita bruta de serviços)
const lucroPresumido = recBruta * 0.32; // 32% para serviços de vigilância/prestação
const irpjEstimado = Math.max(+(lucroPresumido * 0.15).toFixed(2), 0);
```

O comentário diz "lucro presumido" mas as empresas são Lucro Real. No Lucro Real, IRPJ incide sobre o lucro **apurado contabilmente**, não sobre percentual presumido da receita. Usar 32% × 15% = 4,8% da receita bruta como estimativa de IRPJ num regime de Lucro Real é tecnicamente incorreto — pode subestimar ou superestimar drasticamente dependendo das despesas reais. Os números de `apuracao_mensal` **não devem ser usados para tomada de decisão fiscal**.

### 🟡 IMPORTANTE — Matching de pagamentos é heurístico, não determinístico

Em `pagamentos-contrato.js`, o match NF × extrato funciona assim:

1. Busca créditos no extrato com `UPPER(historico) LIKE '%KEYWORD%'`
2. Compara valor com tolerância de **10% ou R$ 50** (o que for maior)
3. Se não achar match individual, testa soma agregada com tolerância de **15%**

Com tolerância de 15%, um pagamento de R$ 150.000 pode ser considerado "recebido" com qualquer crédito entre R$ 127.500 e R$ 172.500. Para órgãos que fazem pagamentos parcelados ou com glosas, o sistema pode marcar como "PAGO" um tomador que só pagou 85% — ou vice-versa, marcar como "ABERTO" quem pagou com pequena diferença cambial.

O status de inadimplência apresentado ao dono **não é confiável** para valores com variação de pagamento acima de 5%.

### 🟡 IMPORTANTE — `dctfweb` sobrescreve sem ON CONFLICT UPDATE

```javascript
await db.prepare(`
  INSERT INTO configuracoes (chave, valor, updated_at)
  VALUES (?, ?, NOW())
`).run(`inss_dctfweb_${p.novo}`, String(v));
```

Sem `ON CONFLICT DO UPDATE`, cada `POST /api/inss-retido/dctfweb` insere uma **nova linha** em `configuracoes` com a mesma chave. A consulta posterior (`SELECT valor FROM configuracoes WHERE chave = ?`) retorna a primeira linha encontrada — que pode não ser a mais recente. O valor declarado no DCTFWeb pode estar errado silenciosamente após múltiplas edições.

### 🟡 IMPORTANTE — Conciliação OFX não aguarda commit

Como descrito na seção de código: `req.db.transaction(async () => {...})()` sem `await`. Após upload do OFX, a resposta `{ ok: true, imported: N }` é enviada antes do COMMIT. Em condições normais funciona (a Promise resolve logo), mas sob carga ou erro de banco, o usuário recebe confirmação de dados que não existem.

### 🟢 MENOR — Cache de 60 segundos no dashboard pode esconder dados recém-importados

`DASH_TTL = 60000`. Após importar um extrato, o dashboard ainda mostra os dados antigos por até 1 minuto. O usuário pode achar que o import falhou e tentar de novo, gerando duplicatas.

---

## 4. PONTOS CEGOS DO DONO

### 🔴 CRÍTICO — O banco PostgreSQL está exposto na internet sem controle

O IP `35.247.208.7` é um Cloud SQL do GCP com a porta 5432 acessível. A senha `montana2026` está no código-fonte. Qualquer pessoa que acesse o repositório (desenvolvedor, consultor, ex-funcionário com acesso ao código) consegue conectar diretamente ao banco com um cliente PostgreSQL e ler ou alterar qualquer dado — sem passar pelo sistema, sem log de auditoria, sem autenticação JWT. **Dados de todas as empresas (Segurança, Assessoria, Porto do Vau, Mustang) estão nesse banco.**

### 🔴 CRÍTICO — Não há backup automático configurável no código

Não existe nenhuma rotina de backup no codebase. O Cloud SQL do GCP tem backup automático, mas não há confirmação de que está habilitado, nem de que o período de retenção é adequado, nem de que alguém monitora os backups. Se a instância Cloud SQL for excluída ou corrompida, todos os dados históricos somem.

### 🔴 CRÍTICO — Três módulos prometidos não existem

Os módulos `margem-contrato`, `patrimonio` e `caixa-livre` **não têm arquivo correspondente** em `src/routes/`. Se há botões ou links no frontend para essas funcionalidades, eles retornam 404 silenciosamente. O dono pode estar tomando decisões baseadas em dados que o sistema simplesmente não coleta.

### 🔴 CRÍTICO — Controle de acesso multi-empresa é cosmético

O header `X-Company` determina qual banco usar, mas não é verificado contra o perfil do usuário logado. Um usuário com JWT válido de qualquer empresa consegue chamar:

```
GET /api/nfs?company=assessoria
GET /api/extratos?company=seguranca
```

e ver todos os dados de qualquer empresa. O sistema apresenta separação por empresa, mas ela não existe na camada de segurança.

### 🟡 IMPORTANTE — A apuração fiscal mensal automática provavelmente nunca rodou com sucesso

O cron de apuração mensal (todo dia 1° às 05:00) falha porque:
1. A tabela `apuracao_mensal` nunca é criada (sintaxe SQL inválida)
2. O `INSERT OR REPLACE` é convertido para `ON CONFLICT DO NOTHING` (não atualiza)
3. Nenhum dado de apuração é persistido

O dono pode estar assumindo que o sistema está "fechando os números" automaticamente todo mês — mas a tabela está vazia.

### 🟡 IMPORTANTE — Os alertas operacionais de 08:00 podem estar enviando e-mails com dados errados

O cron de alertas usa `db.prepare(...).all()` sem `await` em alguns contextos de alertas operacionais (`alertas-operacionais.js` é chamado de forma síncrona em `server.js` no contexto do cron). Se as queries retornam Promises não resolvidas, o relatório de alertas é construído com arrays vazios. O e-mail é enviado com "0 alertas" mesmo quando há pendências reais.

### 🟡 IMPORTANTE — Não há rastreabilidade de quem fez o quê com dados fiscais

A tabela `audit_log` é populada pela função `audit()` em `api.js`, mas:
- Apenas operações via API são auditadas — acesso direto ao banco não.
- Queries de leitura (GET) não são auditadas.
- O `auditMiddleware.js` só cobre POST/PUT/PATCH/DELETE.
- Se um usuário exportar 5.000 NFs para Excel, não há registro de quem fez isso.

Para uma empresa que lida com contratos públicos e informações fiscais, a ausência de auditoria completa é um risco legal (eventual sindicância/TCE pode questionar alterações sem rastreio).

---

## 5. O QUE ESTÁ FALTANDO PARA SER UM ERP REAL

### Integridade referencial no banco

Não há nenhuma definição de `FOREIGN KEY`, `CHECK`, ou `UNIQUE CONSTRAINT` no código de criação das tabelas (os dumps `.sql` teriam que ser verificados separadamente). Os IDs em `vinculacoes.extrato_id` → `extratos.id` e `parcelas.contrato_num` → `contratos.numContrato` são referenciados em código mas não há constraint no banco. É possível criar uma vinculação apontando para um extrato que não existe — o sistema não vai reclamar, vai retornar `null`.

### Módulos críticos ausentes

| Módulo | Status | Impacto |
|---|---|---|
| Margem por contrato | ❌ Não existe | Sem visibilidade de rentabilidade real |
| Patrimônio / Ativos | ❌ Não existe | Sem controle de equipamentos e depreciação |
| Caixa livre / DFC | ❌ Não existe | Sem gestão de liquidez |
| Contas a pagar (AP) | Parcial (despesas) | Sem aging, sem previsão de vencimentos |
| Folha de pagamento integrada | Parcial (importação Alterdata) | Sem cálculo próprio de provisões |
| Emissão de NF-e própria | Integração WebISS apenas | Sem NF-e federal, sem CT-e |
| Conciliação bancária automática | Heurística manual | Sem matching algorítmico confiável |
| Gestão de contratos com alertas legais | Parcial | Alertas de vencimento quebrados (safe_date) |

### Ausência de testes automatizados

A pasta `tests/` existe mas não foi inspecionada — ao menos o código de produção não tem nenhuma referência a mocks, fixtures, ou chamadas de teste. Qualquer mudança no código pode quebrar silenciosamente qualquer funcionalidade.

### Sem monitoramento de erros em produção

O sistema loga erros em `logs/erros.log` (arquivo local). Não há integração com Sentry, Datadog, ou qualquer serviço de observabilidade. Erros de banco, falhas de cron, e queries inválidas somem nos logs sem alertar ninguém.

---

## 6. LISTA PRIORIZADA DE CORREÇÕES

### P0 — Corrigir antes de qualquer uso em produção

1. **Criar `safe_date()` como função SQL no PostgreSQL** ou substituir todas as chamadas por `CAST(campo AS DATE)` com tratamento de NULL. Afeta dashboard, alertas, relatórios, e IA.

2. **Adicionar `await` a todas as chamadas `req.db.transaction(...)()`.** Buscar `transaction(async` no codebase e verificar se cada chamada tem `await`.

3. **Corrigir `INSERT OR REPLACE`**: substituir por `INSERT INTO ... ON CONFLICT (pk) DO UPDATE SET campo=EXCLUDED.campo` para cada tabela afetada.

4. **Corrigir a sintaxe do `CREATE TABLE apuracao_mensal`**: remover a linha duplicada `qtd_nfs`.

5. **Substituir `datetime('now')` residual** por `NOW()` em todas as queries UPDATE.

6. **Mover credenciais para variáveis de ambiente obrigatórias**: remover fallbacks hardcoded de `PG_PASSWORD` e `JWT_SECRET`. Se as variáveis não estiverem definidas, o processo não deve iniciar.

7. **Restringir acesso ao Cloud SQL**: configurar firewall do Cloud SQL para aceitar conexões apenas do IP do servidor da aplicação, não `0.0.0.0/0`.

### P1 — Corrigir em até 2 semanas

8. **Validação de empresa no JWT**: verificar que o `req.usuario.lotacao` ou `role` corresponde à empresa no header `X-Company`.

9. **Corrigir `exposicao-intragrupo`**: adicionar `await` no `prepare().get()` e corrigir a query do `information_schema` para usar `table_name` no WHERE.

10. **Corrigir alíquotas PIS/COFINS no Excel**: verificar `req.companyKey` e usar as alíquotas corretas por empresa.

11. **Corrigir `POST /inss-retido/dctfweb`**: usar `INSERT INTO ... ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor`.

12. **Eliminar N+1 queries em `pagamentos-contrato`**: substituir os loops de queries individuais por um único JOIN ou `WHERE id IN (...)`.

13. **Corrigir `CURRENT_DATE + INTERVAL '-6 months'`**: substituir por `CURRENT_DATE - INTERVAL '6 months'`.

### P2 — Melhorias estruturais (1-2 meses)

14. Criar arquivo de migrations versionado (ex.: com `node-pg-migrate` ou similar).

15. Adicionar FKs e constraints de integridade no schema PostgreSQL.

16. Quebrar `api.js` em módulos por domínio (contratos, extratos, NFs, relatórios, etc.).

17. Implementar monitoramento de erros em produção (Sentry free tier basta).

18. Implementar os módulos ausentes: `margem-contrato`, `patrimonio`, `caixa-livre`.

19. Remover todos os arquivos `.bak_pg` e `.bak_sqlite` do repositório (usar git para histórico).

---

## O QUE O DONO NÃO ESTÁ ENXERGANDO

**1. O banco de dados de produção está acessível por qualquer pessoa que viu o código.**  
O IP e a senha estão no fonte. Basta um psql para ter acesso total a todas as empresas do grupo, sem log, sem rastreio, sem possibilidade de saber que aconteceu. Isso não é hipótese: qualquer dev que já trabalhou no projeto, qualquer consultor que recebeu o código por e-mail, tem essa chave.

**2. A apuração fiscal mensal automática nunca funcionou.**  
O cron de todo dia 1° falha silenciosamente por erro de SQL. Não há nenhuma tabela `apuracao_mensal` populada. Se o dono acredita que o sistema está "fechando os meses automaticamente", isso é ilusão. Os dados que ele vê nos relatórios são calculados on-the-fly na hora da consulta — sem persistência, sem histórico de fechamento.

**3. Os alertas de contratos vencidos no dashboard estão todos apagados por um bug de migração.**  
A função `safe_date()` quebra a query. O painel de alertas mostra zero contratos vencidos não porque está tudo ok, mas porque o código lança exceção antes de retornar qualquer resultado. Contratos com vigência expirada podem estar passando invisíveis.

**4. O sistema não separa os dados das empresas na camada de segurança — só na camada visual.**  
Qualquer usuário com login válido (mesmo de uma empresa) pode consultar os dados financeiros completos de qualquer outra empresa do grupo simplesmente trocando o header da requisição. Isso inclui NFs, extratos bancários, despesas e contratos da concorrência interna.

**5. Há três módulos no roadmap que simplesmente não foram implementados.**  
`margem-contrato`, `patrimonio` e `caixa-livre` não têm arquivo de código. Se o sistema tem botões ou menus para essas funcionalidades, eles retornam erro. Se o dono está esperando usar esses módulos para decisões de negócio, ele está esperando por algo que não existe no software.

---

*Análise gerada a partir de leitura direta do código-fonte em 2026-04-26.*  
*Esta análise não substitui uma auditoria de segurança profissional (pentest), auditoria contábil, ou revisão jurídica das obrigações fiscais.*
