# Setup SMTP — Receber emails do Quality-Checks

Hoje os crons de quality-checks (07h diário) e alertas operacionais (08h) tentam enviar email mas **falham** com erro:

```
Invalid login: 535-5.7.8 Username and Password not accepted
https://support.google.com/mail/?p=BadCredentials
```

Isso significa que **a configuração SMTP existe mas as credenciais estão inválidas** (provavelmente Gmail revogou a senha antiga ou usa "App Password" agora).

## Passo 1 — Ver configuração atual

```bash
PGPASSWORD='montana2026' psql -h 35.247.208.7 -U montana -d montana_erp -c "
SELECT chave, LEFT(COALESCE(valor,''), 60) AS valor
FROM assessoria.configuracoes
WHERE chave LIKE 'smtp_%'
ORDER BY chave;
"
```

Provavelmente tem:
- `smtp_host` = `smtp.gmail.com`
- `smtp_port` = `587`
- `smtp_user` = `seu-email@gmail.com`
- `smtp_pass` = `<senha antiga inválida>`
- `smtp_from` = `Montana ERP <noreply@seu-domínio>`
- `smtp_to` = destinatários separados por vírgula

## Passo 2 — Gerar App Password do Gmail

Gmail bloqueia senhas normais desde 2022. Use **App Password** (16 caracteres):

1. Acesse: https://myaccount.google.com/security
2. **2FA precisa estar ATIVADO** (se não estiver, ative)
3. Em "Senhas de app" → **Selecionar app**: "Outro" → digitar "Montana ERP"
4. **Gerar** — vai aparecer uma senha de 16 caracteres tipo `abcd efgh ijkl mnop`
5. **Copie essa senha** (sem espaços ao colar) — só aparece uma vez

## Passo 3 — Atualizar no DB

```bash
PGPASSWORD='montana2026' psql -h 35.247.208.7 -U montana -d montana_erp <<'SQL'

UPDATE assessoria.configuracoes
SET valor = 'COLE_AQUI_APP_PASSWORD_16_CHARS'
WHERE chave = 'smtp_pass';

-- Confirma:
SELECT chave, LEFT(valor, 30) AS valor FROM assessoria.configuracoes WHERE chave LIKE 'smtp_%';

SQL
```

## Passo 4 — Testar manualmente

```bash
sudo node /opt/montana/app_unificado/src/jobs/quality-checks.js --email
```

Esperado:
- Console mostra `✓ Email enviado pra <seu-email>`
- Você recebe email com alertas P0/P1/P2 do dia

## Alternativas ao Gmail (se preferir)

### SendGrid (gratuito até 100 emails/dia)

1. Cadastre em sendgrid.com
2. Verifique domínio próprio (precisa CNAME no DNS)
3. Atualize:
   ```sql
   UPDATE configuracoes SET valor = 'smtp.sendgrid.net' WHERE chave = 'smtp_host';
   UPDATE configuracoes SET valor = '587' WHERE chave = 'smtp_port';
   UPDATE configuracoes SET valor = 'apikey' WHERE chave = 'smtp_user';
   UPDATE configuracoes SET valor = '<sua_api_key>' WHERE chave = 'smtp_pass';
   UPDATE configuracoes SET valor = 'noreply@seudominio.com.br' WHERE chave = 'smtp_from';
   ```

### AWS SES (R$ 0,50 por mil emails)

Similar ao SendGrid, mas usa credenciais IAM. Mais robusto, mas curva de aprendizado maior.

### Mailgun

Plano gratuito até 100 emails/dia (Foundation Trial).

## Multi-empresa

Hoje só Assessoria tem SMTP configurado. Pra Segurança/PortoVau/Mustang:

```bash
# Replicar configuração (mesmas credenciais)
PGPASSWORD='montana2026' psql -h 35.247.208.7 -U montana -d montana_erp <<'SQL'
INSERT INTO seguranca.configuracoes (chave, valor)
SELECT chave, valor FROM assessoria.configuracoes WHERE chave LIKE 'smtp_%'
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;

INSERT INTO portodovau.configuracoes (chave, valor)
SELECT chave, valor FROM assessoria.configuracoes WHERE chave LIKE 'smtp_%'
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;

INSERT INTO mustang.configuracoes (chave, valor)
SELECT chave, valor FROM assessoria.configuracoes WHERE chave LIKE 'smtp_%'
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
SQL
```

## Tempo estimado

| Tarefa | Tempo |
|--------|------:|
| Gerar App Password Gmail | 5 min |
| Atualizar SQL | 30 seg |
| Testar | 2 min |
| Replicar pras outras 3 empresas | 1 min |
| **Total** | **~10 min** |
