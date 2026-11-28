import pathlib,tempfile,json,sys,io,tarfile,hashlib,sqlite3
from unittest.mock import patch
sys.dont_write_bytecode=True
source=(pathlib.Path(__file__).resolve().parents[1]/'bootstrap.sh').read_text(encoding='utf-8')
def block(name):return source.split("<<'"+name+"'\n",1)[1].split('\n'+name+'\n',1)[0]
def release(role,version,**extra):
 tag=role+'-v'+version;name='vps-panel-v'+version+'.tar.gz'
 return dict(tag_name=tag,prerelease='-test'in version,assets=[dict(name=name,size=123,digest='sha256:'+'a'*64,browser_download_url='https://github.com/example/panel/releases/download/'+tag+'/'+name)],**extra)
releases=[release('relay','0.2.0-test10'),release('exit','0.5.0'),release('relay','0.2.0'),release('relay','0.1.0-test1'),release('relay','0.2.0-test2'),release('relay','0.2.0-test1'),release('relay','0.9.0',draft=True),release('relay','0.8.0',body='<!-- llhh:installer -->'),dict(tag_name='relay-v1.0.0',assets=[])]
class Response(io.BytesIO):
 def __init__(self):super().__init__(json.dumps(releases).encode())
with tempfile.TemporaryDirectory()as temporary:
 root=pathlib.Path(temporary);catalog=root/'versions.json'
 with patch.object(sys,'argv',['fixture','example/panel',str(catalog),'relay']),patch('urllib.request.urlopen',return_value=Response()):exec(compile(block('CATALOG'),'catalog','exec'),{})
 assert [x['tag']for x in json.loads(catalog.read_text())]==['v0.1.0-test1','v0.2.0-test1','v0.2.0-test2','v0.2.0-test10','v0.2.0']
 with patch.object(sys,'argv',['fixture','example/panel',str(catalog),'exit']),patch('urllib.request.urlopen',return_value=Response()):exec(compile(block('CATALOG'),'catalog','exec'),{})
 assert [x['label']for x in json.loads(catalog.read_text())]==['0.5.0']
 with patch.object(sys,'argv',['fixture','example/panel',str(catalog),'relay','["v0.2.0-test2"]']),patch('urllib.request.urlopen',return_value=Response()):exec(compile(block('CATALOG'),'catalog','exec'),{})
 assert [x['tag']for x in json.loads(catalog.read_text())]==['v0.2.0-test2']

 archive=root/'package.tar.gz';data=b'{"version":"0.1.0-test1"}';manifest={'format':'vps-panel-release','version':'0.1.0-test1','schemaVersion':1,'files':{'package.json':hashlib.sha256(data).hexdigest()}}
 def pack(evil=False):
  with tarfile.open(archive,'w:gz')as tar:
   for name,value in [('package.json',data),('release-manifest.json',json.dumps(manifest).encode())]+([('../escape',b'x')]if evil else []):
    member=tarfile.TarInfo(name);member.size=len(value);tar.addfile(member,io.BytesIO(value))
 database=root/'database.sqlite';code=block('PACKAGE').replace("pathlib.Path('/var/lib/vps-panel/panel.sqlite')",'pathlib.Path('+repr(str(database))+')')
 def extract(target):
  with patch.object(sys,'argv',['fixture',str(archive),hashlib.sha256(archive.read_bytes()).hexdigest(),str(target),'v0.1.0-test1']):exec(compile(code,'package','exec'),{})
 pack();extract(root/'good');assert (root/'good/package.json').exists()
 pack(True)
 try:extract(root/'bad')
 except AssertionError:pass
 else:raise AssertionError('Traversal accepted')
 assert not(root/'escape').exists()
 pack();db=sqlite3.connect(database);db.execute('PRAGMA user_version=2');db.close()
 try:extract(root/'downgrade')
 except AssertionError:pass
 else:raise AssertionError('New database accepted by old installer')
 assert not(root/'downgrade/package.json').exists()
print(json.dumps({'passed':True}))
