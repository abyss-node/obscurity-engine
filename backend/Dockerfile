FROM rust:1.75-slim as builder

WORKDIR /usr/src/app
# Install system deps required by openssl/reqwest
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --release

# Distroless or small debian runner
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/app/target/release/backend /usr/local/bin/backend

# Railway/Render automatically provide the PORT variable
ENV PORT=8000
EXPOSE ${PORT}

CMD ["backend"]
