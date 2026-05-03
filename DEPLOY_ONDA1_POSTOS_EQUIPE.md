# Deploy ONDA 1 — Postos & Equipes

> Tela operacional pra você ver de uma vez: **60 postos × 1.081 funcionários cadastrados**.
>
> Resolve a dor: "não consigo acompanhar o escritório via sistema".

---

## O que está pronto (commitado)

1. **Backend**: `src/routes/postos-equipe.js`
   - `GET /api/postos-equipe` — lista postos com sumário equipe
   - `GET /api/postos-equipe/:posto_id` — detalhe + funcionários
   - `GET /api/postos-equipe/sem-posto` — funcionários sem posto resolvível
   - `POST /api/postos-equipe/:func_id/atribuir-posto` — atribuir manual

2. **Frontend**: `public/app-postos-equipe.js`
   - Função global `showPostosEquipe()`
   - KPIs no topo (postos, funcionários, folha estimada)
   - Lista agrupada por contrato
   - Click no posto → modal com funcionários
   - Botão "Sem posto" → revisa funcionários órfãos

3. **Wire**: `src/server.js` + `public/index.html`
   - Rota `/api/postos-equipe` registrada
   - Script frontend carregado

## Deploy no servidor (5 min)

```bash
cd /opt/montana/app_unificado

# 1. Pull do GitHub (se autenticação OK; senão use curl pra cada arquivo)
git pull origin claude/quizzical-pike-5e952d

# OU baixar via curl:
BASE="https://raw.githubusercontent.com/felipeaguiar1605-dev/GRUPO-MONTANA/claude/quizzical-pike-5e952d"
sudo curl -fsSL -o src/routes/postos-equipe.js "${BASE}/src/routes/postos-equipe.js"
sudo curl -fsSL -o public/app-postos-equipe.js "${BASE}/public/app-postos-equipe.js"

# 2. Wire no server.js — adicionar 2 linhas após "/api/usuarios":
#    app.use('/api/postos-equipe', require('./routes/postos-equipe'));
#    try { app.use('/api/quality-checks', require('./routes/quality-checks')); } catch(_) {}

# 3. Wire no index.html — adicionar antes de </body>:
#    <script src="/app-postos-equipe.js"></script>

# 4. Sintaxe + reload
node --check src/routes/postos-equipe.js
node --check src/server.js
pm2 reload montana-app

# 5. Testar
curl -fsS http://localhost:3002/api/health
```

## Como acessar

Após deploy, no navegador:

**Opção 1 — direto via Console (F12):**
```js
showPostosEquipe()
```

**Opção 2 — adicionar item no menu lateral em index.html:**
```html
<a href="javascript:void(0)" onclick="showPostosEquipe()" class="menu-link">
  👥 Postos & Equipes
</a>
```

## O que esperar ver

```
👥 POSTOS & EQUIPES — Assessoria

KPIs:
  🏢 Postos:               60
  👥 Funcionários ativos:  592
  ⚠ Sem posto definido:   ~XX  (depende da heurística)
  💰 Folha estimada:       R$ X.XM
  📑 Contratos ativos:     12

LISTA (agrupada por contrato):

📑 DETRAN-TO Limpeza
   ├─ Sede Palmas      | Palmas      | 5 funcionários | R$ 17.4k folha
   ├─ Filial Araguaína | Araguaína   | 3 funcionários | R$ 10.2k folha
   ├─ Filial Paraíso   | Paraíso     | 0 (vazio)      | —
   └─ ...

📑 UFT Limpeza e ATOP
   └─ ...
```

Click no posto → modal com lista nominal de funcionários.

## Heurística de matching

Como `rh_funcionarios.posto_id` está vazio (NULL pra os 592), o backend tenta casar via texto:

```sql
posto resolvido = primeiro match entre:
  rh_funcionarios.lotacao  contém  bol_postos.campus_nome
  OU
  rh_funcionarios.lotacao  contém  bol_postos.descricao_posto
  OU
  bol_postos.campus_nome   contém  rh_funcionarios.lotacao
```

**Funciona bem se** os nomes baterem (ex: lotacao="DETRAN SEDE", posto="Sede Palmas DETRAN").

**Não funciona se** os nomes divergirem totalmente (ex: lotacao="ESCRITÓRIO", posto="Sede DETRAN").

## ONDA 2 (próxima sessão)

Botão na UI pra você revisar manualmente os funcionários "sem posto" e atribuir 1 a 1 com dropdown — depois disso o `posto_id` fica preenchido e a heurística não é mais necessária.

## ONDA 3 (depois)

- Cockpit Executivo agregando 8 áreas (RH, DP, Financeiro, Jurídico, Compras, Estoque, Certidões, Contratos)
- Auto-vincular `bol_boletim_colaboradores` quando boletim mensal é gerado
- Importar ponto eletrônico
- Cadastrar férias e atestados via UI
