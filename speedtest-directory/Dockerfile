# ===== build stage =====
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
# cache modul supaya build cepat & nggak butuh go.sum dari host
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
# pastikan folder static ada (walau kosong) agar COPY di stage berikut tidak error
RUN mkdir -p /src/static
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/dirsvc main.go

# ===== runtime stage =====
FROM alpine:3.20
#RUN adduser -D -u 10001 app && mkdir -p /app/static /app/data && chown -R app:app /app && chown -R 10001:10001 /app/data
RUN adduser -D -u 10001 app && mkdir -p /app/static /app/data && chown -R app:app /app
WORKDIR /app
COPY --from=build /out/dirsvc /usr/local/bin/dirsvc
COPY --from=build /src/static/ ./static/
USER app
EXPOSE 8088
ENV BIND_ADDR=:8088 \
    ADMIN_TOKEN=changeme-admin-token \
    PUBLIC_CORS_ORIGIN=* \
    ADMIN_CORS_ORIGIN=* \
    PING_INTERVAL_SEC=60 \
    SQLITE_DSN=file:/app/data/dir.db?_pragma=busy_timeout=5000&_pragma=journal_mode(WAL)
VOLUME ["/app/data"]
ENTRYPOINT ["/usr/local/bin/dirsvc"]
