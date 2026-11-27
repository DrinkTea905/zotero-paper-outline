# -*- coding: utf-8 -*-
"""打包 Paper Outline 为 .xpi。

产出 Unix 风格 zip（create_system=3, 正确 external_attr, flag_bits=0），
尽量贴近官方 `zip -r` 的输出，避免 Firefox/Zotero 安装器挑剔。
"""

import argparse
import glob
import hashlib
import json
import os
import subprocess
import sys
import zipfile

SRC = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(SRC, "manifest.json")
UPDATE_PATH = os.path.join(SRC, "update.json")
OUT_NAME = "paper-outline-gpt.xpi"
OUT = os.path.join(SRC, OUT_NAME)
TMP = OUT + ".tmp"

# 显式白名单：仅打包插件运行所需的 8 个核心文件
FILES = [
    "manifest.json",
    "bootstrap.js",
    "paperOutline.js",
    "prefs.js",
    "preferences.xhtml",
    "preferences.js",
    "preferences.css",
    "icons/icon.png",
]

FIXED_ZIP_DT = (2024, 1, 1, 0, 0, 0)  # 固定时间戳，保证构建可复现


def load_json_object(path, label):
    if not os.path.isfile(path):
        raise SystemExit(f"缺少文件: {label} ({path})")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} JSON 格式无效: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"{label} 顶层必须是 JSON 对象")
    return data


def validate_metadata():
    manifest = load_json_object(MANIFEST_PATH, "manifest.json")
    update_data = load_json_object(UPDATE_PATH, "update.json")

    manifest_version = manifest.get("version")
    if not isinstance(manifest_version, str) or not manifest_version.strip():
        raise SystemExit("manifest.json 缺少有效的 version 字段")
    manifest_version = manifest_version.strip()

    zotero_app = (manifest.get("applications") or {}).get("zotero")
    if not isinstance(zotero_app, dict):
        raise SystemExit("manifest.json 缺少 applications.zotero 配置")
    addon_id = zotero_app.get("id")
    if not isinstance(addon_id, str) or not addon_id.strip():
        raise SystemExit("manifest.json 缺少有效的 applications.zotero.id 字段")
    addon_id = addon_id.strip()

    addons = update_data.get("addons")
    if not isinstance(addons, dict) or not addons:
        raise SystemExit("update.json 缺少有效的 addons 对象")
    if addon_id not in addons:
        found_ids = ", ".join(addons.keys())
        raise SystemExit(
            f"Addon ID 不一致: manifest.json={addon_id}, update.json=[{found_ids}]"
        )

    addon_block = addons[addon_id]
    updates = addon_block.get("updates") if isinstance(addon_block, dict) else None
    if not isinstance(updates, list) or not updates:
        raise SystemExit(f"update.json 中 {addon_id} 的 updates 列表为空或格式无效")

    matched_index = None
    matched_entry = None
    versions_found = []
    for idx, entry in enumerate(updates):
        if not isinstance(entry, dict):
            raise SystemExit(f"update.json updates[{idx}] 必须是对象")
        ver = entry.get("version")
        if isinstance(ver, str):
            versions_found.append(ver)
            if ver.strip() == manifest_version:
                matched_index = idx
                matched_entry = entry

    if matched_entry is None:
        raise SystemExit(
            f"版本号不一致: manifest.json={manifest_version}, "
            f"update.json={versions_found}"
        )

    update_link = matched_entry.get("update_link")
    expected_tag = f"v{manifest_version}"
    if not isinstance(update_link, str) or not update_link.strip():
        raise SystemExit(f"update.json 版本 {manifest_version} 缺少 update_link")
    if f"/{expected_tag}/" not in update_link and not update_link.endswith(expected_tag):
        raise SystemExit(
            f"update_link 未包含对应版本 tag ({expected_tag}): {update_link}"
        )

    return manifest_version, addon_id, update_data, matched_index


def run_tests():
    test_paths = sorted(glob.glob(os.path.join(SRC, "tests", "*.test.cjs")))
    if not test_paths:
        raise SystemExit("未找到任何测试文件: tests/*.test.cjs")

    rel_tests = [os.path.relpath(p, SRC) for p in test_paths]
    cmd = ["node", "--test", *rel_tests]
    print("[TEST] running:", " ".join(cmd))
    try:
        result = subprocess.run(cmd, cwd=SRC, check=False)
    except FileNotFoundError as exc:
        raise SystemExit("未找到 node 命令，无法执行 --run-tests") from exc
    if result.returncode != 0:
        raise SystemExit(f"测试未通过（退出码 {result.returncode}），已中止打包")
    print("[TEST] all passed")


