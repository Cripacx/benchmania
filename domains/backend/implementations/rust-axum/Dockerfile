FROM rust:1.100.0-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian13:latest@sha256:809d04afa1be033c441f76bb0051878c342fb76d0ea236bc6dc94b655fa0fbd6
COPY --from=build /src/target/release/bench /app
ENV DB_URL=postgres://bench:bench@127.0.0.1:5432/bench
EXPOSE 8080
ENTRYPOINT ["/app"]
