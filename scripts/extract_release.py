"""Extract a verified source release, rejecting links, traversal and extra files."""
import sys,pathlib,tarfile,json,hashlib
archive=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2]).resolve()
if target.exists()and any(target.iterdir()):raise RuntimeError('Release target must be empty')
target.mkdir(mode=0o700,parents=True,exist_ok=True)
with tarfile.open(archive,'r:gz')as tar:
 members=tar.getmembers()
 if len(members)>5000 or sum(member.size for member in members)>40*1024*1024:raise RuntimeError('Release too large')
 names=set()
 for member in members:
  path=pathlib.PurePosixPath(member.name)
  if member.name in names or not member.isfile()or path.is_absolute()or'..'in path.parts or'\\'in member.name:raise RuntimeError('Unsafe release member')
  if path.parts[0]not in('apps','src','public','config','docs','scripts','package.json','package-lock.json','README.md','AGENTS.md','install.sh','bootstrap.sh','release-manifest.json'):raise RuntimeError('Unexpected release member')
  names.add(member.name)
 manifest=json.load(tar.extractfile('release-manifest.json'))
 if manifest.get('format')!='vps-panel-release'or set(manifest['files'])!=names-{'release-manifest.json'}:raise RuntimeError('Release manifest mismatch')
 for member in members:
  data=tar.extractfile(member).read()
  if member.name!='release-manifest.json'and hashlib.sha256(data).hexdigest()!=manifest['files'][member.name]:raise RuntimeError('Release file digest mismatch')
  destination=target/member.name
  if not destination.resolve().is_relative_to(target):raise RuntimeError('Release escaped target')
  destination.parent.mkdir(parents=True,exist_ok=True)
  with destination.open('xb')as output:output.write(data)
  destination.chmod(0o755 if member.name.endswith('.sh')or member.name=='config/vps-panel'else 0o644)
print(manifest['version'])
