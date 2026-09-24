#!/bin/zsh
# 三角洲行动 · 全面战场载具可视化 —— macOS 启动器（离线包）
#
# 双击本文件即可：在本机起一个只读小服务（只监听 127.0.0.1，端口 8777-8790 里挑一个空的），
# 然后自动用默认浏览器打开页面。关掉这个终端窗口（或按 Control-C）就是停止服务。
#
# 运行时自动选择，能跑哪个用哪个：python3 → ruby → perl → node → php
#   · 不需要安装任何东西；macOS 自带 ruby / perl，装了命令行工具就有 python3
#   · 想指定：      DF_RUNTIME=ruby ./启动.command
#   · 不想开浏览器：DF_NO_BROWSER=1 ./启动.command

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

# 从下载 / 聊天软件 / 压缩包拷来的文件常带隔离标记，去掉它避免“无法打开”。
xattr -d com.apple.quarantine "$0" 2>/dev/null

if [ ! -f "$ROOT/docs/index.html" ]; then
  print -r -- "找不到 docs/index.html：$ROOT/docs/index.html"
  print -r -- "请确认「start-mac.command」和 docs 文件夹在同一个目录里。"
  print -r -- "按回车键关闭。"
  read -r
  exit 1
fi

works() { "$@" >/dev/null 2>&1 }

# ---- 1. 挑一个能用的运行时 ---------------------------------------------
# 每个候选都真的跑一下，跑不动就换下一个。
valid_runtime() {
  case "$1" in
    python3)
      command -v python3 >/dev/null 2>&1 || return 1
      # /usr/bin/python3 在没装命令行工具的机器上只是个“请安装开发者工具”的壳，跳过它
      if [ "$(command -v python3)" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1; then
        return 1
      fi
      works python3 -c 'import sys, http.server; sys.exit(0 if sys.version_info[:2] >= (3, 7) else 1)'
      ;;
    ruby)  command -v ruby >/dev/null 2>&1 && works ruby -e 'exit 0' ;;
    perl)  [ -x /usr/bin/perl ] && works /usr/bin/perl -e 'exit 0' ;;
    node)  command -v node >/dev/null 2>&1 && works node -e 'process.exit(0)' ;;
    php)   command -v php  >/dev/null 2>&1 && works php -v ;;
    *)     return 1 ;;
  esac
}

RT="${DF_RUNTIME:-}"
if [ -n "$RT" ]; then
  if ! valid_runtime "$RT"; then
    print -r -- "指定的运行时「$RT」用不了（没装，或者版本太老）。"
    print -r -- "可用的有：python3 / ruby / perl / node / php，也可以不指定，让启动器自己挑。"
    print -r -- "按回车键关闭。"
    read -r
    exit 1
  fi
else
  for candidate in python3 ruby perl node php; do
    if valid_runtime "$candidate"; then
      RT="$candidate"
      break
    fi
  done
fi
if [ -z "$RT" ]; then
  print -r -- "没有找到可用的运行时（python3 / ruby / perl / node / php 都跑不起来）。"
  print -r -- "在「终端」里执行 xcode-select --install 装上命令行工具，再双击本文件即可。"
  print -r -- "按回车键关闭。"
  read -r
  exit 1
fi

RT_CMD="$RT"
[ "$RT" = "perl" ] && RT_CMD="/usr/bin/perl"

# ---- 2. 挑一个没被占用的端口 --------------------------------------------
PORT=""
for p in {8777..8790}; do
  if ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    PORT=$p
    break
  fi
done
if [ -z "$PORT" ]; then
  print -r -- "8777-8790 都被占用了，先关掉占用端口的程序再试。"
  print -r -- "按回车键关闭。"
  read -r
  exit 1
fi

URL="http://localhost:$PORT/docs/index.html"

# ---- 3. 把对应运行时的服务脚本写到临时目录 ------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/载具可视化.XXXXXX")" || exit 1
SRV=""
PID=""
cleanup() {
  # 关窗口（HUP）、Control-C（INT）、被 kill（TERM）都要把服务进程一起带走，
  # 不能只杀自己，否则会留下一个占着端口的孤儿进程。
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null
    for _ in {1..20}; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.05
    done
    kill -KILL "$PID" 2>/dev/null
  fi
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}
trap cleanup EXIT INT TERM HUP

case "$RT" in
python3)
  SRV="$TMP/server.py"
  cat > "$SRV" <<'PY'
