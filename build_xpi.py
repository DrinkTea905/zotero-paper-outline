# -*- coding: utf-8 -*-
# 打包成 .xpi，产出 Unix 风格 zip（create_system=3, 正确 external_attr, flag_bits=0），
# 尽量贴近官方 `zip -r` 的输出，避免 Firefox/Zotero 安装器挑剔。
import os, zipfile, time

SRC = os.path.dirname(os.path.abspath(__file__))
FILES = ["manifest.json", "bootstrap.js", "paperOutline.js", "prefs.js", "preferences.xhtml",
         "icons/icon.png"]
OUT = os.path.join(SRC, "paper-outline-gpt.xpi")

if os.path.exists(OUT):
    os.remove(OUT)

dt = (2024, 1, 1, 0, 0, 0)  # 固定时间，避免依赖系统时钟
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        p = os.path.join(SRC, f)
        if not os.path.exists(p):
            raise SystemExit("缺文件: " + f)
        zi = zipfile.ZipInfo(f, date_time=dt)          # arcname 仅文件名 -> 根目录, 正斜杠
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.create_system = 3                            # 3 = Unix（和 zip -r 一致）
        zi.external_attr = (0o100644) << 16             # 0o100644 = S_IFREG|rw-r--r--（含常规文件类型位，和能装的插件一致）
        with open(p, "rb") as fh:
            z.writestr(zi, fh.read())

print("[OK] built:", OUT)
with zipfile.ZipFile(OUT) as z:
    print("完整性:", "OK" if z.testzip() is None else "BAD")
    for i in z.infolist():
        print(f"  {i.filename:18s} flag={i.flag_bits} sys={i.create_system} extattr={i.external_attr:#010x} comp={i.compress_type}")
