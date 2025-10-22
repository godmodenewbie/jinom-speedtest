package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
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
	adminCORS   string
	pingEvery   time.Duration
	httpClient  *http.Client
	bindAddr    string
	sqliteDSN   string
)

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	// ===== Config =====
	adminToken = getenv("ADMIN_TOKEN", "changeme-admin-token")
	publicCORS = getenv("PUBLIC_CORS_ORIGIN", "*")
	adminCORS = getenv("ADMIN_CORS_ORIGIN", "*")
	bindAddr = getenv("BIND_ADDR", ":9088")
	pingSec := getenv("PING_INTERVAL_SEC", "60")
	sqliteDSN = getenv("SQLITE_DSN", "file:data/dir.db?_pragma=busy_timeout=5000&_pragma=journal_mode(WAL)")

	// Parse ping interval
	if sec, err := time.ParseDuration(pingSec + "s"); err == nil && sec > 0 {
		pingEvery = sec
	} else {
		pingEvery = 60 * time.Second
	}

	// Ensure data dir exists (for default DSN)
	_ = os.MkdirAll("data", 0755)

	// HTTP client (tight timeouts)
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

	// ===== DB =====
	var err error
	db, err = sql.Open("sqlite", sqliteDSN)
	must(err)
	must(migrate())

	// ===== Router =====
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Serve dashboard static if present; else simple root
	if dirExists("./static") {
		r.Handle("/*", http.FileServer(http.Dir("./static")))
	} else {
		r.Get("/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("Directory API\nGET /api/v1/servers\nGET /api/v1/servers/all\n"))
		})
	}

	r.Route("/api/v1", func(api chi.Router) {
		// Public endpoints (for web client)
		api.With(cors(publicCORS)).Get("/servers", apiListActiveServers)

		// Ops/debug
		api.With(cors(adminCORS)).Get("/servers/all", apiListAllServers)
		api.With(cors(adminCORS)).Get("/health", apiHealth)

		// Admin (mutating) with bearer
		api.With(cors(adminCORS), bearerAuth).Post("/servers", apiCreateServer)
		api.With(cors(adminCORS), bearerAuth).Put("/servers/{id}", apiUpdateServer)
		api.With(cors(adminCORS), bearerAuth).Delete("/servers/{id}", apiDeleteServer)
	})

	// ===== Ping worker =====
	go pingWorker(context.Background(), pingEvery)

	log.Printf("Directory service listening on %s (ping interval %s)\n", bindAddr, pingEvery)
	must(http.ListenAndServe(bindAddr, r))
}

/* ======================== DB ======================== */

