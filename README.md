# Jinom Speedtest (Multi-POP, Docker Compose)

## Services
- **speedtest-node**: endpoint `/api/v1/latency`, `/api/v1/download`, `/api/v1/upload`, `/api/v1/config`
- **directory-service**: endpoint `/api/v1/servers`, `/api/v1/choose`

## Run (Docker Compose)
```bash
docker compose up --build -d
# stop
docker compose down
