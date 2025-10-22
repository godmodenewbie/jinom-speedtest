# Dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/dirsvc main.go

FROM alpine:3.20
RUN adduser -D -u 10001 app && mkdir -p /app/static /app/data && chown -R app:app /app 
WORKDIR /app
COPY --from=build /out/dirsvc /usr/local/bin/dirsvc
COPY static/ ./static/
USER app
EXPOSE 8088
ENV BIND_ADDR=:8088 \
    ADMIN_TOKEN=changeme-admin-token \
    PUBLIC_CORS_ORIGIN=* \
    ADMIN_CORS_ORIGIN=*
VOLUME ["/app/data"]
ENTRYPOINT ["/usr/local/bin/dirsvc"]
