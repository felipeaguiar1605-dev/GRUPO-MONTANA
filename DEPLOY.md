# Montana — Deploy na Nuvem

## Visão geral

O sistema é um servidor Node.js que expõe API REST + frontend estático na porta 3002.
Os dados ficam em volumes persistentes (`/app/data` e `/app/certificados`).

---

## Pré-requisitos

- Arquivo `.env` preenchido a partir de `.env.example`
- Certificados `.pfx` na pasta `certificados/` (necessários apenas para emissão de NFS-e)
- Docker instalado (para deploy local ou VPS)

---

## Opção 1 — Railway (recomendado para começar)

1. Crie conta em [railway.app](https://railway.app)
2. Novo projeto → **Deploy from GitHub repo** (ou faça push do código)
3. Railway detecta o `Dockerfile` automaticamente
4. Configure as variáveis de ambiente em **Variables** (copiar do `.env.example`):
   - `JWT_SECRET`, `ADMIN_SENHA`, `FINANCEIRO_SENHA`
   - `WEBISS_*` (login, senha, inscrição municipal, cert senha por empresa)
   - `SMTP_*` (opcional, para alertas por e-mail)
5. Monte um **Volume** em `/app/data` (persistência dos bancos SQLite)
6. O healthcheck em `/api/health` é detectado automaticamente
7. URL pública gerada: `https://seu-projeto.railway.app`

> **Certificados:** Faça upload dos `.pfx` via Railway Volume ou via SSH após o deploy.
> Os arquivos vão para `/app/certificados/` dentro do container.

---

## Opção 2 — Render

1. Crie conta em [render.com](https://render.com)
2. Novo serviço → **Web Service** → conectar repositório Git
3. Render usa o `Dockerfile` automaticamente
4. Em **Environment** adicione as variáveis do `.env.example`
5. Em **Disks** adicione um disco em `/app/data` (necessário para SQLite persistente)
6. Healthcheck path: `/api/health`
7. URL pública: `https://seu-projeto.onrender.com`

> **Atenção Render free tier:** o serviço dorme após 15 min de inatividade.
> Para produção, use o plano pago ($7/mês).

---

## Opção 3 — VPS (maior controle, recomendado para produção)

Exemplos: DigitalOcean Droplet, Contabo, Hostinger VPS.

```bash
# 1. Instalar Docker no servidor (Ubuntu)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 2. Clonar / copiar o código
git clone <seu-repo> /opt/montana
cd /opt/montana

# 3. Criar o .env a partir do exemplo
cp .env.example .env
nano .env   # preencher os valores reais

# 4. Copiar certificados
mkdir -p certificados
cp /caminho/local/*.pfx certificados/

# 5. Subir o container
docker compose up -d

# 6. Ver logs
docker compose logs -f

# 7. Verificar saúde
curl http://localhost:3002/api/health
```

Para expor na internet com HTTPS, instale **Nginx + Certbot**:

```bash
sudo apt install nginx certbot python3-certbot-nginx -y

# Criar config /etc/nginx/sites-available/montana
server {
    listen 80;
    server_name seu-dominio.com.br;
    location / {
        proxy_pass http://localhost:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

sudo ln -s /etc/nginx/sites-available/montana /etc/nginx/sites-enabled/
sudo certbot --nginx -d seu-dominio.com.br
sudo systemctl reload nginx
```

---

## CORS em produção

O servidor atualmente aceita apenas `localhost`. Após ter a URL definitiva,
adicione ao `src/server.js` a origem da nuvem:

```javascript
// Substituir o teste de CORS por:
const ALLOWED = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/seu-projeto\.railway\.app$/,   // ← sua URL aqui
];
if (!origin || ALLOWED.some(r => r.test(origin))) {
  res.header('Access-Control-Allow-Origin', origin || '*');
}
```

---

## Backup dos dados (SQLite)

Os bancos ficam em `data/<empresa>/montana.db`. Para backup automático no VPS:

```bash
# crontab -e
0 3 * * * tar czf /backup/montana-$(date +\%Y\%m\%d).tar.gz /opt/montana/data/ && find /backup -name "montana-*.tar.gz" -mtime +30 -delete
```

---

## Acesso multi-usuário e celular

- Com HTTPS ativo, o site pode ser instalado como PWA no celular:
  Safari/Chrome → "Adicionar à Tela de Início"
- Cada usuário faz login com suas credenciais (JWT 8h)
- Níveis de acesso: `admin` (tudo) | `financeiro` (leitura + lançamentos)
- Gestão de usuários adicionais: aba **Usuários** no sistema

---

## Variáveis de ambiente obrigatórias

| Variável | Descrição |
|---|---|
| `JWT_SECRET` | String aleatória longa (min 32 chars) |
| `ADMIN_SENHA` | Senha do usuário admin |
| `FINANCEIRO_SENHA` | Senha do usuário financeiro |
| `PORT` | Porta (padrão 3002) |

As demais (`WEBISS_*`, `SMTP_*`) são opcionais — o sistema funciona sem elas,
mas emissão de NFS-e e alertas por e-mail ficarão desativados.
