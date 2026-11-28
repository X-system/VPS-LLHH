"""Test the explicitly authorized test2 replacement; no GitHub requests."""
import pathlib,sys,tempfile,json,os,hashlib,urllib.error,io
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import publish_release as publisher
version='v0.3.3-test2';old='a'*40;new='b'*40;refs={};releases={};next_id=100
def asset(name,data,ident):return dict(id=ident,name=name,size=len(data),digest='sha256:'+hashlib.sha256(data).hexdigest())
for i,role in enumerate(['relay','exit'],1):
    tag=role+'-'+version;refs[tag]=old;releases[i]=dict(id=i,tag_name=tag,draft=False,prerelease=True,target_commitish=old,body='old notes',assets=[asset('vps-panel-'+version+'.tar.gz',b'old package',i*10),asset('vps-panel-'+version+'.tar.gz.sha256',b'old sha',i*10+1),asset('bootstrap.sh',b'old installer',i*10+2),asset('bootstrap.sh.sha256',b'old installer sha',i*10+3)])
class Response(io.BytesIO):
    status=200
    def __init__(self,data):super().__init__(json.dumps(data).encode())
class Opener:
    def open(self,req,timeout):
        global next_id
        from urllib.parse import urlparse,unquote,parse_qs
        u=urlparse(req.full_url);path=unquote(u.path);method=req.get_method();body=json.loads(req.data)if req.data and req.headers.get('Content-type')=='application/json'else None
        if '/git/ref/tags/'in path:
            key=path.split('/git/ref/tags/')[1]
            if key not in refs:raise urllib.error.HTTPError(req.full_url,404,'missing',{},None)
            return Response({'object':{'type':'commit','sha':refs[key]}})
        if path.endswith('/git/refs'):
            assert method=='POST';refs[body['ref'].removeprefix('refs/tags/')]=body['sha'];return Response({})
        if '/git/refs/tags/'in path:
            assert method=='PATCH'and body['force'];refs[path.split('/git/refs/tags/')[1]]=body['sha'];return Response({})
        if '/releases/tags/'in path:return Response(next(v for v in releases.values()if v['tag_name']==path.split('/releases/tags/')[1]))
        if '/releases/assets/'in path:
            ident=int(path.rsplit('/',1)[1]);r=next(r for r in releases.values()if any(a['id']==ident for a in r['assets']));a=next(a for a in r['assets']if a['id']==ident)
            if method=='DELETE':assert a['name'].startswith('bootstrap');r['assets'].remove(a)
            else:assert body['name'].startswith('archive-');a['name']=body['name']
            return Response({})
        if u.hostname=='uploads.github.com':
            r=releases[int(path.split('/releases/')[1].split('/')[0])];name=parse_qs(u.query)['name'][0];next_id+=1;a=asset(name,req.data,next_id);r['assets'].append(a);return Response(a)
        r=releases[int(path.rsplit('/',1)[1])]
        if method=='PATCH':
            if body.get('draft')is False:assert any(a['name']=='vps-panel-'+version+'.tar.gz'and a['digest']=='sha256:'+hashlib.sha256(b'new package').hexdigest()for a in r['assets'])
            r.update(body)
        return Response(r)
with tempfile.TemporaryDirectory()as tmp:
    root=pathlib.Path(tmp);(root/'dist').mkdir();(root/'docs/releases').mkdir(parents=True);(root/'package.json').write_text('{"version":"0.3.3-test2"}');(root/'bootstrap.sh').write_text("REPOSITORY=''\nVERSION=''\n");(root/'dist'/('vps-panel-'+version+'.tar.gz')).write_bytes(b'new package');(root/'dist'/('vps-panel-'+version+'.tar.gz.sha256')).write_bytes(b'new sha');(root/'docs/releases/0.3.3-test2.md').write_text('更新欢迎激活与证书。'*20,encoding='utf-8')
    with patch.object(publisher,'ROOT',root),patch.dict(os.environ,{'GITHUB_REPOSITORY':'fixture/panel','GITHUB_SHA':new,'GH_RELEASE_TOKEN':'fixture','LLHH_REPLACE_TEST_RELEASE':version}),patch.object(publisher.urllib.request,'build_opener',return_value=Opener()):publisher.main()
for r in releases.values():
    assert not r['draft']and refs[r['tag_name']]==new
    assert refs['archive/'+r['tag_name']+'-'+old[:12]]==old
    assert len([a for a in r['assets']if a['name'].startswith('archive-')])==2
print(json.dumps({'oldSourceAndProgramsPreserved':True,'newPackageAndTagConsistent':True}))
