# Paper Outline XPI 一键打包脚本
# 用法：powershell -ExecutionPolicy Bypass -File .\打包.ps1
# 本脚本委托 python -B build_xpi.py --run-tests 完成校验、测试、原子打包与哈希同步。

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$script = Join-Path $src "build_xpi.py"

if (-not (Test-Path -LiteralPath $script)) {
    throw "未找到打包脚本：$script"
}

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    throw "未找到 python 命令，请先安装 Python 3 并加入 PATH。"
}

Push-Location -LiteralPath $src
try {
    & $pythonCmd.Source -B "build_xpi.py" --run-tests @args
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}

$xpi = Join-Path $src "paper-outline-gpt.xpi"
Write-Host ""
Write-Host "安装方式：Zotero -> 工具 -> 插件 -> 右上角齿轮 -> Install Add-on From File -> 选择 $xpi"
