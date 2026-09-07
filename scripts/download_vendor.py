"""下载 pdf.js 到 frontend/vendor（本机网络通过 Python 下载最可靠）。"""
import pathlib
import urllib.request

BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/"
FILES = ["pdf.min.js", "pdf.worker.min.js"]

outdir = pathlib.Path("frontend/vendor")
outdir.mkdir(parents=True, exist_ok=True)

log = []
for name in FILES:
    try:
        url = BASE + name
        data = urllib.request.urlopen(url, timeout=120).read()
        (outdir / name).write_bytes(data)
        log.append("%s: %d bytes OK" % (name, len(data)))
    except Exception as e:
        log.append("%s: FAIL %r" % (name, e))

(outdir / "download_log.txt").write_text("\n".join(log), encoding="utf-8")
print("\n".join(log))
