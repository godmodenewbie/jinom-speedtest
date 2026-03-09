# Build
FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum* ./
COPY main.go ./
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o /app/speedtest .

# Runtime
FROM alpine:3.20
WORKDIR /app
COPY --from=build /app/speedtest /speedtest
ENV NODE_ID=node-1 REGION=id-dps MAX_DURATION_SEC=30 ADDR=:8080
EXPOSE 8080
CMD ["/speedtest"]
