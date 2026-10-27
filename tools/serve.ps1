# 本地静态服务器（零依赖，PowerShell + HttpListener）
# 用法： pwsh -File tools\serve.ps1            # 默认 8080
#        pwsh -File tools\serve.ps1 -Port 8099
param(
  [int]$Port = 8080,
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
$prefix = "http://127.0.0.1:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.mjs'  = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.gif'  = 'image/gif'
  '.svg'  = 'image/svg+xml'
  '.ogg'  = 'audio/ogg'
  '.mp3'  = 'audio/mpeg'
  '.wav'  = 'audio/wav'
  '.ico'  = 'image/x-icon'
  '.woff2'= 'font/woff2'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/markdown; charset=utf-8'
}

try {
  $listener.Start()
}
catch {
  Write-Host "无法监听 $prefix : $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "端口可能被占用，换一个： pwsh -File tools\serve.ps1 -Port 8099" -ForegroundColor Yellow
  exit 1
}

Write-Host "派大星的衣柜 · 本地服务已启动" -ForegroundColor Green
Write-Host "  根目录: $Root"
Write-Host "  地址  : $prefix"
Write-Host "  停止  : Ctrl+C"
Write-Host ""

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  }
  catch { break }

  $req = $ctx.Request
  $res = $ctx.Response
  $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }

  $full = Join-Path $Root $rel
  try {
    $resolved = (Resolve-Path -LiteralPath $full -ErrorAction Stop).Path
  }
  catch {
    $res.StatusCode = 404
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
    $res.ContentType = 'text/plain; charset=utf-8'
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
    Write-Host "404 $rel" -ForegroundColor DarkYellow
    continue
  }

  # 防目录穿越
  if (-not $resolved.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
    $res.StatusCode = 403; $res.Close(); Write-Host "403 $rel" -ForegroundColor Red; continue
  }
  if (Test-Path -LiteralPath $resolved -PathType Container) { $resolved = Join-Path $resolved 'index.html' }

  if (Test-Path -LiteralPath $resolved -PathType Leaf) {
    $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
    $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $res.Headers.Add('Cache-Control', 'no-cache, no-store, must-revalidate')
    $bytes = [System.IO.File]::ReadAllBytes($resolved)
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
    Write-Host ("200 {0}  ({1:N0} B)" -f $rel, $bytes.Length)
  }
  else {
    $res.StatusCode = 404
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
    Write-Host "404 $rel" -ForegroundColor DarkYellow
  }
}
