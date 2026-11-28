#!/bin/bash
set -Eeuo pipefail
step="检查安装入口"
entry_error(){ code=$?; printf "\n[LLHH] 无法继续：%s（退出码 %s）。请查看上方错误。\n" "$step" "$code" >&2; exit "$code"; }
trap entry_error ERR
[[ $EUID == 0 ]] || { echo "[LLHH] 请使用root登录后运行。"; exit 1; }
[[ -r /etc/os-release ]] || { echo "[LLHH] 无法识别系统，请使用Debian 12 amd64。"; exit 1; }
source /etc/os-release
[[ $ID == debian && $VERSION_ID == 12 && $(uname -m) == x86_64 ]] || { echo "[LLHH] 当前只支持Debian 12 amd64，已停止，未修改软件源。"; exit 1; }
step="准备下载组件：检查软件源、服务器联网及可用空间"
if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || [[ ! -s /etc/ssl/certs/ca-certificates.crt ]];then
 echo "[LLHH] 正在自动安装下载组件和CA证书，请等待；软件包锁最多等待10分钟。"
 export DEBIAN_FRONTEND=noninteractive
 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=600 update --error-on=any
 apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 --no-remove install -y --no-install-recommends ca-certificates curl python3
fi
command -v curl >/dev/null && command -v python3 >/dev/null && [[ -s /etc/ssl/certs/ca-certificates.crt ]] || { echo "[LLHH] 下载组件安装后检查失败，请保留上方软件包错误信息。"; exit 1; }
step="下载LLHH引导：请检查DNS、时间和到GitHub的HTTPS连接"
file=$(mktemp /var/tmp/llhh-entry.XXXXXXXX)
cleanup(){ rm -f -- "$file"; }; trap cleanup EXIT
curl --proto "=https" --tlsv1.2 -fsSL --retry 3 --connect-timeout 15 --max-time 180 https://github.com/X-system/VPS-LLHH/releases/download/v0.2.0/bootstrap.sh -o "$file"
[[ -s $file ]] || { echo "[LLHH] 下载结果为空，没有执行安装。"; exit 1; }
step="检查下载脚本完整性"
bash -n "$file"
step="运行LLHH安装引导"
bash "$file"
