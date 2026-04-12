# 🌐 Guia: Configurar DNS para sistema.grupomontanasec.com

**IP do servidor GCP:** `104.196.22.170`  
**Domínio:** `sistema.grupomontanasec.com`

---

## Onde configurar?

O DNS é configurado no painel de onde o domínio `grupomontanasec.com` foi registrado.  
As opções mais comuns são:

- **Registro.br** — https://registro.br (domínio .com.br)
- **GoDaddy** — https://godaddy.com
- **Cloudflare** — https://cloudflare.com
- **HostGator / Locaweb** — painel do provedor de hospedagem

> **Como saber onde está?** Acesse https://registro.br/pesquisa e busque `grupomontanasec.com.br` — mostrará os nameservers.

---

## Passo a passo (Registro.br)

1. Acesse **https://registro.br** → Login
2. Clique em **grupomontanasec.com.br**
3. Vá em **Configurar DNS** (ou "Zona DNS")
4. Clique em **+ Adicionar registro**
5. Preencha:
   - **Tipo:** `A`
   - **Nome/Host:** `sistema`
   - **Valor/Destino:** `104.196.22.170`
   - **TTL:** `3600` (1 hora)
6. Salve

---

## Passo a passo (Cloudflare)

1. Acesse **dash.cloudflare.com**
2. Selecione o domínio `grupomontanasec.com`
3. Vá em **DNS → Records**
4. Clique em **Add record**
5. Preencha:
   - **Type:** `A`
   - **Name:** `sistema`
   - **IPv4 address:** `104.196.22.170`
   - **Proxy status:** 🟠 DNS only (não proxied, pelo menos inicialmente)
   - **TTL:** Auto
6. Clique em **Save**

---

## Passo a passo (GoDaddy)

1. Acesse **https://dcc.godaddy.com**
2. Selecione o domínio
3. Vá em **DNS → Manage Zones**
4. Clique em **Add** → Tipo **A**
5. Preencha:
   - **Host:** `sistema`
   - **Points to:** `104.196.22.170`
   - **TTL:** 1 Hour
6. Salve

---

## Verificar se propagou

Após salvar, aguarde 5 a 30 minutos e teste:

```bash
ping sistema.grupomontanasec.com
```

Ou acesse online: https://dnschecker.org e busque `sistema.grupomontanasec.com`

Quando resolver para `104.196.22.170`, o DNS está OK.

---

## Ativar HTTPS após o DNS (no servidor)

Depois que o DNS propagar, execute no servidor GCP via SSH:

```bash
bash /opt/montana/app_unificado/scripts/setup-ssl.sh
```

Isso instala o certificado SSL Let's Encrypt gratuito e configura HTTPS automático.  
Após isso, o app estará acessível em:  
**https://sistema.grupomontanasec.com**

---

## Resumo rápido

| Etapa | O que fazer |
|-------|-------------|
| 1 | Adicionar registro DNS tipo A: `sistema` → `104.196.22.170` |
| 2 | Aguardar 5-30 minutos para propagar |
| 3 | Testar: `ping sistema.grupomontanasec.com` |
| 4 | No servidor: `bash scripts/setup-ssl.sh` |
| 5 | Acessar: https://sistema.grupomontanasec.com ✅ |
