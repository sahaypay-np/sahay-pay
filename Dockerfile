FROM node:24-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the app (public/ is the frontend SPA; server/ is the backend)
COPY server ./server
COPY public ./public

# Upload + local-data dirs (SQLite fallback uses data/ when no DATABASE_URL)
RUN mkdir -p uploads/public uploads/private data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
