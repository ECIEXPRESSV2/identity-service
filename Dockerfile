FROM node:20-alpine
WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma generate && pnpm run build

EXPOSE 3000

# Migraciones al INICIAR (Prisma): el contenedor corre dentro de la VNet y alcanza el
# Postgres privado. `prisma migrate deploy` es idempotente y seguro para reaplicar.
# Luego arranca la app.
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/main.js"]
