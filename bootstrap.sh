#!/bin/bash
set -Eeuo pipefail
umask 077
REPOSITORY=''
VERSION=''
INSTALLABLE_VERSIONS='["v0.3.3-test2"]'
RESTORE=0
INSTALL_ROLE=''
while [[ $# -gt 0 ]]; do
 case "$1" in --repository) REPOSITORY=${2:?缺少仓库};shift 2;;--version) VERSION=${2:?缺少版本};shift 2;;--role)INSTALL_ROLE=${2:?缺少安装角色};shift 2;;--restore)RESTORE=1;shift;;*) echo '参数错误。';exit 1;;esac
done
[[ $REPOSITORY =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]] || { echo '请指定GitHub仓库：--repository owner/repo';exit 1; }
[[ -z $VERSION || $VERSION =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-test[1-9][0-9]*)?$ ]] || { echo '版本格式错误，例如 v0.2.0-test1';exit 1; }
[[ -z $INSTALL_ROLE || $INSTALL_ROLE == relay || $INSTALL_ROLE == exit ]] || { echo '安装角色错误。';exit 1; }
[[ $(id -u) == 0 ]] || { echo '请使用root或sudo。';exit 1; }
# LLHH_EMBED_ENVIRONMENT
if ! declare -F llhh_environment >/dev/null;then
 source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/config/install-environment.sh"
fi
llhh_environment ca-certificates curl python3
INTERACTIVE=0
heading(){ printf "\n----------------------------------------\n  %s\n----------------------------------------\n" "$1"; }
ask(){
 [[ -r /dev/tty ]] || llhh_stop '没有可交互终端；无人值守请指定--role和--version。'
 printf '%s' "$2" >/dev/tty
 if ! IFS= read -r "$1" </dev/tty;then llhh_stop '输入已中断。没有继续安装，可重新执行原命令。';fi
}
heading 'LLHH 安装向导'
printf '  环境检查已通过，接下来选择角色和版本。\n'
if [[ -z $INSTALL_ROLE ]];then
 INTERACTIVE=1
 heading '第1步 / 3  选择服务器角色'
 printf '  1) 中转端  接入用户，直出或连接ATT出口\n  2) 出口端  接收中转机流量并提供出口\n\n  总控端暂未开放安装。\n\n'
 while true;do
  ask ROLE_CHOICE '请输入 [1-2]：'
  case "$ROLE_CHOICE" in 1)INSTALL_ROLE=relay;break;;2)INSTALL_ROLE=exit;break;;*)printf '输入无效，请输入数字1或2。\n';;esac
 done
fi
ROLE_LABEL='中转端';[[ $INSTALL_ROLE != exit ]] || ROLE_LABEL='出口端'
printf '\n已选择：%s\n' "$ROLE_LABEL"
heading '第2步 / 3  选择安装版本'
STAGE=$(mktemp -d /var/tmp/vps-panel-bootstrap.XXXXXXXX)
cleanup(){ if [[ $STAGE == /var/tmp/vps-panel-bootstrap.* && -d $STAGE && ! -L $STAGE ]];then rm -rf -- "$STAGE";fi; }
trap cleanup EXIT
llhh_step '获取可安装版本列表'
python3 - "$REPOSITORY" "$STAGE/versions.json" "$INSTALL_ROLE" "$INSTALLABLE_VERSIONS" <<'CATALOG'
import sys,json,re,urllib.request
repo=sys.argv[1];role=sys.argv[3];found={};allowed=json.loads(sys.argv[4])if len(sys.argv)>4 else None
pattern=r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-test([1-9]\d*))?'
for page in range(1,11):
 req=urllib.request.Request('https://api.github.com/repos/'+repo+'/releases?per_page=100&page='+str(page),headers={'User-Agent':'VPS-LLHH-installer','Accept':'application/vnd.github+json'})
 with urllib.request.urlopen(req,timeout=30)as response:releases=json.load(response)
 if not isinstance(releases,list):raise RuntimeError('发布列表格式错误')
 for release in releases:
  tag=release.get('tag_name','');prefix=role+'-';version_tag=tag[len(prefix):]if tag.startswith(prefix)else '';match=re.fullmatch(pattern,version_tag)
  if allowed is not None and version_tag not in allowed:continue
  if not match or release.get('draft')or '<!-- llhh:installer -->'in(release.get('body')or ''):continue
  test=match[4]is not None
  if bool(release.get('prerelease'))!=test:continue
  name='vps-panel-'+version_tag+'.tar.gz';url='https://github.com/'+repo+'/releases/download/'+tag+'/'+name
  asset=next((a for a in release.get('assets',[])if a.get('name')==name),None)
  if not asset or asset.get('browser_download_url')!=url or not re.fullmatch(r'sha256:[a-f0-9]{64}',asset.get('digest',''))or not 0<asset.get('size',0)<=20*1024*1024:continue
  found[tag]={'tag':version_tag,'releaseTag':tag,'label':version_tag[1:]+('（测试版）'if test else ''),'sha256':asset['digest'][7:],'sort':tuple(map(int,match.group(1,2,3)))+(int(match[4])if test else 0,test is False)}
 if len(releases)<100:break
