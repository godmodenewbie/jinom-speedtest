<?php
/**
 * Jinom Speedtest client (Ookla-like JSON)
 * - CLI usage:
 *   php client.php --directory=http://192.168.30.3:9088 --prefer=id-jkt --seconds=10 --streams=8
 *   php client.php --node=http://192.168.30.3:9080 --seconds=10 --streams=8
 *
 * - HTTP usage (browser):
 *   client.php?directory=http://192.168.30.3:9088&prefer=id-jkt&seconds=10&streams=8
 *   client.php?node=http://192.168.30.3:9080&seconds=10&streams=8
 */

declare(strict_types=1);
@ini_set('memory_limit', '-1');
@set_time_limit(0);

if (php_sapi_name() !== 'cli') {
  header('Content-Type: application/json');
  header('Cache-Control: no-store');
}

function argval(string $k, $def = null) {
  static $cli = null;
  if ($cli === null) {
    $cli = [];
    global $argv;
    foreach ($argv ?? [] as $a) {
      if (strpos($a, '--') === 0) {
        $p = explode('=', substr($a, 2), 2);
        $cli[$p[0]] = $p[1] ?? true;
      }
    }
  }
  if (isset($_GET[$k])) return $_GET[$k];
  if (isset($cli[$k])) return $cli[$k];
  return $def;
}

$directory = rtrim((string)argval('directory', ''), '/');
$prefer    = (string)argval('prefer', '');
$node      = rtrim((string)argval('node', ''), '/');
$seconds   = max(3, min(60, (int)argval('seconds', 10)));
$streams   = max(1, min(32, (int)argval('streams', 8)));
$samples   = max(5, min(30, (int)argval('samples', 10)));

function http_get_json(string $url) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 10,
  ]);
  $body = curl_exec($ch);
  if ($body === false) throw new RuntimeException('GET error: ' . curl_error($ch));
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  if ($code < 200 || $code >= 300) throw new RuntimeException("GET $url -> HTTP $code");
  $j = json_decode($body, true);
  if (!is_array($j)) throw new RuntimeException("Invalid JSON from $url");
  return $j;
}

function pick_node(string $directory, string $prefer): array {
  if (!$directory) throw new InvalidArgumentException("directory required");
  $url = $directory . '/api/v1/choose';
  if ($prefer) $url .= '?prefer=' . rawurlencode($prefer);
  $j = http_get_json($url);
  // expected fields: url, region, city, id_alias
  return [
    'id'     => $j['id_alias'] ?? ($j['id'] ?? 'node'),
    'region' => $j['region'] ?? '',
    'city'   => $j['city'] ?? '',
    'url'    => rtrim($j['url'] ?? '', '/'),
  ];
}

// ---------- latency ----------
function measure_latency(string $base, int $samples = 10): array {
  $times = [];
  for ($i = 0; $i < $samples; $i++) {
    $t0 = microtime(true);
    $ch = curl_init($base . '/api/v1/latency?t=' . mt_rand());
    curl_setopt_array($ch, [
      CURLOPT_NOBODY => true,
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_CONNECTTIMEOUT_MS => 1500,
      CURLOPT_TIMEOUT_MS => 3000,
    ]);
    curl_exec($ch);
    curl_close($ch);
    $dt = (microtime(true) - $t0) * 1000.0;
    $times[] = $dt;
  }
  $avg = array_sum($times) / count($times);
  $var = 0.0;
  foreach ($times as $x) { $var += ($x - $avg) * ($x - $avg); }
  $jitter = sqrt($var / count($times));
  return ['avg_ms' => $avg, 'jitter_ms' => $jitter, 'samples' => $times];
}

// ---------- download (multi) ----------
function download_test(string $base, int $seconds, int $streams): array {
  $mh = curl_multi_init();
  $end = microtime(true) + $seconds;
  $total = 0;

  $make = function() use ($base, &$total) {
    $ch = curl_init($base . '/api/v1/download?time=2');
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => false,
      CURLOPT_WRITEFUNCTION => function($ch, $data) use (&$total) {
        $len = strlen($data);
        $total += $len;
        return $len;
      },
      CURLOPT_CONNECTTIMEOUT => 3,
      CURLOPT_TIMEOUT => 0, // stream
    ]);
    return $ch;
  };

  $handles = [];
  for ($i = 0; $i < $streams; $i++) {
    $h = $make();
    $handles[] = $h;
    curl_multi_add_handle($mh, $h);
  }

  $start = microtime(true);
  do {
    $running = 0;
    curl_multi_exec($mh, $running);
    // process finished handles and respawn if time not over
    while ($info = curl_multi_info_read($mh)) {
      $h = $info['handle'];
      curl_multi_remove_handle($mh, $h);
      curl_close($h);
      if (microtime(true) < $end) {
        $h2 = $make();
        curl_multi_add_handle($mh, $h2);
      }
    }
    if ($running) curl_multi_select($mh, 0.2);
  } while (microtime(true) < $end);

  // stop everything now
  foreach ($handles as $h) { @curl_multi_remove_handle($mh, $h); @curl_close($h); }
  curl_multi_close($mh);

  $elapsed_ms = max(1, (int)round((microtime(true) - $start) * 1000.0));
  $mbps = ($total * 8.0) / ($elapsed_ms / 1000.0) / 1e6;
  return ['bytes' => $total, 'elapsed_ms' => $elapsed_ms, 'mbps' => $mbps];
}

