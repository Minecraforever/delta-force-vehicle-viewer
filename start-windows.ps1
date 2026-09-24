# 本地静态服务：把 docs 目录跑起来并打开浏览器。
# 只用 Windows 自带的 .NET/HttpListener，不需要装 Python 或其它运行库。

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'docs'

if (-not (Test-Path $root)) {
    Write-Host "找不到 docs 目录：$root" -ForegroundColor Red
    exit 1
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.glb'  = 'model/gltf-binary'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.png'  = 'image/png'
    '.txt'  = 'text/plain; charset=utf-8'
}

$listener = $null
$port = 0
foreach ($candidate in 8777..8790) {
    try {
        $probe = New-Object System.Net.HttpListener
        $probe.Prefixes.Add("http://localhost:$candidate/")
        $probe.Start()
        $listener = $probe
        $port = $candidate
        break
    } catch {
        if ($probe) { try { $probe.Close() } catch { } }
    }
}

if (-not $listener) {
    Write-Host "8777-8790 都没能占用，先关掉占用端口的程序再试。" -ForegroundColor Red
    exit 1
}

$url = "http://localhost:$port/docs/index.html"
Write-Host ""
Write-Host "  三角洲行动 · 全面战场载具可视化" -ForegroundColor Cyan
Write-Host "  地址：$url"
Write-Host "  关闭这个窗口即停止服务。"
Write-Host ""
if ($env:DF_NO_BROWSER -ne '1') { Start-Process $url }

$rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'

while ($listener.IsListening) {
    try { $context = $listener.GetContext() } catch { break }

    $request  = $context.Request
    $response = $context.Response
    try {
        $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
        if ($path -eq '/' -or $path -eq '/index.html') {
            $response.StatusCode = 302
            $response.RedirectLocation = "/docs/index.html"
            $response.Close()
            continue
        }
        if (-not $path.StartsWith('/docs/')) {
            $response.StatusCode = 404
            $response.Close()
            continue
        }

        $relative = $path.Substring(6).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not $target.StartsWith($rootFull) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
            $response.StatusCode = 404
            $response.Close()
            continue
        }

        $extension = [System.IO.Path]::GetExtension($target).ToLower()
        $response.ContentType = if ($mime.ContainsKey($extension)) { $mime[$extension] } else { 'application/octet-stream' }
        $response.Headers.Add('Cache-Control', 'no-store')
        $bytes = [System.IO.File]::ReadAllBytes($target)
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
        try { $response.StatusCode = 500 } catch { }
    } finally {
        try { $response.Close() } catch { }
    }
}