if not found:raise RuntimeError('暂时没有可安装的发布版本，请稍后重试')
# A stable release follows every test build of the same base version.
items=sorted(found.values(),key=lambda a:(*a['sort'][:3],a['sort'][4],a['sort'][3]))
with open(sys.argv[2],'w')as output:json.dump(items,output)
for i,item in enumerate(items,1):print('  '+str(i)+') '+item['label'])
CATALOG
if [[ -z $VERSION ]];then
 INTERACTIVE=1
 printf '\n请从上方列表选择版本，带（测试版）的为测试版本。\n'
 [[ -r /dev/tty ]] || { echo '无人值守安装请通过 --version v0.2.0-test1 指定版本。';exit 1; }
 while true;do
  ask CHOICE '请输入版本序号：'
  if [[ $CHOICE =~ ^[1-9][0-9]{0,3}$ ]];then
   VERSION=$(python3 -c 'import json,sys;items=json.load(open(sys.argv[1]));n=int(sys.argv[2]);print(items[n-1]["tag"]if 0<n<=len(items)else "")' "$STAGE/versions.json" "$CHOICE")
   [[ -z $VERSION ]] || break
  fi
  echo '序号无效，请重新输入：'
 done
fi
llhh_step '验证所选安装版本'
EXPECTED=$(python3 -c 'import json,sys;items=json.load(open(sys.argv[1]));item=next((a for a in items if a["tag"]==sys.argv[2]),None);print(item["sha256"]if item else "")' "$STAGE/versions.json" "$VERSION")
[[ $EXPECTED =~ ^[a-f0-9]{64}$ ]] || llhh_stop '所选版本当前不提供安装，或发布校验信息不完整，请重新运行选择可安装版本。'
python3 - "$VERSION" <<'EXISTING'
import sys,json,pathlib
path=pathlib.Path('/usr/local/lib/vps-panel/app/package.json')
if path.exists():
 assert not path.is_symlink(),'安装目录不安全'
 assert json.loads(path.read_text())['version']==sys.argv[1][1:],'已安装其他版本。安装器不会覆盖或降级现有面板，请使用面板更新；需要切换到旧版时先卸载并使用空白数据目录。'
EXISTING
heading '第3步 / 3  确认安装'
printf '  服务器角色：%s\n  安装版本：%s\n  安装方式：自动检查环境、安装依赖并验证管理服务\n' "$ROLE_LABEL" "${VERSION#v}"
if [[ $INTERACTIVE == 1 ]];then
 printf '\n  1) 确认并开始安装\n  0) 取消，不继续安装\n\n'
 while true;do
  ask CONFIRM '请输入 [1/0]：'
  case "$CONFIRM" in 1)break;;0)printf '\n已取消，没有继续安装面板。\n';exit 0;;*)printf '输入无效，请输入1或0。\n';;esac
 done
