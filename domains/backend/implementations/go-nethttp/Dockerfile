FROM golang:1.27.4-trixie AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .

FROM gcr.io/distroless/static-debian13:latest@sha256:1a64f46364620465ef9e9a8f5413757dfdf22695e050bbfd7303eeaf17a59383
COPY --from=build /app /app
ENV DB_URL=postgres://bench:bench@127.0.0.1:5432/bench?pool_max_conns=16
EXPOSE 8080
ENTRYPOINT ["/app"]
