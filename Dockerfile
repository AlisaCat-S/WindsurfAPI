# ============================================================
# Stage 1: Extract Language Server binary (multi-arch)
# ============================================================
# amd64 → Codeium apt (apt)        → language_server_linux_x64
# arm64 → Codeium apt (apt-arm64)  → language_server_linux_arm
# Fallback: install-ls.sh from GitHub releases
# ============================================================
FROM node:20-bookworm-slim AS ls-extractor

ARG TARGETARCH

# ── Step 1/6: Install build dependencies ──
RUN echo "\n>>> [1/6] Installing build deps (wget gpg curl ldd)..." \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       wget gpg apt-transport-https ca-certificates curl bash binutils file \
    && rm -rf /var/lib/apt/lists/* \
    && echo ">>> [1/6] Done."

WORKDIR /ls-build
COPY install-ls.sh ./
RUN sed -i 's/\r$//' install-ls.sh && chmod +x install-ls.sh

# ── Step 2/6: Import Codeium GPG key ──
RUN echo "\n>>> [2/6] Importing Codeium GPG key..." \
    && wget -qO- "https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/windsurf.gpg" \
         | gpg --dearmor > /tmp/windsurf-stable.gpg \
    && install -D -o root -g root -m 644 /tmp/windsurf-stable.gpg \
         /etc/apt/keyrings/windsurf-stable.gpg \
    && rm -f /tmp/windsurf-stable.gpg \
    && echo ">>> [2/6] GPG key installed at /etc/apt/keyrings/windsurf-stable.gpg"

# ── Step 3/6: Add Codeium apt source (arch-aware) ──
RUN echo "\n>>> [3/6] Adding Codeium apt source for TARGETARCH=$TARGETARCH..." \
    && if [ "$TARGETARCH" = "arm64" ]; then \
         APT_ARCH="arm64"; \
         APT_REPO="https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/apt-arm64"; \
       else \
         APT_ARCH="amd64"; \
         APT_REPO="https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/apt"; \
       fi \
    && echo "deb [arch=$APT_ARCH signed-by=/etc/apt/keyrings/windsurf-stable.gpg] $APT_REPO stable main" \
         > /etc/apt/sources.list.d/windsurf.list \
    && cat /etc/apt/sources.list.d/windsurf.list \
    && echo ">>> [3/6] Apt source added."

# ── Step 4/6: Install windsurf package ──
RUN echo "\n>>> [4/6] Installing windsurf package via apt..." \
    && apt-get update \
    && apt-get install -y --no-install-recommends windsurf \
    && echo ">>> [4/6] windsurf package installed." \
    && dpkg -l windsurf 2>/dev/null | tail -1 || true

# ── Step 5/6: Locate & copy LS binary ──
RUN echo "\n>>> [5/6] Locating Language Server binary..." \
    && mkdir -p /opt/windsurf/data/db \
    && if [ "$TARGETARCH" = "arm64" ]; then \
         LS_SEARCH="language_server_linux_arm"; \
       else \
         LS_SEARCH="language_server_linux_x64"; \
       fi \
    && echo "    Searching for: $LS_SEARCH" \
    && LS_FILE=$(find /usr -name "$LS_SEARCH" 2>/dev/null | head -1) \
    && if [ -z "$LS_FILE" ]; then \
         echo "    Primary name not found, trying wildcard language_server_linux_*"; \
         LS_FILE=$(find /usr -name "language_server_linux_*" 2>/dev/null | head -1); \
       fi \
    && if [ -n "$LS_FILE" ]; then \
         echo "    ✅ Found: $LS_FILE" \
         && cp "$LS_FILE" /opt/windsurf/language_server_linux_x64; \
       else \
         echo "    ⚠️  Not found via apt, falling back to install-ls.sh" \
         && LS_INSTALL_PATH=/opt/windsurf/language_server_linux_x64 ./install-ls.sh; \
       fi \
    && chmod +x /opt/windsurf/language_server_linux_x64 \
    && echo "" \
    && echo "    ── Binary info ──" \
    && ls -lh /opt/windsurf/language_server_linux_x64 \
    && FILESIZE=$(du -h /opt/windsurf/language_server_linux_x64 | cut -f1) \
    && echo "    Size: $FILESIZE" \
    && file /opt/windsurf/language_server_linux_x64 \
    && echo ">>> [5/6] LS binary ready."

# ── Step 6/6: ldd test ──
RUN echo "\n>>> [6/6] Running ldd to verify binary dependencies..." \
    && echo "" \
    && if ldd /opt/windsurf/language_server_linux_x64 2>&1; then \
         echo "" \
         && echo "    ✅ ldd passed — all shared libraries resolved"; \
       else \
         echo "" \
         && echo "    ⚠️  ldd reported issues (may be static binary or missing libs)"; \
         echo "    Attempting direct execution test..." \
         && /opt/windsurf/language_server_linux_x64 --help 2>&1 | head -3 || true; \
       fi \
    && echo ">>> [6/6] Verification complete." \
    && echo "" \
    && echo "========================================" \
    && echo "  LS binary baked successfully!" \
    && echo "  Arch:  $TARGETARCH" \
    && echo "  Path:  /opt/windsurf/language_server_linux_x64" \
    && echo "  Size:  $(du -h /opt/windsurf/language_server_linux_x64 | cut -f1)" \
    && echo "========================================"


# ============================================================
# Stage 2: Final runtime image
# ============================================================
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3003 \
    DATA_DIR=/data \
    LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64 \
    LS_PORT=42100

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY src ./src
COPY install-ls.sh setup.sh .env.example ./
COPY docker-entrypoint.sh ./

RUN sed -i 's/\r$//' install-ls.sh setup.sh docker-entrypoint.sh \
    && chmod +x install-ls.sh setup.sh docker-entrypoint.sh \
    && mkdir -p /data /opt/windsurf/data/db /tmp/windsurf-workspace

# Bake LS binary from extractor stage.
# /opt/windsurf-builtin/ is a staging copy — entrypoint restores
# the binary when /opt/windsurf is mounted as an empty volume.
COPY --from=ls-extractor /opt/windsurf/language_server_linux_x64 /opt/windsurf-builtin/language_server_linux_x64
COPY --from=ls-extractor /opt/windsurf/language_server_linux_x64 /opt/windsurf/language_server_linux_x64
RUN chmod +x /opt/windsurf/language_server_linux_x64 /opt/windsurf-builtin/language_server_linux_x64

EXPOSE 3003

VOLUME ["/data", "/opt/windsurf", "/tmp/windsurf-workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
