# 把工作区源码同步进 profile 的 node_modules（pnpm add 对 file: 依赖
# 在源码变更后不会重新拷贝，需要手动镜像）。
# 用法：pwsh scripts\install-local.ps1 [-Profile <profile 名>]
param(
  [string]$Profile = 'desktop'
)
$ErrorActionPreference = 'Stop'

# 全部路径从脚本自身位置推导，换机器 / 换 profile 都不用改脚本
$pkgName = 'dsh-secret-card'
$src = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\$pkgName"

Write-Output "src : $src"
Write-Output "dst : $dst"

# 先删掉旧内容，避免残留（该目录只由本插件产生，删除安全）
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Path $dst -Force | Out-Null

Copy-Item "$src\src" $dst -Recurse -Force
Copy-Item "$src\client" $dst -Recurse -Force
Copy-Item "$src\cordis.patch.yml" $dst -Force
Copy-Item "$src\package.json" $dst -Force
Copy-Item "$src\README.md" $dst -Force

Write-Output "synced to $dst"
Get-ChildItem $dst -Recurse -File | ForEach-Object { "  {0}  {1} bytes" -f $_.FullName.Replace("$dst\", ''), $_.Length }
