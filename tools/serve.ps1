param([int]$Port = 8000)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')

$mime = @{
  '.html' = 'text/html'; '.js' = 'text/javascript'; '.mjs' = 'text/javascript'
  '.css' = 'text/css'; '.json' = 'application/json'
  '.webmanifest' = 'application/manifest+json'; '.wasm' = 'application/wasm'
  '.onnx' = 'application/octet-stream'; '.mp4' = 'video/mp4'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'
}

function Send-Status($res, [int]$code, [string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $res.StatusCode = $code
  $res.ContentType = 'text/plain'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$Port/"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $res.Headers.Add('Cache-Control', 'no-store')
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    $full = [System.IO.Path]::GetFullPath((Join-Path $root ($rel -replace '/', '\')))
    if ($full -ne $root -and -not $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-Status $res 403 'Forbidden'
    } else {
      if (Test-Path -LiteralPath $full -PathType Container) { $full = Join-Path $full 'index.html' }
      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Send-Status $res 404 'Not found'
      } else {
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Accept-Ranges', 'bytes')
        $fs = [System.IO.File]::Open($full, 'Open', 'Read', 'ReadWrite')
        try {
          $len = $fs.Length
          $start = 0L; $end = $len - 1
          $partial = $false
          if ($req.Headers['Range'] -match '^bytes=(\d*)-(\d*)$') {
            $a = $Matches[1]; $b = $Matches[2]
            if ($a -ne '') {
              $start = [long]$a
              if ($b -ne '') { $end = [Math]::Min([long]$b, $len - 1) }
            } elseif ($b -ne '') {
              $start = [Math]::Max(0L, $len - [long]$b)
            }
            $partial = $true
          }
          if ($partial -and ($start -gt $end -or $start -ge $len)) {
            $res.Headers.Add('Content-Range', "bytes */$len")
            Send-Status $res 416 'Range not satisfiable'
          } else {
            if ($partial) {
              $res.StatusCode = 206
              $res.Headers.Add('Content-Range', "bytes $start-$end/$len")
            }
            $count = $end - $start + 1
            $res.ContentLength64 = $count
            if ($req.HttpMethod -ne 'HEAD') {
              $fs.Seek($start, 'Begin') | Out-Null
              $buf = New-Object byte[] 65536
              $remaining = $count
              while ($remaining -gt 0) {
                $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $remaining))
                if ($n -le 0) { break }
                $res.OutputStream.Write($buf, 0, $n)
                $remaining -= $n
              }
            }
          }
        } finally { $fs.Dispose() }
      }
    }
  } catch {
    Write-Host "Request error: $($req.RawUrl) $($_.Exception.Message)"
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.Close() } catch {}
  }
}
