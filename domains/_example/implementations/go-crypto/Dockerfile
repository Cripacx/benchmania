FROM golang:1.27.4-alpine AS build
WORKDIR /src
COPY main.go .
RUN go mod init bench && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bench .

FROM alpine:3.22.8
COPY --from=build /bench /bench
