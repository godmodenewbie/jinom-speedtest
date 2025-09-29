# Jinom Speedtest (Multi-POP)

## Services
- speedtest-node: `/api/v1/latency`, `/api/v1/download`, `/api/v1/upload`, `/api/v1/config`
- directory-service: `/api/v1/servers`, `/api/v1/choose`
- client: UI sederhana (http://localhost:8082)

## Run
```bash
docker compose up --build -d
# stop:
docker compose down
