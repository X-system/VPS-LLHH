#!/bin/bash
set -Eeuo pipefail
umask 077

# Development installer: install from an inspected source tree. A public release
# URL will be added only after a repository and verified release exist.
if [[ $(id -u) != 0 ]]; then echo '请以root或sudo运行安装。' >&2; exit 1; fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then echo '此版本仅验证Linux amd64。' >&2; exit 1; fi
source /etc/os-release
if [[ $ID != debian || ( $VERSION_ID != 12 && ! ( $VERSION_ID == 13 && ${VPS_INSTALL_TEST_DEBIAN13:-0} == 1 ) ) ]]; then echo '当前仅开放Debian 12安装；其他系统验收后开放。' >&2; exit 1; fi
SOURCE=''
RESTORE=0
INSTALL_ROLE=${VPS_INSTALL_ROLE:-}
while [[ $# -gt 0 ]]; do
 case "$1" in --source) SOURCE=${2:?缺少源码目录}; shift 2;; --restore) RESTORE=1;shift;; --role) INSTALL_ROLE=${2:?缺少安装角色};shift 2;;*) echo '使用：bash install.sh --source /绝对源码目录 [--role relay|exit] [--restore]' >&2; exit 1;; esac
done
[[ -n $SOURCE && $SOURCE = /* && -f $SOURCE/src/server.mjs && -f $SOURCE/config/releases.json ]] || { echo '请提供完整源码的绝对路径。' >&2; exit 1; }
source "$SOURCE/config/install-environment.sh"
llhh_environment ca-certificates curl python3 xz-utils unzip openssl nftables iproute2 wireguard-tools util-linux kmod
llhh_step '检查已有面板与数据兼容性'
python3 - "$SOURCE" "$INSTALL_ROLE" <<'VERSION_GUARD'
import sys,json,pathlib,sqlite3
source=pathlib.Path(sys.argv[1]);installed=pathlib.Path('/usr/local/lib/vps-panel/app/package.json')
if installed.exists():assert json.loads(installed.read_text())['version']==json.loads((source/'package.json').read_text())['version'],'已安装其他版本，请使用面板更新；安装器不会覆盖现有版本'
system=pathlib.Path('/etc/vps-panel/system.json')
if sys.argv[2]and system.exists():assert json.loads(system.read_text())['role']==sys.argv[2],'已安装其他角色，请在面板内受控切换角色；安装器不会覆盖'
database=pathlib.Path('/var/lib/vps-panel/panel.sqlite')
if database.exists():
 connection=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)
 try:assert connection.execute('PRAGMA user_version').fetchone()[0]<=2,'不能用旧版程序恢复新版数据库'
 finally:connection.close()
VERSION_GUARD
for path in /usr/local/lib/vps-panel /etc/vps-panel /var/lib/vps-panel; do [[ ! -L $path ]] || { echo '安装目录不能是符号链接。';exit 1; };done
if [[ -e /usr/local/lib/vps-panel/app ]]; then
 python3 - <<'PY'
import json,pathlib,stat
path=pathlib.Path('/usr/local/lib/vps-panel/app/package.json')
assert path.is_file()and not path.is_symlink()and json.loads(path.read_text()).get('name')=='vps-panel','安装目录被其他程序占用，已停止操作'
PY
 EXISTING_HEALTHY=1
 for service in agent web auth worker; do systemctl is-active --quiet "vps-panel-$service.service" || EXISTING_HEALTHY=0;done
 if [[ $EXISTING_HEALTHY == 1 ]] && /usr/local/lib/vps-panel/runtime/bin/node --input-type=module - "$SOURCE" <<'JS'
import{pathToFileURL}from'node:url';
const{managementHealth}=await import(pathToFileURL(process.argv[2]+'/src/management-health.mjs'));
await managementHealth({attempts:60});
JS
 then
  if [[ ! -e /usr/local/lib/vps-panel/install-complete.json ]];then
   printf '{"completed":true}\n' >/usr/local/lib/vps-panel/install-complete.json
   chmod 600 /usr/local/lib/vps-panel/install-complete.json
   echo '安装自检已补全，原账户和配置保持不变。'
  else echo '面板已经安装，未更改现有账户和配置；更新请使用系统维护。';fi
  if command -v llhh >/dev/null;then llhh address;else vps-panel address;fi
  if [[ -f /var/lib/vps-panel/.bootstrap.json && -f /usr/local/lib/vps-panel/app/src/first-login.mjs ]];then
   CURRENT_ORIGIN=$(sed -n 's/^VPS_ORIGIN=//p' /etc/vps-panel/web.env)
   runuser -u vps-panel -- env VPS_DATA_DIR=/var/lib/vps-panel VPS_ORIGIN="$CURRENT_ORIGIN" /usr/local/lib/vps-panel/runtime/bin/node /usr/local/lib/vps-panel/app/src/first-login.mjs
  fi
  exit 0
 fi
 if [[ -e /usr/local/lib/vps-panel/install-complete.json ]]; then echo '已安装的服务当前异常，请先使用SSH应急菜单恢复；不会覆盖现有数据。' >&2;exit 1;fi
 SOURCE=$(realpath -e -- "$SOURCE")
 [[ $SOURCE != /usr/local/lib/vps-panel && $SOURCE != /usr/local/lib/vps-panel/* ]] || { echo '修复未完成安装时，请从独立下载目录运行安装器。';exit 1; }
 echo '发现未完成安装，保留原数据并重新部署程序；所有代理保持停止。'
 if [[ -f /var/lib/vps-panel/panel.sqlite && -x /usr/local/lib/vps-panel/runtime/bin/node && -f /usr/local/lib/vps-panel/app/src/emergency-cli.mjs ]]; then
  /usr/local/lib/vps-panel/runtime/bin/node /usr/local/lib/vps-panel/app/src/emergency-cli.mjs emergency-stop
 fi
 systemctl stop vps-panel-web vps-panel-worker vps-panel-auth vps-panel-agent vps-panel-network vps-panel-guard vps-panel-vmess-att vps-panel-vmess-direct vps-panel-hy2-att vps-panel-hy2-direct 2>/dev/null || true
 for service in vmess-att vmess-direct hy2-att hy2-direct;do if systemctl is-active --quiet "vps-panel-$service";then echo '代理尚未停止，已取消修复。';exit 1;fi;done
 if [[ -f /var/lib/vps-panel/panel.sqlite ]]; then RESTORE=1;fi
 [[ ! -e /etc/vps-panel/system.json || -f /var/lib/vps-panel/panel.sqlite ]] || { echo '配置存在但数据库缺失，请先恢复备份。';exit 1; }
 INCOMPLETE="/usr/local/lib/vps-panel.incomplete.$(date +%s).$$"
 [[ ! -e $INCOMPLETE ]] || { echo '修复备份目录冲突。';exit 1; }
 mv -- /usr/local/lib/vps-panel "$INCOMPLETE"
fi
if [[ $RESTORE == 0 && ( -e /etc/vps-panel/system.json || -e /var/lib/vps-panel/panel.sqlite ) ]]; then
 echo '发现保留数据，请使用 --restore 恢复安装，不会覆盖管理员或安全入口。' >&2; exit 1
fi
if [[ $RESTORE == 1 && ! -f /var/lib/vps-panel/panel.sqlite ]]; then echo '未发现可恢复的数据。';exit 1;fi
if [[ -d /usr/local/lib/vps-panel && ! -e /usr/local/lib/vps-panel/app ]];then
 [[ $RESTORE == 1 ]] || { echo '发现残留程序目录，请确认保留数据后使用 --restore，避免覆盖其他文件。';exit 1; }
 SOURCE=$(realpath -e -- "$SOURCE")
 [[ $SOURCE != /usr/local/lib/vps-panel && $SOURCE != /usr/local/lib/vps-panel/* ]] || { echo '恢复程序文件时，请从独立下载目录运行。';exit 1; }
 if [[ -x /usr/local/lib/vps-panel/runtime/bin/node ]];then
  /usr/local/lib/vps-panel/runtime/bin/node --input-type=module - "$SOURCE" <<'JS'
import{pathToFileURL}from'node:url';
const{createSystemDriver}=await import(pathToFileURL(process.argv[2]+'/src/system-driver.mjs'));
await createSystemDriver().action('emergency-stop');
JS
 fi
 systemctl stop vps-panel-web vps-panel-worker vps-panel-auth vps-panel-agent vps-panel-network vps-panel-guard vps-panel-vmess-att vps-panel-vmess-direct vps-panel-hy2-att vps-panel-hy2-direct 2>/dev/null || true
 for service in vmess-att vmess-direct hy2-att hy2-direct;do if systemctl is-active --quiet "vps-panel-$service";then echo '代理尚未停止，已取消恢复。';exit 1;fi;done
 INCOMPLETE="/usr/local/lib/vps-panel.incomplete.$(date +%s).$$"
 [[ ! -e $INCOMPLETE ]] || { echo '恢复备份目录冲突。';exit 1; }
 mv -- /usr/local/lib/vps-panel "$INCOMPLETE"
fi
if [[ $RESTORE == 0 && -z $INSTALL_ROLE ]];then
 echo '这台服务器负责什么？'
 echo '  1. 中转端：接入用户，可直接出网或连接 ATT 出口'
 echo '  2. 出口端：为已配对的中转机提供出口'
 [[ -r /dev/tty ]] || { echo '无人值守安装请指定 --role relay 或 --role exit。' >&2;exit 1; }
 while [[ -z $INSTALL_ROLE ]];do
  read -r -p '请输入 1 或 2：' ROLE_CHOICE </dev/tty
  case "$ROLE_CHOICE" in 1) INSTALL_ROLE=relay;;2) INSTALL_ROLE=exit;;*)echo '请输入数字1或2。' >&2;;esac
 done
fi
[[ $RESTORE == 1 || $INSTALL_ROLE == relay || $INSTALL_ROLE == exit ]] || { echo '安装角色必须为relay或exit。' >&2;exit 1; }
export DEBIAN_FRONTEND=noninteractive
llhh_step '检查WireGuard与防火墙能力'
if ! unshare --net /bin/sh -eu -c '
 ip link add vps-probe type wireguard
 nft add table inet vps_panel_probe
 nft add chain inet vps_panel_probe output "{ type filter hook output priority 0; policy accept; }"
 nft add table ip vps_panel_probe_nat
 nft add chain ip vps_panel_probe_nat postrouting "{ type nat hook postrouting priority 100; policy accept; }"
' >/dev/null; then echo '内核或虚拟化权限不支持所需WG与防火墙能力，已停止安装；未修改主机路由。' >&2;exit 1;fi
llhh_step '检测网络与准备安装'
NETWORK_SETTINGS=$(python3 "$SOURCE/scripts/install_network.py" "$RESTORE")
mapfile -t PANEL_VALUES <<<"$NETWORK_SETTINGS"
PANEL_BIND=${PANEL_VALUES[0]}
PANEL_IP=${PANEL_VALUES[1]}
PANEL_PORT=${PANEL_VALUES[2]}
PANEL_SAN=${PANEL_VALUES[3]}
STAGE=$(mktemp -d /var/tmp/vps-panel-install.XXXXXXXX)
finish(){
 local result=$?
 if [[ $result != 0 ]]; then echo "安装未完成。未启动代理，请保留错误输出用于诊断；工作目录：$STAGE" >&2; fi
 if [[ $result == 0 && $STAGE == /var/tmp/vps-panel-install.* && -d $STAGE && ! -L $STAGE ]]; then rm -rf -- "$STAGE";fi
}
trap finish EXIT
install -d -m 755 /usr/local/lib/vps-panel
install -d -m 700 /etc/vps-panel /etc/vps-panel/certs
if ! getent group vps-panel >/dev/null; then groupadd --system vps-panel; fi
if ! id vps-panel >/dev/null 2>&1; then useradd --system --gid vps-panel --home-dir /var/lib/vps-panel --shell /usr/sbin/nologin vps-panel; fi
for profile in vmess-att vmess-direct hy2-att hy2-direct; do
 if ! id "vps-panel-$profile" >/dev/null 2>&1; then useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "vps-panel-$profile"; fi
done
llhh_step '下载并校验Node、TCP和Hy2核心'
python3 - "$SOURCE/config/releases.json" "$STAGE" <<'PY'
import json,subprocess,pathlib,sys,hashlib,urllib.parse
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text());stage=pathlib.Path(sys.argv[2])
for name in ('node','xray','hysteria'):
 item=manifest[name];url=urllib.parse.urlparse(item['url'])
 assert url.scheme=='https' and url.hostname in ('nodejs.org','github.com')
 target=stage/name
 subprocess.run(['curl','--proto','=https','--tlsv1.2','-fL','--retry','2','--connect-timeout','15','--max-time','240',item['url'],'-o',str(target)],check=True)
 assert hashlib.sha256(target.read_bytes()).hexdigest()==item['sha256'],name+'下载校验失败'
PY
install -d -m 755 "$STAGE/runtime" "$STAGE/xray-files" "$STAGE/app"
tar --no-same-owner -xJf "$STAGE/node" --strip-components=1 -C "$STAGE/runtime"
unzip -q "$STAGE/xray" -d "$STAGE/xray-files"
for path in apps src public config docs scripts package.json package-lock.json README.md AGENTS.md install.sh bootstrap.sh; do cp -a -- "$SOURCE/$path" "$STAGE/app/"; done
find "$STAGE/app" -type l -print -quit | python3 -c 'import sys; assert not sys.stdin.read().strip(),"源码不允许包含符号链接"'
chown -R root:root "$STAGE/runtime" "$STAGE/app"
chmod -R go-w "$STAGE/runtime" "$STAGE/app"
install -m 755 "$STAGE/xray-files/xray" /usr/local/lib/vps-panel/xray
install -m 755 "$STAGE/hysteria" /usr/local/lib/vps-panel/hysteria
cp -a "$STAGE/runtime" /usr/local/lib/vps-panel/runtime
cp -a "$STAGE/app" /usr/local/lib/vps-panel/app
llhh_step '安装面板依赖'
/usr/local/lib/vps-panel/runtime/bin/node /usr/local/lib/vps-panel/runtime/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix /usr/local/lib/vps-panel/app
chown -R root:root /usr/local/lib/vps-panel
chmod -R go+rX /usr/local/lib/vps-panel
chmod -R go-w /usr/local/lib/vps-panel
runuser -u vps-panel -- /usr/local/lib/vps-panel/runtime/bin/node --input-type=module - <<'JS'
import{createRequire}from'node:module';
const require=createRequire('/usr/local/lib/vps-panel/app/package.json');
require('qrcode');require('acme-client');
JS
install -d -m 700 -o vps-panel -g vps-panel /var/lib/vps-panel
if [[ $RESTORE == 1 ]]; then chown -hR vps-panel:vps-panel /var/lib/vps-panel;fi
install -d -m 755 /usr/local/lib/vps-panel/site
printf '%s\n' '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>欢迎</title><h1>欢迎访问</h1></html>' >/usr/local/lib/vps-panel/site/index.html
chmod 644 /usr/local/lib/vps-panel/site/index.html
python3 - <<'PY'
import json,pwd,grp,pathlib
profiles=('vmess.att','vmess.direct','hy2.att','hy2.direct')
identities={profile:pwd.getpwnam('vps-panel-'+profile.replace('.','-')).pw_uid for profile in profiles}
assert len(set(identities.values()))==4 and all(100<=uid<=60000 for uid in identities.values())
names=['vps-panel']+['vps-panel-'+profile.replace('.','-')for profile in profiles]
accounts={}
for name in names:
 entry=pwd.getpwnam(name)
 assert entry.pw_shell=='/usr/sbin/nologin' and entry.pw_dir==('/var/lib/vps-panel'if name=='vps-panel'else'/nonexistent'),'已存在同名但不属于本程序的账户'
 accounts[name]={'uid':entry.pw_uid,'gid':entry.pw_gid}
pathlib.Path('/etc/vps-panel/identities.json').write_text(json.dumps(identities))
pathlib.Path('/etc/vps-panel/accounts.json').write_text(json.dumps(accounts))
PY
PRESERVE_CERT=0
if [[ $RESTORE == 1 && -s /etc/vps-panel/certs/panel-fullchain.pem && -s /etc/vps-panel/certs/panel-privkey.pem ]]; then PRESERVE_CERT=1;fi
if [[ $PRESERVE_CERT == 1 ]]; then
 CHECK_KIND=-checkhost
 [[ $PANEL_SAN != IP:* ]] || CHECK_KIND=-checkip
 if ! openssl x509 -in /etc/vps-panel/certs/panel-fullchain.pem -noout "$CHECK_KIND" "$PANEL_IP" >/dev/null 2>&1; then PRESERVE_CERT=0;fi
fi
if [[ $PRESERVE_CERT == 0 ]]; then
 openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 -subj '/CN=VPS Panel' -addext "subjectAltName=$PANEL_SAN" -keyout "$STAGE/panel-privkey.pem" -out "$STAGE/panel-fullchain.pem" >/dev/null 2>&1
 /usr/local/lib/vps-panel/runtime/bin/node --input-type=module - "$STAGE" <<'JS'
import{readFileSync}from'node:fs';
import{atomicWrite}from'/usr/local/lib/vps-panel/app/src/system-driver.mjs';
for(const name of['panel-fullchain.pem','panel-privkey.pem'])await atomicWrite('/etc/vps-panel/certs/'+name,readFileSync(process.argv[2]+'/'+name));
JS
fi
cat >/etc/vps-panel/web.env <<EOF
NODE_ENV=production
VPS_DATA_DIR=/var/lib/vps-panel
VPS_HOST=$PANEL_BIND
VPS_PORT=$PANEL_PORT
VPS_ORIGIN=https://$PANEL_IP:$PANEL_PORT
VPS_AGENT_ENABLED=1
VPS_TLS_CERT=/run/credentials/vps-panel-web.service/fullchain.pem
VPS_TLS_KEY=/run/credentials/vps-panel-web.service/privkey.pem
EOF
if [[ $PRESERVE_CERT == 0 ]];then
 llhh_step '申请受信任IP证书（需要服务商放行TCP 80）'
 /usr/local/lib/vps-panel/runtime/bin/node /usr/local/lib/vps-panel/app/src/ip-certificate-cli.mjs --initial
fi
/usr/local/lib/vps-panel/runtime/bin/node --input-type=module - <<'JS'
import{writeFileSync}from'node:fs';
import{serviceUnits}from'/usr/local/lib/vps-panel/app/src/service-units.mjs';
for(const[name,contents]of Object.entries(serviceUnits()))writeFileSync('/etc/systemd/system/'+name,contents,{mode:0o644});
JS
INIT_ARGS=()
[[ $RESTORE == 0 ]] || INIT_ARGS+=(--restore)
[[ $RESTORE == 1 ]] || INIT_ARGS+=(--role "$INSTALL_ROLE")
INIT_RESULT=$(runuser -u vps-panel -- env VPS_DATA_DIR=/var/lib/vps-panel /usr/local/lib/vps-panel/runtime/bin/node /usr/local/lib/vps-panel/app/src/install-init.mjs "${INIT_ARGS[@]}")
/usr/local/lib/vps-panel/runtime/bin/node --input-type=module - "$INIT_RESULT" "$PRESERVE_CERT" <<'JS'
import{writeFileSync,readFileSync}from'node:fs';
const result=JSON.parse(process.argv[2]);
if(!['relay','exit'].includes(result.role))throw new Error('恢复角色错误');
let panel={};
if(result.restored&&process.argv[3]==='1'){
 try{const previous=JSON.parse(readFileSync('/etc/vps-panel/system.json','utf8'));panel={panelUseAcme:!!previous.panelUseAcme,initialOrigin:previous.initialOrigin||null,panelCertificateFingerprint:previous.panelCertificateFingerprint||null};}catch(error){if(error.code!=='ENOENT')throw error;}
}
writeFileSync('/etc/vps-panel/system.json',JSON.stringify({...panel,role:result.role,emergencyStop:result.restored,desired:{},networkDesired:false,autoStart:false,autoRepair:false}),{mode:0o600});
JS
install -m 755 /usr/local/lib/vps-panel/app/config/vps-panel /usr/local/bin/llhh
install -m 755 /usr/local/lib/vps-panel/app/config/vps-panel /usr/local/bin/vps-panel
llhh_step '启动管理服务并验证配置'
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/vps-panel-{agent,web,auth,worker,network,guard}.service /etc/systemd/system/vps-panel-{vmess-att,vmess-direct,hy2-att,hy2-direct}.service
systemctl enable --now vps-panel-agent.service vps-panel-web.service vps-panel-auth.service vps-panel-worker.service vps-panel-ip-certificate.timer
if [[ $PANEL_BIND != 127.0.0.1 ]]; then
 /usr/local/lib/vps-panel/runtime/bin/node --input-type=module - "$PANEL_PORT" <<'JS'
import{createFirewall}from'/usr/local/lib/vps-panel/app/src/firewall.mjs';
await createFirewall().allowPort(Number(process.argv[2]),'tcp','vps-panel-web');
JS
fi
llhh_step '检查HTTPS、管理入口和后台服务'
/usr/local/lib/vps-panel/runtime/bin/node --input-type=module - <<'JS'
import{managementHealth}from'/usr/local/lib/vps-panel/app/src/management-health.mjs';
await managementHealth({attempts:60});
JS
printf '{"completed":true}\n' >/usr/local/lib/vps-panel/install-complete.json
chmod 600 /usr/local/lib/vps-panel/install-complete.json
echo '面板已安装；所有代理线路仍处于停止状态。'
echo '面板使用受信任IP证书并自动续期，账号及后续配置均在网页完成。'
echo '首次激活面板（账号密码在网页中创建）：'
runuser -u vps-panel -- env VPS_DATA_DIR=/var/lib/vps-panel VPS_ORIGIN="https://$PANEL_IP:$PANEL_PORT" /usr/local/lib/vps-panel/runtime/bin/node /usr/local/lib/vps-panel/app/src/first-login.mjs
echo '打开首次激活链接，点击“激活面板”，再设置你的用户名和密码。'
printf '\nSSH备用管理：llhh\n'
