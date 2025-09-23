package main

import (
  "encoding/json"
  "log"
  "net/http"
  "os"
  "strings"
)

type ServerInfo struct {
  ID     string  `json:"id"`
  Region string  `json:"region"`
  City   string  `json:"city"`
  URL    string  `json:"url"`
  Status string  `json:"status"`
  Load   float64 `json:"load"`
}

func withCORS(h http.HandlerFunc) http.HandlerFunc {
  return func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Access-Control-Allow-Origin", "*")
    w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
    if r.Method == "OPTIONS" { w.WriteHeader(204); return }
    h(w, r)
  }
}

func main() {
  def := `[{"id":"node-dps","region":"id-dps","city":"Denpasar","url":"http://localhost:8080","status":"up","load":0.02},
           {"id":"node-jkt","region":"id-jkt","city":"Jakarta","url":"http://localhost:8081","status":"up","load":0.03}]`
  raw := os.Getenv("SERVERS_JSON")
  if strings.TrimSpace(raw) == "" { raw = def }

  var servers []ServerInfo
  if err := json.Unmarshal([]byte(raw), &servers); err != nil {
    log.Fatal("invalid SERVERS_JSON:", err)
  }

  mux := http.NewServeMux()

  mux.HandleFunc("/healthz", withCORS(func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(200); _, _ = w.Write([]byte("ok"))
  }))

  mux.HandleFunc("/api/v1/servers", withCORS(func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(servers)
  }))

  mux.HandleFunc("/api/v1/choose", withCORS(func(w http.ResponseWriter, r *http.Request) {
    prefer := r.URL.Query().Get("prefer")
    choice := servers[0]
    if prefer != "" {
      for _, s := range servers {
        if s.Region == prefer { choice = s; break }
      }
    }
    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(choice)
  }))

  addr := ":8088"
  log.Println("Directory service listening on", addr)
  log.Fatal(http.ListenAndServe(addr, mux))
}
