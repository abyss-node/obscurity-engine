### Railway GitHub auto-deploy build (context = repo root).
### Railway deploys the backend from `main` using this file (see railway.json).
### Paths are prefixed with `backend/` because the build context is the repo
### root. Local dev and manual `railway up` still use backend/Dockerfile +
### backend/railway.toml (context = backend/).
FROM rust:slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY backend/Cargo.toml backend/Cargo.lock ./
# Cache deps before copying source
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release && rm -rf src
COPY backend/src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/backend .
EXPOSE 8080
CMD ["./backend"]
