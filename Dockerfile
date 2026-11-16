# Image tout-en-un : serveur Rust + frontend compilé. Aucune donnée ni secret dedans :
#   /etc/bks/config.toml  configuration (BKS_CONFIG), montée en lecture seule
#   /etc/bks/eb.pem       clé privée Enable Banking, montée en lecture seule
#   /data                 base SQLite (volume)
# Ports : 9889 public (tunnel), 9890 interface locale sans authentification (jamais exposée).

FROM node:24-bookworm-slim AS web
WORKDIR /web
RUN npm install -g pnpm@12.18.0
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM rust:1.98-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends libssl-dev pkg-config cmake clang && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Dépendances d'abord (couche en cache tant que Cargo.lock ne change pas).
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 bks \
 && useradd --system --uid 10001 --gid 10001 --home-dir /data --no-create-home bks \
 && install -d -o bks -g bks -m 0700 /data
COPY --from=server /src/target/release/bks /usr/local/bin/bks
COPY --from=web /web/dist /app/web/dist
# Le mois « en cours » dépend du fuseau.
# BKS_CONTAINER : autorise l'écoute sur 0.0.0.0 (interface du conteneur), refusée hors conteneur.
ENV BKS_CONFIG=/etc/bks/config.toml BKS_CONTAINER=1 TZ=Europe/Paris RUST_LOG=info
WORKDIR /app
USER bks
VOLUME /data
EXPOSE 9889 9890
ENTRYPOINT ["/usr/local/bin/bks"]
