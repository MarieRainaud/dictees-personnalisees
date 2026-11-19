FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_PATH=/data/application.sqlite
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache su-exec && npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node content ./content
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node app.json ./app.json
VOLUME /data
COPY --chmod=755 scripts/container-start.sh /usr/local/bin/atelier-start
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/atelier-start"]
CMD ["node","server/index.mjs"]
