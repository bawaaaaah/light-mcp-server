# light-mcp-server — remote server image (Linux amd64/arm64, e.g. Raspberry Pi).
# MIDI reaches it over RTP-MIDI (built in); local MIDI needs the host's ALSA sequencer (see docs).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
# Machine config, venues, shows, private files: mount a volume here.
VOLUME ["/app/data"]
# HTTP + WebSocket + MCP, OSC, RTP-MIDI (control + data), Art-Net, sACN
EXPOSE 8790/tcp 9000/udp 5004/udp 5005/udp 6454/udp 5568/udp
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli/main.js", "serve"]
