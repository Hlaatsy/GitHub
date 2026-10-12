# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./
USER node
EXPOSE 5000
# `migrate deploy` applies the versioned migrations, including the CHECK
# constraints that `prisma db push` would silently skip.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]