# 只读静态服务：只监听 127.0.0.1，只服务启动器所在目录里的文件。
import os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb':  'model/gltf-binary',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.txt':  'text/plain; charset=utf-8',
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'df-vehicles'

    def do_GET(self):
        self.serve(False)

    def do_HEAD(self):
        self.serve(True)

    def serve(self, head_only):
        from urllib.parse import unquote, urlsplit
        try:
            path = unquote(urlsplit(self.path).path)
        except Exception:
            return self.fail(400, 'Bad Request')
        if path in ('', '/'):
            self.send_response(302)
            self.send_header('Location', '/docs/index.html')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        target = os.path.abspath(os.path.join(ROOT, path.lstrip('/')))
        if target != ROOT and not target.startswith(ROOT + os.sep):
            return self.fail(404, 'Not Found')
        if not os.path.isfile(target):
            return self.fail(404, 'Not Found')
        try:
            size = os.path.getsize(target)
            fh = open(target, 'rb')
        except OSError:
            return self.fail(404, 'Not Found')
        with fh:
            self.send_response(200)
            self.send_header('Content-Type', MIME.get(os.path.splitext(target)[1].lower(),
                                                       'application/octet-stream'))
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if head_only:
                return
            while True:
                chunk = fh.read(262144)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def fail(self, code, text):
        body = ('%d %s' % (code, text)).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


try:
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
except KeyboardInterrupt:
    pass
PY
  ;;
ruby)
  SRV="$TMP/server.rb"
  cat > "$SRV" <<'RB'
# 只读静态服务：只监听 127.0.0.1，只服务启动器所在目录里的文件。
require 'socket'

ROOT = File.expand_path(ARGV[0])
PORT = ARGV[1].to_i

MIME = {
  '.html' => 'text/html; charset=utf-8',
  '.js'   => 'text/javascript; charset=utf-8',
  '.css'  => 'text/css; charset=utf-8',
  '.json' => 'application/json; charset=utf-8',
  '.glb'  => 'model/gltf-binary',
  '.jpg'  => 'image/jpeg',
  '.jpeg' => 'image/jpeg',
  '.png'  => 'image/png',
  '.txt'  => 'text/plain; charset=utf-8'
}.freeze

def fail(c, code, text)
  body = "#{code} #{text}"
  c.write "HTTP/1.1 #{code} #{text}\r\n" \
          "Content-Type: text/plain; charset=utf-8\r\n" \
          "Content-Length: #{body.bytesize}\r\n" \
          "Connection: close\r\n\r\n#{body}"
end

