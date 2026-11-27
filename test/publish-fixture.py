"""Exercise the release transaction without contacting GitHub."""
import pathlib,sys,tempfile,json,os,hashlib,urllib.error,io
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import publish_release as publisher

mode=sys.argv[1];requests=[];published=False
class Response(io.BytesIO):
    status=200
    def __init__(self,value):super().__init__(json.dumps(value).encode())
class Opener:
    def open(self,request,timeout):
        global published
        requests.append(request);method=request.get_method();url=request.full_url
        if '/releases/tags/'in url:
            if mode=='existing':return Response({'draft':False})
            raise urllib.error.HTTPError(url,404,'missing',{},None)
        if url.endswith('/releases'):
            body=json.loads(request.data);assert body['draft']is True;assert '修复' in body['body'];assert ('llhh:update-policy' in body['body'])==(mode=='required')
            return Response({'id':7,'draft':True,'target_commitish':'a'*40,'assets':[]})
        if url.startswith('https://uploads.github.com/'):
            if mode=='failure':raise urllib.error.HTTPError(url,403,'denied',{},None)
            return Response({'size':len(request.data),'digest':'sha256:'+hashlib.sha256(request.data).hexdigest()})
        assert method=='PATCH';assert len([r for r in requests if r.full_url.startswith('https://uploads.github.com/')])in (4,8)
        assert json.loads(request.data)['draft']is False;published=True;return Response({})

with tempfile.TemporaryDirectory()as temporary:
    root=pathlib.Path(temporary);(root/'dist').mkdir();(root/'package.json').write_text('{"version":"0.2.0"}');(root/'bootstrap.sh').write_text("#!/bin/bash\nREPOSITORY=''\nVERSION=''\n")
    (root/'dist/vps-panel-v0.2.0.tar.gz').write_bytes(b'fixture-package');(root/'dist/vps-panel-v0.2.0.tar.gz.sha256').write_text('fixture-checksum')
    (root/'docs/releases').mkdir(parents=True)
    if mode!='missing':(root/'docs/releases/0.2.0.md').write_text('# 0.2.0\n'+('新增线路管理，修复移动端布局与更新提醒。'*10),encoding='utf-8')
    if mode=='required':
        (root/'config').mkdir();(root/'config/update-policy.json').write_text('{"required":true}')
    with patch.object(publisher,'ROOT',root),patch.dict(os.environ,{'GITHUB_REPOSITORY':'fixture/VPS-LLHH','GITHUB_SHA':'a'*40,'GH_RELEASE_TOKEN':'fixture-token'}),patch.object(publisher.urllib.request,'build_opener',return_value=Opener()):
        if mode=='missing':
            try:publisher.main()
            except RuntimeError as error:assert '更新说明' in str(error)
            else:raise AssertionError('Missing notes allowed')
            assert requests==[]
        elif mode=='failure':
            try:publisher.main()
            except RuntimeError as error:assert 'fixture-token'not in str(error)
            else:raise AssertionError('Failed upload was published')
            assert not published
        else:
            publisher.main();assert published==(mode!='existing')
    if mode=='existing':assert len(requests)==2
    for invalid in ['owner/repo;reboot','owner/repo\nsecret','../repo']:
        try:publisher.installer(invalid,'v0.2.0',"REPOSITORY=''\nVERSION=''\n")
        except ValueError:pass
        else:raise AssertionError('Unsafe repository accepted')
print(json.dumps({'mode':mode,'passed':True}))
