# Plano de Migração — Local → Cloud (Google)
> Criado em: 2026-04-05
> Estratégia: migração incremental por fases, sem downtime e sem pressa

---

## Situação Atual
```
PC Windows local → SQLite → Node.js/Express → porta 3002
Acesso: só no PC que roda o app
```

---

## Fase 1 — VM na Nuvem (Google Compute Engine) ⭐ PRÓXIMO PASSO
> **Zero mudança no código. SQLite continua. App idêntico ao de hoje.**

**O que faz:**
- Coloca o app em um servidor Linux na Google Cloud
- Acesso de qualquer lugar: `http://IP:3002`
- Múltiplos PCs podem usar simultaneamente
- Roda 24h mesmo com o PC local desligado

**Como fazer:**
1. Criar conta Google Cloud (cartão de crédito para verificação, não cobra)
2. Criar VM `e2-micro` nas regiões `us-east1` ou `us-west1` (tier gratuito permanente)
   - 1 vCPU, 1GB RAM, 30GB disco — suficiente para o uso da Montana
3. Instalar Node.js v20 LTS na VM
4. Fazer upload do projeto (via `git clone` ou `scp`)
5. Ajustar paths do SQLite: `C:\Users\...` → `/home/usuario/...`
6. Instalar dependências: `npm install`
7. Instalar `pm2` para manter o app rodando: `npm install -g pm2`
8. Iniciar: `pm2 start src/server.js --name montana`
9. Abrir porta 3002 no Firewall do Google Cloud (regra de rede)
10. Testar acesso pelo IP externo

**Duração estimada:** 1h30
**Custo:** Grátis (e2-micro tier gratuito permanente)
**Risco:** Baixo

---

## Fase 2 — HTTPS + Domínio Próprio
> **Depois que a Fase 1 estiver estável por alguns dias**

**O que faz:**
- Troca `http://IP:3002` por `https://sistema.montanaseg.com.br`
- Certificado SSL grátis (Let's Encrypt via Certbot)
- Nginx como proxy reverso (porta 443 → porta 3002)

**Como fazer:**
1. Registrar domínio (ex: montanaseg.com.br) — ~R$40/ano no registro.br
2. Apontar DNS do domínio para o IP da VM
3. Instalar Nginx na VM
4. Configurar proxy reverso Nginx → porta 3002
5. Instalar Certbot e emitir certificado SSL gratuito
6. Recarregar Nginx com HTTPS

**Duração estimada:** 3h
**Custo:** ~R$40/ano (só o domínio)
**Risco:** Baixo

---

## Fase 3 — Backup Automático do Banco
> **Fazer junto ou logo após a Fase 2**

**O que faz:**
- Script diário que copia os 4 arquivos `.db` para o Google Drive
- 30 dias de histórico
- Em caso de problema: restaura em 10 minutos

**Como fazer:**
1. Instalar `rclone` na VM (ferramenta de sync com Google Drive)
2. Autenticar rclone com conta Google
3. Criar script `backup.sh`:
   ```bash
   #!/bin/bash
   DATE=$(date +%Y-%m-%d)
   rclone copy /home/usuario/app/data/ gdrive:Montana-Backups/$DATE/
   find /home/usuario/backups -mtime +30 -delete
   ```
4. Agendar via cron: `0 23 * * * /home/usuario/backup.sh`

**Duração estimada:** 2h
**Custo:** Grátis (Google Drive 15GB grátis)
**Risco:** Zero

---

## Fase 4 — Migrar Banco para PostgreSQL
> **Só quando quiser escalar ou preparar o SaaS. Não tem urgência.**

**O que faz:**
- Substitui SQLite por PostgreSQL (banco robusto, multi-conexão, cloud-native)
- Habilita uso do Cloud Run e futuro SaaS multi-tenant
- Melhora performance com muitos usuários simultâneos

**Escopo de trabalho:**
- ~3.100 linhas de `src/api.js` a converter (queries síncronas → assíncronas)
- `better-sqlite3` → `pg` (node-postgres)
- Sintaxe SQL: `datetime('now')` → `NOW()`, etc.
- 4 bancos separados → estrutura multi-schema ou multi-tenant
- Migração dos dados existentes via script ETL

**Estratégia recomendada (por módulo):**
1. Contratos e NFs
2. Extratos e despesas
3. Folha RH
4. Auditoria e configurações

**Duração estimada:** 5 dias de trabalho
**Custo:** Grátis no [Neon.tech](https://neon.tech) (PostgreSQL serverless) ou ~R$50/mês no Cloud SQL
**Risco:** Médio — fazer em branch separado, testar extensivamente

---

## Fase 5 — Migrar para Cloud Run
> **Só depois da Fase 4 concluída e estabilizada**

**O que faz:**
- Empacota o app em container Docker
- Deploy no Google Cloud Run (serverless, escala automática)
- Desliga a VM (elimina custo fixo)
- Base para multi-tenant / SaaS

**Como fazer:**
1. Criar `Dockerfile` na raiz do projeto
2. Testar container localmente
3. Fazer build e push para Google Container Registry
4. Deploy no Cloud Run com variáveis de ambiente
5. Configurar domínio no Cloud Run
6. Desligar a VM da Fase 1

**Duração estimada:** 2 dias
**Custo:** Grátis no nível de uso atual (2 milhões requests/mês grátis)
**Risco:** Baixo (código já adaptado na Fase 4)

---

## Visão Geral

```
HOJE          FASE 1        FASE 2        FASE 3        FASE 4        FASE 5
──────────    ──────────    ──────────    ──────────    ──────────    ──────────
PC local   →  VM Google  →  HTTPS +    →  Backup     →  PostgreSQL→  Cloud Run
SQLite        SQLite        Domínio       Google Drive  (migração)    (Docker)
porta 3002    porta 3002    porta 443     cron diário
              1h30          3h            2h            5 dias        2 dias
              GRÁTIS        R$40/ano      GRÁTIS        Neon free     GRÁTIS
```

---

## Decisão: Incremental vs. Big Bang

**Recomendação: INCREMENTAL**

- Fase 1 já resolve o problema de múltiplos PCs → fazer logo
- Fases 2 e 3 são baixo risco → fazer na sequência
- Fase 4 só faz sentido quando quiser virar SaaS ou tiver problema de performance
- Fase 5 é consequência natural da Fase 4

**Não vale esperar tudo pronto** para colocar no ar. O SQLite na VM aguenta meses ou anos no nível de uso da Montana.

---

## Referências
- [Google Cloud Free Tier](https://cloud.google.com/free)
- [Neon.tech — PostgreSQL serverless grátis](https://neon.tech)
- [pm2 — Process Manager Node.js](https://pm2.keymetrics.io)
- [Certbot — SSL grátis](https://certbot.eff.org)
- [registro.br — Domínio .com.br](https://registro.br)
