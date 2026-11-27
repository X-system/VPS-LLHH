#!/bin/bash
set -euo pipefail
umask 077
REPOSITORY=''
VERSION=''
RESTORE=0
INSTALL_ROLE=''
while [[ $# -gt 0 ]]; do
 case "$1" in --repository) REPOSITORY=${2:?缺少仓库};shift 2;;--version) VERSION=${2:?缺少版本};shift 2;;--role)INSTALL_ROLE=${2:?缺少安装角色};shift 2;;--restore)RESTORE=1;shift;;*) echo '参数错误。';exit 1;;esac
done
[[ $REPOSITORY =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ && $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '请指定GitHub仓库与正式版本，例如 --repository owner/repo --version v0.1.0';exit 1; }
[[ $(id -u) == 0 ]] || { echo '请使用root或sudo。';exit 1; }
if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || [[ ! -s /etc/ssl/certs/ca-certificates.crt ]];then
 command -v apt-get >/dev/null || { echo '当前安装引导仅支持具备apt的Linux环境。';exit 1; }
 export DEBIAN_FRONTEND=noninteractive
 apt-get update -qq
 apt-get install -y --no-install-recommends ca-certificates curl python3
fi
STAGE=$(mktemp -d /var/tmp/vps-panel-bootstrap.XXXXXXXX)
ASSET="vps-panel-$VERSION.tar.gz"
BASE="https://github.com/$REPOSITORY/releases/download/$VERSION"
curl --proto '=https' --tlsv1.2 -fL --connect-timeout 15 --max-time 180 "$BASE/$ASSET" -o "$STAGE/$ASSET"
curl --proto '=https' --tlsv1.2 -fL --connect-timeout 15 --max-time 30 "$BASE/$ASSET.sha256" -o "$STAGE/checksum"
python3 - "$STAGE/$ASSET" "$STAGE/checksum" "$STAGE/source" <<'PY'
import sys,pathlib,hashlib,tarfile
archive=pathlib.Path(sys.argv[1]);expected=pathlib.Path(sys.argv[2]).read_text().split()[0]
assert len(expected)==64 and hashlib.sha256(archive.read_bytes()).hexdigest()==expected,'发布包校验失败'
target=pathlib.Path(sys.argv[3]);target.mkdir(mode=0o700)
# Bootstrap extraction is deliberately restricted before executing any package code.
with tarfile.open(archive,'r:gz')as tar:
 members=tar.getmembers();assert len(members)<5000 and sum(m.size for m in members)<40*1024*1024
 names=set()
 for member in members:
  path=pathlib.PurePosixPath(member.name)
  assert member.isfile()and not path.is_absolute()and'..'not in path.parts and'\\'not in member.name and member.name not in names
  names.add(member.name);destination=target/member.name;destination.parent.mkdir(parents=True,exist_ok=True)
  with destination.open('xb')as file:file.write(tar.extractfile(member).read())
PY
INSTALL_ARGS=()
[[ $RESTORE == 0 ]] || INSTALL_ARGS+=(--restore)
[[ -z $INSTALL_ROLE ]] || INSTALL_ARGS+=(--role "$INSTALL_ROLE")
bash "$STAGE/source/install.sh" --source "$STAGE/source" "${INSTALL_ARGS[@]}"
printf '%s\n' "$REPOSITORY" >/etc/vps-panel/repository
chmod 600 /etc/vps-panel/repository
if [[ $STAGE == /var/tmp/vps-panel-bootstrap.* && -d $STAGE && ! -L $STAGE ]]; then rm -rf -- "$STAGE";fi
