FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci || npm install
COPY client/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S pulseboard && adduser -S pulseboard -G pulseboard
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p data && chown -R pulseboard:pulseboard /app
USER pulseboard
ENV PORT=5060
ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 5060
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5060/api/health >/dev/null || exit 1
CMD ["node", "server/src/index.js"]