func migrate() error {
	stmt := `
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
	_, err := db.Exec(stmt)
	return err
}

/* ======================== MIDDLEWARE ======================== */

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

func bearerAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, prefix) || strings.TrimSpace(h[len(prefix):]) != adminToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

/* ======================== API ======================== */

func apiListActiveServers(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`
SELECT id,region,city,url,status,load
FROM servers
WHERE status='UP'
ORDER BY load ASC,
         COALESCE(last_latency_ms, 1e12) ASC,
         updated_at DESC`)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()
	var out []ServerRow
	for rows.Next() {
		var s ServerRow
		if err := rows.Scan(&s.ID, &s.Region, &s.City, &s.URL, &s.Status, &s.Load); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		out = append(out, s)
	}
	writeJSON(w, out)
}

func apiListAllServers(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(`
SELECT id,region,city,url,status,load,last_ping_at,last_latency_ms,created_at,updated_at
FROM servers
ORDER BY updated_at DESC`)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()
	var out []ServerRow
	for rows.Next() {
		var s ServerRow
		var lpa sql.NullTime
		var lat sql.NullFloat64
		if err := rows.Scan(&s.ID, &s.Region, &s.City, &s.URL, &s.Status, &s.Load, &lpa, &lat, &s.CreatedAt, &s.UpdatedAt); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if lpa.Valid {
			t := lpa.Time.UTC()
			s.LastPingAt = &t
		}
		if lat.Valid {
			v := lat.Float64
			s.LastLatencyMs = &v
		}
		out = append(out, s)
	}
	writeJSON(w, out)
}

func apiCreateServer(w http.ResponseWriter, r *http.Request) {
	var in ServerRow
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", 400)
		return
	}
	in.ID = strings.TrimSpace(in.ID)
	in.Region = strings.TrimSpace(in.Region)
	in.City = strings.TrimSpace(in.City)
	in.URL = strings.TrimRight(strings.TrimSpace(in.URL), "/")
	if in.ID == "" || in.Region == "" || in.City == "" || in.URL == "" {
		http.Error(w, "id, region, city, url required", 400)
		return
	}
	if in.Status == "" {
		in.Status = "UNKNOWN"
	}
	if _, err := db.Exec(`INSERT INTO servers (id,region,city,url,status,load) VALUES (?,?,?,?,?,?)`,
		in.ID, in.Region, in.City, in.URL, in.Status, in.Load); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func apiUpdateServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		http.Error(w, "missing id", 400)
		return
	}
	var in ServerRow
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", 400)
		return
	}
	parts := []string{}
	args := []any{}
	if in.Region != "" {
		parts = append(parts, "region=?")
		args = append(args, in.Region)
	}
	if in.City != "" {
		parts = append(parts, "city=?")
		args = append(args, in.City)
	}
	if in.URL != "" {
		parts = append(parts, "url=?")
		args = append(args, strings.TrimRight(in.URL, "/"))
	}
	if in.Status != "" {
		parts = append(parts, "status=?")
		args = append(args, in.Status)
	}
	if in.Load != 0 {
		parts = append(parts, "load=?")
		args = append(args, in.Load)
	}
	if len(parts) == 0 {
		writeJSON(w, map[string]any{"ok": true})
		return
	}
	parts = append(parts, "updated_at=CURRENT_TIMESTAMP")
	q := "UPDATE servers SET " + strings.Join(parts, ",") + " WHERE id=?"
	args = append(args, id)
	if _, err := db.Exec(q, args...); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func apiDeleteServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		http.Error(w, "missing id", 400)
		return
	}
	if _, err := db.Exec(`DELETE FROM servers WHERE id=?`, id); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func apiHealth(w http.ResponseWriter, r *http.Request) {
	var up, down int
	_ = db.QueryRow(`SELECT COUNT(*) FROM servers WHERE status='UP'`).Scan(&up)
	_ = db.QueryRow(`SELECT COUNT(*) FROM servers WHERE status='DOWN'`).Scan(&down)
	var last sql.NullTime
	_ = db.QueryRow(`SELECT MAX(last_ping_at) FROM servers`).Scan(&last)
	var lastPing any
	if last.Valid {
		lastPing = last.Time.UTC()
	} else {
		lastPing = nil
	}
	writeJSON(w, map[string]any{
		"up":        up,
		"down":      down,
		"lastPingAt": lastPing,
	})
}

/* ======================== PING WORKER ======================== */

func pingWorker(ctx context.Context, every time.Duration) {
	// Run once at start
	go pingAllOnce()

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
	if err != nil {
		log.Println("ping list:", err)
		return
	}
	defer rows.Close()

	type item struct{ id, url string }
	var all []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.url); err == nil && it.id != "" && it.url != "" {
			all = append(all, it)
		}
	}

	sem := make(chan struct{}, 10) // small worker pool
	for _, it := range all {
		sem <- struct{}{}
		go func(it item) {
			defer func() { <-sem }()
			latMs, ok := measureLatency(it.url)
			status := "DOWN"
			var latPtr any = nil
			if ok {
				status = "UP"
				latPtr = latMs
			}
			_, _ = db.Exec(`UPDATE servers
				SET status=?, last_ping_at=?, last_latency_ms=?, updated_at=CURRENT_TIMESTAMP
				WHERE id=?`, status, time.Now().UTC(), latPtr, it.id)
		}(it)
	}

	// drain
	for i := 0; i < cap(sem); i++ {
		sem <- struct{}{}
	}
}

func measureLatency(base string) (float64, bool) {
	u := strings.TrimRight(base, "/") + "/api/v1/latency?t=" + nonce()
	start := time.Now()
	req, _ := http.NewRequest("GET", u, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return float64(time.Since(start).Milliseconds()), true
	}
	return 0, false
}

/* ======================== HELPERS ======================== */

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func nonce() string {
	// simple non-crypto nonce for cache-bust
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
