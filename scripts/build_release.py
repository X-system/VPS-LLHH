"""Build a source-only release. Never include local runtime data or credentials."""
import hashlib,json,pathlib,tarfile,gzip,io,re
ROOT=pathlib.Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
assert re.fullmatch(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-test[1-9]\d*)?',VERSION)
OUTPUT=ROOT/'dist';OUTPUT.mkdir(exist_ok=True)
ALLOWED=('apps','src','public','config','docs','scripts','package.json','package-lock.json','README.md','AGENTS.md','install.sh','bootstrap.sh')
files=[]
for item in ALLOWED:
 path=ROOT/item
 if not path.exists():raise RuntimeError('Missing release source: '+item)
 for file in sorted(path.rglob('*'))if path.is_dir()else[path]:
  if file.is_symlink():raise RuntimeError('Symlinks are not allowed: '+str(file))
  if file.is_file():
   name=file.relative_to(ROOT).as_posix()
   if any(part in('data','node_modules','.git','test-results','backups','__pycache__')for part in file.relative_to(ROOT).parts):raise RuntimeError('Private content in release tree')
   if file.name.startswith('.env')or file.suffix.lower()in('.pem','.key','.p12','.pfx','.sqlite','.db','.pcap','.pcapng','.log','.backup'):raise RuntimeError('Private file type in release tree: '+name)
   if (name.endswith('.sh')or name=='config/vps-panel')and b'\r'in file.read_bytes():raise RuntimeError('Executable source must use LF line endings: '+name)
   files.append((name,file))
manifest={'format':'vps-panel-release','version':VERSION,'runtimeMajor':24,'schemaVersion':2,'installRoleArgument':'--role)'in(ROOT/'install.sh').read_text(encoding='utf-8'),'files':{name:hashlib.sha256(file.read_bytes()).hexdigest()for name,file in files}}
archive=OUTPUT/('vps-panel-v'+VERSION+'.tar.gz')
with archive.open('wb')as target,gzip.GzipFile(filename='',mode='wb',fileobj=target,mtime=0)as compressed,tarfile.open(fileobj=compressed,mode='w')as tar:
 for name,file in files:
  data=file.read_bytes();info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o755 if name.endswith('.sh')or name=='config/vps-panel'else 0o644
  tar.addfile(info,io.BytesIO(data))
 data=json.dumps(manifest,sort_keys=True).encode();info=tarfile.TarInfo('release-manifest.json');info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))
checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
(OUTPUT/(archive.name+'.sha256')).write_text(checksum+'  '+archive.name+'\n',encoding='ascii')
print(archive)
print(checksum)