// ---------- upload (multi, streaming body) ----------
function upload_test(string $base, int $seconds, int $streams): array {
  $mh = curl_multi_init();
  $responses = [];
  $jsons = []; // per handle response json
  $chunk = random_bytes(1 << 20); // 1 MiB random

  $make = function(int $sec) use ($base, $chunk, &$responses, &$jsons) {
    $respBuf = '';
    $streamEnd = microtime(true) + $sec;
    $readfn = function($ch, $fd, $length) use ($chunk, $streamEnd) {
      if (microtime(true) >= $streamEnd) return ''; // EOF -> stop
      // cap chunk to libcurl's requested $length
      $len = min(strlen($chunk), $length);
      return substr($chunk, 0, $len);
    };
    $writefn = function($ch, $data) use (&$respBuf) {
      $respBuf .= $data;
      return strlen($data);
    };
    $ch = curl_init($base . '/api/v1/upload?time=' . $sec);
    curl_setopt_array($ch, [
      CURLOPT_CUSTOMREQUEST => 'POST',
      CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
      CURLOPT_HTTPHEADER => ['Content-Type: application/octet-stream', 'Expect:'],
      CURLOPT_READFUNCTION => $readfn,
      CURLOPT_UPLOAD => true,        // enable upload from callback
      CURLOPT_INFILESIZE => -1,      // chunked
      CURLOPT_WRITEFUNCTION => $writefn,
      CURLOPT_RETURNTRANSFER => false,
      CURLOPT_CONNECTTIMEOUT => 5,
      CURLOPT_TIMEOUT => 0,          // stream until EOF
    ]);
    // pocket to retrieve body later
    $id = spl_object_id($ch);
    $responses[$id] = &$respBuf;
    $jsons[$id] = null;
    return $ch;
  };

  $handles = [];
  for ($i = 0; $i < $streams; $i++) {
    $h = $make($seconds);
    $handles[] = $h;
    curl_multi_add_handle($mh, $h);
  }

  $start = microtime(true);
  do {
    $running = 0;
    curl_multi_exec($mh, $running);
    if ($running) curl_multi_select($mh, 0.2);
  } while ($running);

  $total_recv = 0;
  $max_dur_ms = 1;
  foreach ($handles as $h) {
    $id = spl_object_id($h);
    // parse JSON per stream
    $raw = $responses[$id] ?? '';
    @curl_multi_remove_handle($mh, $h);
    @curl_close($h);
    $j = json_decode($raw, true);
    if (is_array($j)) {
      $rx = (int)($j['receivedBytes'] ?? 0);
      $dur= (int)($j['durationMs'] ?? 0);
      $total_recv += $rx;
      if ($dur > $max_dur_ms) $max_dur_ms = $dur;
    }
  }
  curl_multi_close($mh);

  // elapsed secara keseluruhan (wall clock)
  $elapsed_ms = max($max_dur_ms, (int)round((microtime(true) - $start) * 1000.0));
  $mbps = ($total_recv * 8.0) / ($elapsed_ms / 1000.0) / 1e6;
  return ['bytes' => $total_recv, 'elapsed_ms' => $elapsed_ms, 'mbps' => $mbps];
}

// ---------- choose node ----------
$server = [
  'id'     => 'node',
  'region' => '',
  'city'   => '',
  'url'    => '',
];

try {
  if ($node) {
    $server['url'] = $node;
  } elseif ($directory) {
    $server = pick_node($directory, $prefer);
  } else {
    throw new InvalidArgumentException('Provide ?node=http://host:port OR ?directory=http://host:port');
  }

  $base = $server['url'];
  if (!$base) throw new RuntimeException('No base URL');

  // run tests
  $lat = measure_latency($base, $samples);
  $down= download_test($base, $seconds, $streams);
  $up  = upload_test($base, $seconds, $streams);

  // Ookla-like JSON
  $out = [
    'type'      => 'result',
    'timestamp' => gmdate('c'),
    'ping'      => [
      'jitter'  => round($lat['jitter_ms'], 2),
      'latency' => round($lat['avg_ms'], 2),
      // 'low'/'high' bisa dihitung dari samples kalau perlu
    ],
    'download'  => [
      'bandwidth' => (int)round(($down['mbps'] * 1e6) / 8), // bytes/sec
      'bytes'     => (int)$down['bytes'],
      'elapsed'   => (int)$down['elapsed_ms'],
    ],
    'upload'    => [
      'bandwidth' => (int)round(($up['mbps'] * 1e6) / 8), // bytes/sec
      'bytes'     => (int)$up['bytes'],
      'elapsed'   => (int)$up['elapsed_ms'],
    ],
    'isp'       => null,
    'interface' => [
      'internalIp' => null, 'name' => 'php-curl', 'isVpn' => false
    ],
    'server'    => [
      'id' => $server['id'],
      'name' => $server['city'] ?: $server['id'],
      'location' => $server['region'],
      'host' => $base,
      'ip' => null, 'port' => null,
    ],
    'result'    => ['id' => null, 'url' => null],
  ];

  echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
  http_response_code(500);
  echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_SLASHES);
}
