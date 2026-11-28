# Shared by the standalone bootstrap and source installer. No credentials here.
LLHH_STEP='检查安装环境'
llhh_step(){ LLHH_STEP=$1; printf '\n[LLHH] %s\n' "$LLHH_STEP"; }
llhh_stop(){ printf '\n[LLHH] 无法继续：%s\n' "$1" >&2; exit 1; }
llhh_error(){ local code=$1; if ((BASH_SUBSHELL>0));then exit "$code";fi; trap - ERR; printf '\n[LLHH] 安装未完成（退出码 %s）\n失败步骤：%s\n' "$code" "$LLHH_STEP" >&2; case "$LLHH_STEP" in
 *软件源*) echo '请检查服务器联网、DNS和Debian软件源。软件源未就绪，没有继续安装。' >&2;;
 *依赖*) echo '请检查上方的软件包错误和可用空间。其他安装程序占用时最多等待10分钟，不强杀进程或删除锁文件。' >&2;;
 *下载*|*版本*) echo '请检查服务器时间、DNS及到GitHub的HTTPS连接；不会跳过证书校验或运行未完整下载的脚本。' >&2;;
 *能力*) echo '当前虚拟化环境可能限制WireGuard、网络命名空间或防火墙，请联系服务商开放相应能力。' >&2;;
 *) echo '请保留本屏错误信息。程序没有报告安装成功；修复原因后可重新运行同一安装命令。' >&2;;
 esac; exit "$code"; }
trap 'llhh_error $?' ERR
llhh_environment(){
 llhh_step '检查权限、系统和可用空间'
 [[ $EUID == 0 ]] || llhh_stop '请使用root登录后运行。'
 [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || llhh_stop '目前只支持Linux amd64，请选择Debian 12 amd64。'
 [[ -r /etc/os-release ]] || llhh_stop '无法识别系统，请使用Debian 12。'
 local ID VERSION_ID VERSION NAME PRETTY_NAME VERSION_CODENAME HOME_URL SUPPORT_URL BUG_REPORT_URL; source /etc/os-release
 [[ $ID == debian && ( $VERSION_ID == 12 || ( $VERSION_ID == 13 && ${VPS_INSTALL_TEST_DEBIAN13:-0} == 1 ) ) ]] || llhh_stop "当前系统为${ID:-未知} ${VERSION_ID:-未知}，目前只开放Debian 12。"
 command -v apt-get >/dev/null || llhh_stop '系统缺少apt-get，无法自动补齐组件。'
 command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || llhh_stop '系统未运行systemd，无法管理后台服务。'
 local available; available=$(df -Pk / /var/tmp | awk 'NR>1 {if(!min || $4<min)min=$4} END {print min}')
 [[ $available =~ ^[0-9]+$ && $available -ge 1048576 ]] || llhh_stop '根目录或临时目录可用空间不足1GB，请先扩容或清理。'
 export DEBIAN_FRONTEND=noninteractive
 local missing=() package; for package in "$@";do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed';then missing+=("$package");fi
 done
 if ((${#missing[@]}));then
  printf '[LLHH] 将自动补齐：%s\n' "${missing[*]}"
  llhh_step '更新Debian软件源'; apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=600 update --error-on=any
  llhh_step '安装缺失依赖'; apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 --no-remove install -y --no-install-recommends "${missing[@]}"
 fi
 command -v curl >/dev/null && command -v python3 >/dev/null && [[ -s /etc/ssl/certs/ca-certificates.crt ]] || llhh_stop '依赖安装后复查未通过：缺少curl、Python3或CA证书。'
 llhh_step '环境检查通过'
}
