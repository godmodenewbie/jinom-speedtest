# Build
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN go build -o /app/directory .

# Runtime
FROM alpine:3.20
WORKDIR /app
COPY --from=build /app/directory /directory
ENV ADDR=:8088
EXPOSE 8088
CMD ["/directory"]