server = TCPServer.new('127.0.0.1', PORT)
loop do
  Thread.start(server.accept) do |c|
    begin
      request = c.gets
      next unless request
      while (header = c.gets)
        break if header == "\r\n" || header == "\n"
      end

      method, target = request.split(' ')
      method = 'GET' if method.nil? || method.empty?
      target = '/' if target.nil? || target.empty?
      path = target.split(/[?#]/).first || '/'
      path = path.gsub(/%([0-9A-Fa-f]{2})/) { [Regexp.last_match(1).hex].pack('C') }

      if path.empty? || path == '/'
        c.write "HTTP/1.1 302 Found\r\nLocation: /docs/index.html\r\n" \
                "Content-Length: 0\r\nConnection: close\r\n\r\n"
        next
      end

      full = File.expand_path(File.join(ROOT, path))
      unless (full == ROOT || full.start_with?(ROOT + '/')) && File.file?(full)
        fail(c, 404, 'Not Found')
        next
      end

      body = File.binread(full)
      c.write "HTTP/1.1 200 OK\r\n" \
              "Content-Type: #{MIME[File.extname(full).downcase] || 'application/octet-stream'}\r\n" \
              "Content-Length: #{body.bytesize}\r\n" \
              "Cache-Control: no-store\r\n" \
              "Connection: close\r\n\r\n"
      c.write body unless method == 'HEAD'
    rescue StandardError
      begin
        fail(c, 500, 'Internal Server Error')
      rescue StandardError
        nil
      end
    ensure
      begin
        c.close
      rescue StandardError
        nil
      end
    end
  end
end
RB
  ;;
perl)
  SRV="$TMP/server.pl"
  cat > "$SRV" <<'PL'
# 只读静态服务：只监听 127.0.0.1，只服务启动器所在目录里的文件。
use strict;
use warnings;
use Cwd qw(abs_path);
use IO::Socket::INET;

my ($root, $port) = @ARGV;
$root = abs_path($root);
$| = 1;
$SIG{PIPE} = 'IGNORE';
local $SIG{CHLD} = 'IGNORE';

my %mime = (
    '.html' => 'text/html; charset=utf-8',
    '.js'   => 'text/javascript; charset=utf-8',
    '.css'  => 'text/css; charset=utf-8',
    '.json' => 'application/json; charset=utf-8',
    '.glb'  => 'model/gltf-binary',
    '.jpg'  => 'image/jpeg',
    '.jpeg' => 'image/jpeg',
    '.png'  => 'image/png',
    '.txt'  => 'text/plain; charset=utf-8',
);

sub fail {
    my ($c, $code, $text) = @_;
    my $body = "$code $text";
    print $c "HTTP/1.1 $code $text\r\n"
        . "Content-Type: text/plain; charset=utf-8\r\n"
        . "Content-Length: " . length($body) . "\r\n"
        . "Connection: close\r\n\r\n$body";
    close $c;
}

my $srv = IO::Socket::INET->new(
    LocalAddr => '127.0.0.1',
    LocalPort => $port,
    Proto     => 'tcp',
    Listen    => 64,
    ReuseAddr => 1,
) or die "无法监听 127.0.0.1:$port\n";

while (my $conn = $srv->accept) {
    my $pid = fork();
    if (!defined $pid) { close $conn; next; }
    if ($pid) { close $conn; next; }

    close $srv;
    binmode $conn;
    my $request = <$conn>;
    unless (defined $request) { close $conn; exit 0; }
    $request =~ s/\r?\n$//;
    while (my $header = <$conn>) { last if $header =~ /^\r?\n$/; }

    my ($method, $target) = split /\s+/, $request;
    $method = 'GET' unless defined $method && length $method;
    $target = '/'   unless defined $target && length $target;

    my $path = $target;
    $path =~ s/[?#].*$//;
    $path =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;

    if ($path eq '/' || $path eq '') {
        print $conn "HTTP/1.1 302 Found\r\nLocation: /docs/index.html\r\n"
            . "Content-Length: 0\r\nConnection: close\r\n\r\n";
        close $conn;
        exit 0;
    }

    my $full = abs_path("$root$path");
    if (!defined $full || ($full ne $root && index($full, "$root/") != 0) || !-f $full) {
        fail($conn, 404, 'Not Found');
        exit 0;
    }

    my ($ext) = $full =~ /(\.[^.\/]*)$/;
    $ext = lc($ext // '');
    my $size = -s $full;
    open my $fh, '<:raw', $full or do { fail($conn, 500, 'Internal Server Error'); exit 0; };

    print $conn "HTTP/1.1 200 OK\r\n"
        . "Content-Type: " . ($mime{$ext} // 'application/octet-stream') . "\r\n"
        . "Content-Length: $size\r\n"
        . "Cache-Control: no-store\r\n"
        . "Connection: close\r\n\r\n";

    if ($method ne 'HEAD') {
        my $buf;
        while (read($fh, $buf, 262144)) { print $conn $buf; }
    }
    close $fh;
    close $conn;
    exit 0;
}
PL
  ;;
node)
  SRV="$TMP/server.js"
  cat > "$SRV" <<'JS'
// 只读静态服务：只监听 127.0.0.1，只服务启动器所在目录里的文件。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2]);
const PORT = Number(process.argv[3]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function fail(res, code, text) {
  const body = Buffer.from(`${code} ${text}`, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return fail(res, 400, 'Bad Request');
  }

  if (pathname === '' || pathname === '/') {
    res.writeHead(302, { Location: '/docs/index.html', 'Content-Length': 0 });
    return res.end();
  }

  const target = path.resolve(ROOT, '.' + pathname);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return fail(res, 404, 'Not Found');

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}).listen(PORT, '127.0.0.1');

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
JS
  ;;
php)
  SRV=""
  ;;
esac

# ---- 4. 起服务，等它就绪，再开浏览器 ------------------------------------
if [ "$RT" = "php" ]; then
  php -S "127.0.0.1:$PORT" -t "$ROOT" >/dev/null 2>&1 &
else
  "$RT_CMD" "$SRV" "$ROOT" "$PORT" &
fi
PID=$!

LISTENING=0
for _ in {1..60}; do
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    LISTENING=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [ "$LISTENING" != "1" ]; then
  wait "$PID" 2>/dev/null
  print -r -- "服务没能起来（运行时 $RT，端口 $PORT）。"
  print -r -- "多半是这个端口刚被别的程序占走了，再双击一次本文件通常就好。"
  print -r -- "要排查的话，在「终端」里执行：  DF_RUNTIME=$RT lsof -nP -iTCP:$PORT"
  print -r -- "按回车键关闭。"
  read -r
  exit 1
fi

print -r -- ""
print -r -- "  三角洲行动 · 全面战场载具可视化"
print -r -- "  地址：$URL"
print -r -- "  运行时：$RT   端口：$PORT"
print -r -- "  关闭这个窗口（或按 Control-C）即停止服务。"
print -r -- ""

if [ "${DF_NO_BROWSER:-}" != "1" ]; then
  open "$URL"
fi

wait "$PID"
RC=$?
PID=""

if [ "$RC" -ne 0 ] && [ "$RC" -ne 130 ] && [ "$RC" -ne 143 ]; then
  print -r -- "服务意外退出（代码 $RC）。"
  print -r -- "按回车键关闭。"
  read -r
fi