fi
ASSET="vps-panel-$VERSION.tar.gz"
BASE="https://github.com/$REPOSITORY/releases/download/$INSTALL_ROLE-$VERSION"
llhh_step '下载并验证安装包'
curl --retry 3 --proto '=https' --tlsv1.2 -fL --connect-timeout 15 --max-time 180 --max-filesize 20971520 "$BASE/$ASSET" -o "$STAGE/$ASSET"
python3 - "$STAGE/$ASSET" "$EXPECTED" "$STAGE/source" "$VERSION" <<'PACKAGE'
import sys,pathlib,hashlib,tarfile,json,sqlite3
archive=pathlib.Path(sys.argv[1]);assert hashlib.sha256(archive.read_bytes()).hexdigest()==sys.argv[2],'发布包校验失败'
target=pathlib.Path(sys.argv[3]);target.mkdir(mode=0o700)
with tarfile.open(archive,'r:gz')as tar:
 members=tar.getmembers();assert len(members)<5000 and sum(m.size for m in members)<40*1024*1024
 names=set()
 for member in members:
  path=pathlib.PurePosixPath(member.name)
  assert member.isfile()and not path.is_absolute()and'..'not in path.parts and'\\'not in member.name and member.name not in names
  names.add(member.name)
 manifest=json.load(tar.extractfile('release-manifest.json'))
 assert manifest.get('format')=='vps-panel-release'and manifest['version']==sys.argv[4][1:]and set(manifest['files'])==names-{'release-manifest.json'},'发布清单不匹配'
 assert json.load(tar.extractfile('package.json'))['version']==manifest['version'],'版本不匹配'
 database=pathlib.Path('/var/lib/vps-panel/panel.sqlite')
 if database.exists():
  connection=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)
  try:assert connection.execute('PRAGMA user_version').fetchone()[0]<=manifest['schemaVersion'],'不能用旧版程序恢复新版数据库'
  finally:connection.close()
 for member in members:
  data=tar.extractfile(member).read()
  if member.name!='release-manifest.json':assert hashlib.sha256(data).hexdigest()==manifest['files'][member.name],'文件校验失败'
  destination=target/member.name;destination.parent.mkdir(parents=True,exist_ok=True)
  with destination.open('xb')as file:file.write(data)
PACKAGE
INSTALL_ARGS=()
[[ $RESTORE == 0 ]] || INSTALL_ARGS+=(--restore)
if [[ -n $INSTALL_ROLE ]];then
 python3 -c 'import json,sys;assert json.load(open(sys.argv[1])).get("installRoleArgument"),"这个历史版本在网页中选择角色，不支持 --role 参数"' "$STAGE/source/release-manifest.json"
 INSTALL_ARGS+=(--role "$INSTALL_ROLE")
fi
echo "正在安装：${VERSION#v}"
llhh_step '安装面板与后台服务'
bash "$STAGE/source/install.sh" --source "$STAGE/source" "${INSTALL_ARGS[@]}"
printf '%s\n' "$REPOSITORY" >/etc/vps-panel/repository
chmod 600 /etc/vps-panel/repository

llhh_step '最终验收：检查管理服务和HTTPS入口'
for unit in agent web auth worker;do
 systemctl is-active --quiet "vps-panel-$unit.service"
done
/usr/local/lib/vps-panel/runtime/bin/node --input-type=module - <<'CHECK'
import{managementHealth}from'/usr/local/lib/vps-panel/app/src/management-health.mjs';
await managementHealth({attempts:30});
CHECK
heading 'LLHH 安装完成 · 管理服务验收通过'
printf '  服务器角色：%s\n  安装版本：%s\n\n  [通过] 管理器、网页、认证与采集后台已运行\n  [通过] HTTPS、管理入口与访问响应检查\n\n' "$ROLE_LABEL" "${VERSION#v}"
printf '面板地址：\n'
vps-panel address
printf '\n下一步：打开上面的地址，按网页引导设置账号、证书与配对。\n首次设置链接和备用临时凭证请查看上方输出，请勿转发。\n代理线路请在网页内完成配置后确认开启。\nSSH备用管理：vps-panel\n'
