// main.go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	_ "modernc.org/sqlite"
)

type ServerRow struct {
	ID            string     `json:"id"`
	Region        string     `json:"region"`
	City          string     `json:"city"`
	URL           string     `json:"url"`
	Status        string     `json:"status"` // UP | DOWN | UNKNOWN
	Load          float64    `json:"load"`
	LastPingAt    *time.Time `json:"lastPingAt,omitempty"`
	LastLatencyMs *float64   `json:"lastLatencyMs,omitempty"`
	CreatedAt     time.Time  `json:"-"`
	UpdatedAt     time.Time  `json:"-"`
}

var (
	db          *sql.DB
	adminToken  string
	publicCORS  string
	pingEvery   time.Duration
	httpClient  *http.Client
	bindAddr    string
	adminOrigin string
)

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	// === Config ===
	adminToken = getenv("ADMIN_TOKEN", "changeme-admin-token")
	publicCORS = getenv("PUBLIC_CORS_ORIGIN", "*")                       // origin yang boleh GET servers
	adminOrigin = getenv("ADMIN_CORS_ORIGIN", "*")                       // origin dashboard
	pingEvery = time.Duration(mustParseInt(getenv("PING_INTERVAL_SEC", "60"))) * time.Second
	bindAddr = getenv("BIND_ADDR", ":9088")                              // default sama seperti dir lama
	dsn := getenv("SQLITE_DSN", "file:data/dir.db?_pragma=busy_timeout=5000&_pragma=journal_mode(WAL)")
	_ = os.MkdirAll("data", 0755)

	// HTTP client untuk ping (timeout ketat)
	httpClient = &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			MaxIdleConns:        200,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
			DialContext: (&net.Dialer{
				Timeout:   2 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
		},
	}

	// === DB ===
	var err error
	db, err = sql.Open("sqlite", dsn)
	must(err)
	must(migrate())

	// === Router ===
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// static admin (dashboard)
	r.Handle("/*", http.FileServer(http.Dir("./static")))

	// API
	r.Route("/api/v1", func(api chi.Router) {
		// public
		api.With(cors(publicCORS)).Get("/servers", apiListActiveServers)
		api.With(cors(adminOrigin)).Get("/servers/all", apiListAllServers)
		api.With(cors(adminOrigin)).Get("/health", apiHealth)

		// admin (bearer)
		api.With(cors(adminOrigin), bearerAuth).Post("/servers", apiCreateServer)
		api.With(cors(adminOrigin), bearerAuth).Put("/servers/{id}", apiUpdateServer)
		api.With(cors(adminOrigin), bearerAuth).Delete("/servers/{id}", apiDeleteServer)
	})

	// === Ping worker ===
	go pingWorker(context.Background(), pingEvery)

	log.Printf("Directory service up on %s (ping interval %s)\n", bindAddr, pingEvery)
	must(http.ListenAndServe(bindAddr, r))
}

// ---------- DB MIGRATION ----------
func migrate() error {
	sqlStmt := `
CREATE TABLE IF NOT EXISTS servers(
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  city TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  load REAL NOT NULL DEFAULT 0,
  last_ping_at TIMESTAMP NULL,
  last_latency_ms REAL NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
`
	_, err := db.Exec(sqlStmt)
	return err
}

// ---------- HELPERS ----------
func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
func mustParseInt(s string) int {
	i := 0
	_, err := fmtSscanf(s, "%d", &i)
	if err != nil {
		// fallback manual
		if v, e := parseIntSimple(s); e == nil {
			return v
		}
		return 60
	}
	return i
}
func parseIntSimple(s string) (int, error) {
	var n int
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0, errors.New("bad int")
		}
		n = n*10 + int(ch-'0')
	}
	return n, nil
}
func fmtSscanf(str, format string, a ...any) (int, error) {
	return fmtSscanfImpl(str, format, a...)
}
func fmtSscanfImpl(str, format string, a ...any) (int, error) { // tiny wrapper to avoid pulling fmt
	// minimalistic parse only for "%d"
	if format != "%d" || len(a) != 1 {
		return 0, errors.New("unsupported sscanf")
	}
	vp, ok := a[0].(*int)
	if !ok {
		return 0, errors.New("not *int")
	}
	n, err := parseIntSimple(strings.TrimSpace(str))
	if err != nil {
		return 0, err
	}
	*vp = n
	return 1, nil
}
func nowPtr() *time.Time { t := time.Now().UTC(); return &t }

// ---------- CORS ----------
func cors(allowOrigin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if allowOrigin == "*" && origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			} else {
				w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
			}
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ---------- AUTH ----------
func bearerAuth(next http.Handler) http.Handler {
	prefix := "Bearer "
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, prefix) || strings.TrimSpace(h[len(prefix):]) != adminToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- API HANDLERS ----------
func apiListActiveServers(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`SELECT id,region,city,url,status,load FROM servers WHERE status='UP' ORDER BY load ASC, last_latency_ms ASC NULLS LAST, updated_at DESC`)
	if err != nil { http.Error(w, err.Error(), 500); return }
	defer rows.Close()
	var out []ServerRow
	for rows.Next() {
		var s ServerRow
		if err := rows.Scan(&s.ID, &s.Region, &s.City, &s.URL, &s.Status, &s.Load); err != nil {
			http.Error(w, err.Error(), 500); return
		}
		out = append(out, s)
	}
	writeJSON(w, out)
}

