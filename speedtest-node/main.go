package main

import (
  "crypto/rand"
  "encoding/json"
  "io"
  "log"
  "net/http"
  "os"
  "strconv"
  "time"
)

var chunk = make([]byte, 1<<20) // 1 MiB random

func getenv(k, def string) string {
  if v := os.Getenv(k); v != "" { return v }
  return def
}
func getenvInt(k string, def int) int {
  if v := os.Getenv(k); v != "" {
    if n, err := strconv.Atoi(v); err == nil { return n }
  }
  return def
}

/*func withCORS(h http.HandlerFunc) http.HandlerFunc {
  return func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Access-Control-Allow-Origin", "*") // ganti ke domain tertentu di prod
    w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
    if r.Method == "OPTIONS" { w.WriteHeader(204); return }
    h(w, r)
  }
}*/

func withCORS(h http.HandlerFunc) http.HandlerFunc {
  return func(w http.ResponseWriter, r *http.Request) {
    origin := r.Header.Get("Origin")
    if origin == "" {
      w.Header().Set("Access-Control-Allow-Origin", "*")
    } else {
      w.Header().Set("Access-Control-Allow-Origin", origin)
      w.Header().Set("Vary", "Origin")
    }
    w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

    // >>> penting untuk Private Network Access (akses 192.168.x.x dari browser)
    if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
      w.Header().Set("Access-Control-Allow-Private-Network", "true")
    }

    if r.Method == http.MethodOptions {
      w.WriteHeader(204)
      return
    }
    h(w, r)
  }
}


func main() {
  if _, err := rand.Read(chunk); err != nil { panic(err) }

  nodeID := getenv("NODE_ID", "node-1")
  region := getenv("REGION", "id-dps")
  maxDur := getenvInt("MAX_DURATION_SEC", 30)
  addr   := getenv("ADDR", ":8080")

  mux := http.NewServeMux()

  mux.HandleFunc("/healthz", withCORS(func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(200); _, _ = w.Write([]byte("ok"))
  }))

  mux.HandleFunc("/api/v1/config", withCORS(func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(map[string]any{
      "nodeId": nodeID, "region": region, "maxStreams": 16, "maxDurationSec": maxDur,
    })
  }))

  mux.HandleFunc("/api/v1/latency", withCORS(func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(204)
  }))

  mux.HandleFunc("/api/v1/download", withCORS(func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/octet-stream")
    w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")

    q := r.URL.Query()
    timeSec, _ := strconv.ParseInt(q.Get("time"), 10, 64)
    bytesTarget, _ := strconv.ParseInt(q.Get("bytes"), 10, 64)

    start := time.Now()
    var deadline time.Time
    if timeSec > 0 { deadline = start.Add(time.Duration(timeSec) * time.Second) }

    var sent int64
    fl, _ := w.(http.Flusher)
    for {
      if !deadline.IsZero() && time.Now().After(deadline) { break }
      if bytesTarget > 0 && sent >= bytesTarget { break }
      if _, err := w.Write(chunk); err != nil { break }
      sent += int64(len(chunk))
      if fl != nil { fl.Flush() }
    }
  }))

  /*mux.HandleFunc("/api/v1/upload", withCORS(func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Cache-Control", "no-store")
    q := r.URL.Query()
    timeSec, _ := strconv.ParseInt(q.Get("time"), 10, 64)

    start := time.Now()
    var deadline time.Time
    if timeSec > 0 { deadline = start.Add(time.Duration(timeSec) * time.Second) }

    var received int64
    buf := make([]byte, 1<<20)
    for {
      if !deadline.IsZero() && time.Now().After(deadline) { break }
      n, err := r.Body.Read(buf)
      if n > 0 { received += int64(n) }
      if err == io.EOF { break }
      if err != nil { break }
    }
    _ = json.NewEncoder(w).Encode(map[string]any{
      "receivedBytes": received,
      "durationMs":    time.Since(start).Milliseconds(),
    })
  }))*/

  // PATCH: handler upload yang stabil
mux.HandleFunc("/api/v1/upload", withCORS(func(w http.ResponseWriter, r *http.Request) {
  w.Header().Set("Cache-Control", "no-store")

  // time=... opsional, dipakai sebagai "safety guard"
  q := r.URL.Query()
  timeSec, _ := strconv.Atoi(q.Get("time"))

  start := time.Now()

  // Guard: kalau klien tak menutup stream, paksa close sedikit setelah durasi
  var guard *time.Timer
  if timeSec > 0 {
    guard = time.AfterFunc(time.Duration(timeSec+1)*time.Second, func() {
      _ = r.Body.Close() // memicu EOF di loop baca
    })
    defer guard.Stop()
  }

  var received int64
  buf := make([]byte, 1<<20) // 1 MiB
  for {
    n, err := r.Body.Read(buf)
    if n > 0 { received += int64(n) }
    if err == io.EOF { break }
    if err != nil { break }
  }
  _ = r.Body.Close() // rapikan koneksi

  w.Header().Set("Content-Type", "application/json")
  _ = json.NewEncoder(w).Encode(map[string]any{
    "receivedBytes": received,
    "durationMs":    time.Since(start).Milliseconds(),
  })
}))


  srv := &http.Server{
    Addr:         addr,
    Handler:      mux,
    ReadTimeout:  0,
    WriteTimeout: 0,
    IdleTimeout:  120 * time.Second,
  }

  log.Printf("Speedtest node %s (%s) listening on %s", nodeID, region, addr)
  log.Fatal(srv.ListenAndServe())
}