def build_archive():
    missing = [f for f in FILES if not os.path.isfile(os.path.join(SRC, f))]
    if missing:
        raise SystemExit("缺少核心打包文件: " + ", ".join(missing))

    if os.path.exists(TMP):
        os.remove(TMP)

    try:
        with zipfile.ZipFile(TMP, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel_path in FILES:
                abs_path = os.path.join(SRC, rel_path)
                arcname = rel_path.replace("\\", "/")
                zi = zipfile.ZipInfo(arcname, date_time=FIXED_ZIP_DT)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.create_system = 3  # 3 = Unix（与 zip -r 一致）
                zi.external_attr = (0o100644) << 16  # S_IFREG|rw-r--r--
                with open(abs_path, "rb") as fh:
                    zf.writestr(zi, fh.read())

        with zipfile.ZipFile(TMP, "r") as zf:
            bad_member = zf.testzip()
            if bad_member is not None:
                raise SystemExit(f"XPI 压缩包完整性校验失败，损坏条目: {bad_member}")
            infos = zf.infolist()
            actual_names = [i.filename for i in infos]
            if actual_names != FILES:
                raise SystemExit(
                    f"XPI 文件清单不匹配: expected={FILES}, actual={actual_names}"
                )

        os.replace(TMP, OUT)
    except BaseException:
        if os.path.exists(TMP):
            try:
                os.remove(TMP)
            except OSError:
                pass
        raise

    return infos


def compute_sha256(path):
    hasher = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def sync_update_hash(update_data, addon_id, matched_index, sha256_hex):
    entry = update_data["addons"][addon_id]["updates"][matched_index]
    new_hash = f"sha256:{sha256_hex}"

    # 保持字段顺序整洁：将 update_hash 紧跟在 update_link 后
    reordered = {}
    inserted = False
    for key, value in entry.items():
        if key == "update_hash":
            reordered["update_hash"] = new_hash
            inserted = True
        else:
            reordered[key] = value
            if key == "update_link" and "update_hash" not in entry:
                reordered["update_hash"] = new_hash
                inserted = True
    if not inserted:
        reordered["update_hash"] = new_hash

    update_data["addons"][addon_id]["updates"][matched_index] = reordered

    tmp_update = UPDATE_PATH + ".tmp"
    content = json.dumps(update_data, ensure_ascii=False, indent=2) + "\n"
    try:
        with open(tmp_update, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp_update, UPDATE_PATH)
    except BaseException:
        if os.path.exists(tmp_update):
            try:
                os.remove(tmp_update)
            except OSError:
                pass
        raise
    return new_hash


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="构建 Paper Outline Zotero .xpi 插件包")
    parser.add_argument(
        "--run-tests",
        action="store_true",
        default=False,
        help="打包前运行 node --test tests/*.test.cjs",
    )
    parser.add_argument(
        "--sync-hash",
        dest="sync_hash",
        action="store_true",
        default=True,
        help="打包后自动计算 SHA-256 并同步写入 update.json（默认开启）",
    )
    parser.add_argument(
        "--no-sync-hash",
        dest="sync_hash",
        action="store_false",
        help="禁用自动同步 update.json 中的 update_hash",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    version, addon_id, update_data, matched_index = validate_metadata()
    print(f"[CHECK] metadata OK: id={addon_id} version={version}")

    if args.run_tests:
        run_tests()

    infos = build_archive()
    sha256_hex = compute_sha256(OUT)
    size_bytes = os.path.getsize(OUT)

    print(f"[OK] built: {OUT} ({size_bytes} bytes)")
    print(f"[OK] sha256: {sha256_hex}")
    print("完整性: OK")
    for info in infos:
        print(
            f"  {info.filename:18s} flag={info.flag_bits} sys={info.create_system} "
            f"extattr={info.external_attr:#010x} comp={info.compress_type}"
        )

    if args.sync_hash:
        update_hash = sync_update_hash(update_data, addon_id, matched_index, sha256_hex)
        print(f"[OK] synced update.json update_hash={update_hash}")
    else:
        print("[SKIP] --no-sync-hash enabled, update.json not modified")


if __name__ == "__main__":
    main(sys.argv[1:])
