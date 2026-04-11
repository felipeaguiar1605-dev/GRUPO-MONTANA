# ─── Montana Multi-Empresa — Dockerfile ───────────────────────────────────────
# Build:   docker build -t montana .
# Run:     docker run -p 3002:3002 --env-file .env -v $(pwd)/data:/app/data montana

FROM node:20-alpine

# Dependências nativas do better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Instalar dependências primeiro (cache de layers)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código-fonte
COPY src/ ./src/
COPY public/ ./public/

# Pasta de dados — será montada como volume em produção
RUN mkdir -p data/assessoria data/seguranca data/portodovau data/mustang \
    data/assessoria/uploads data/seguranca/uploads \
    data/portodovau/uploads data/mustang/uploads \
    certificados

# Pasta de certificados — será montada como volume
VOLUME ["/app/data", "/app/certificados"]

EXPOSE 3002

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