func apiListAllServers(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`SELECT id,region,city,url,status,load,last_ping_at,last_latency_ms,created_at,updated_at FROM servers ORDER BY updated_at DESC`)
	if err != nil { http.Error(w, err.Error(), 500); return }
	defer rows.Close()
	var out []ServerRow
	for rows.Next() {
		var s ServerRow
		var lpa sql.NullTime
		var lat sql.NullFloat64
		if err := rows.Scan(&s.ID,&s.Region,&s.City,&s.URL,&s.Status,&s.Load,&lpa,&lat,&s.CreatedAt,&s.UpdatedAt); err != nil {
			http.Error(w, err.Error(), 500); return
		}
		if lpa.Valid { s.LastPingAt = &lpa.Time }
		if lat.Valid { v := lat.Float64; s.LastLatencyMs = &v }
		out = append(out, s)
	}
	writeJSON(w, out)
}

func apiCreateServer(w http.ResponseWriter, r *http.Request) {
	var in ServerRow
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil { http.Error(w, "bad json", 400); return }
	// basic validation
	in.ID = strings.TrimSpace(in.ID)
	in.URL = strings.TrimSpace(in.URL)
	if in.ID == "" || in.URL == "" || in.City == "" || in.Region == "" {
		http.Error(w, "id, region, city, url required", 400); return
	}
	if in.Status == "" { in.Status = "UNKNOWN" }
	if _, err := db.Exec(`INSERT INTO servers (id,region,city,url,status,load) VALUES (?,?,?,?,?,?)`,
		in.ID, in.Region, in.City, in.URL, in.Status, in.Load); err != nil {
		http.Error(w, err.Error(), 500); return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func apiUpdateServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" { http.Error(w, "missing id", 400); return }
	var in ServerRow
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil { http.Error(w, "bad json", 400); return }

	// build dynamic update
	fields := []string{}
	args := []any{}
	if in.Region != "" { fields = append(fields, "region=?"); args = append(args, in.Region) }
	if in.City != "" { fields = append(fields, "city=?"); args = append(args, in.City) }
	if in.URL != "" { fields = append(fields, "url=?"); args = append(args, in.URL) }
	if in.Status != "" { fields = append(fields, "status=?"); args = append(args, in.Status) }
	if in.Load != 0 { fields = append(fields, "load=?"); args = append(args, in.Load) }
	if len(fields) == 0 { writeJSON(w, map[string]any{"ok": true}); return }
	fields = append(fields, "updated_at=CURRENT_TIMESTAMP")
	q := "UPDATE servers SET " + strings.Join(fields, ",") + " WHERE id=?"
	args = append(args, id)
	if _, err := db.Exec(q, args...); err != nil {
		http.Error(w, err.Error(), 500); return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func apiDeleteServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" { http.Error(w, "missing id", 400); return }
	if _, err := db.Exec(`DELETE FROM servers WHERE id=?`, id); err != nil {
		http.Error(w, err.Error(), 500); return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func apiHealth(w http.ResponseWriter, r *http.Request) {
	var up, down int
	_ = db.QueryRow(`SELECT COUNT(*) FROM servers WHERE status='UP'`).Scan(&up)
	_ = db.QueryRow(`SELECT COUNT(*) FROM servers WHERE status='DOWN'`).Scan(&down)
	var last time.Time
	_ = db.QueryRow(`SELECT COALESCE(MAX(last_ping_at), '1970-01-01') FROM servers`).Scan(&last)
	writeJSON(w, map[string]any{
		"up": up, "down": down, "lastPingAt": last.UTC(),
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// ---------- PING WORKER ----------
func pingWorker(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pingAllOnce()
		}
	}
}

func pingAllOnce() {
	rows, err := db.Query(`SELECT id,url FROM servers`)
	if err != nil { log.Println("ping list:", err); return }
	defer rows.Close()

	type item struct{ id, url string }
	var all []item
	for rows.Next() {
		var it item
		_ = rows.Scan(&it.id, &it.url)
		if it.id != "" && it.url != "" { all = append(all, it) }
	}

	// worker pool kecil
	sem := make(chan struct{}, 10)
	for _, it := range all {
		sem <- struct{}{}
		go func(it item) {
			defer func(){ <-sem }()
			latMs, ok := measureLatency(it.url)
			status := "DOWN"
			if ok { status = "UP" }
			_, _ = db.Exec(`UPDATE servers SET status=?, last_ping_at=?, last_latency_ms=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
				status, nowPtr(), nullableFloat(latMs), it.id)
		}(it)
	}
	// drain
	for i := 0; i < cap(sem); i++ { sem <- struct{}{} }
}

func measureLatency(base string) (float64, bool) {
	start := time.Now()
	req, _ := http.NewRequest("GET", strings.TrimRight(base, "/")+"/api/v1/latency?t="+randStr(), nil)
	resp, err := httpClient.Do(req)
	if err != nil { return 0, false }
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return float64(time.Since(start).Milliseconds()), true
	}
	return 0, false
}

func nullableFloat(v float64) any {
	if v == 0 { return nil }
	return v
}

// tiny random suffix (no crypto)
func randStr() string {
	n := time.Now().UnixNano()
	return strings.ReplaceAll(time.Unix(0, n).Format("150405.000000000"), ".", "")
}
