"""Publish an immutable public release from GitHub Actions, never local data."""
import hashlib,json,os,pathlib,re,sys,urllib.request,urllib.error,urllib.parse

ROOT=pathlib.Path(__file__).resolve().parents[1]

def installer(repository,version,source):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}',repository):raise ValueError('Invalid repository')
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+',version):raise ValueError('Invalid version')
    assert source.count("REPOSITORY=''\n")==1 and source.count("VERSION=''\n")==1
    return source.replace("REPOSITORY=''\n",'REPOSITORY='+repr(repository)+'\n').replace("VERSION=''\n",'VERSION='+repr(version)+'\n')

def main():
    repository=os.environ.get('GITHUB_REPOSITORY','');revision=os.environ.get('GITHUB_SHA','')
    version='v'+json.loads((ROOT/'package.json').read_text())['version']
    bootstrap=installer(repository,version,(ROOT/'bootstrap.sh').read_text())
    if not re.fullmatch(r'[a-f0-9]{40}',revision):raise ValueError('Missing exact commit')
    token=os.environ.pop('GH_RELEASE_TOKEN','')
    if not token:raise ValueError('Missing GitHub workflow token')
    headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'VPS-LLHH-release','X-GitHub-Api-Version':'2026-03-10'}
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(NoRedirect())
    def request(url,method='GET',data=None,content='application/json'):
        if not url.startswith(('https://api.github.com/repos/'+repository+'/', 'https://uploads.github.com/repos/'+repository+'/')):raise ValueError('Unexpected GitHub endpoint')
        req=urllib.request.Request(url,method=method,headers={**headers,'Content-Type':content},data=data)
        try:
            with opener.open(req,timeout=90)as response:return response.status,json.load(response)
        except urllib.error.HTTPError as error:
            if error.code==404:return 404,None
            raise RuntimeError('GitHub publication failed (HTTP '+str(error.code)+')')from None
    api='https://api.github.com/repos/'+repository
    status,release=request(api+'/releases/tags/'+version)
    if status==404:
        body={'tag_name':version,'target_commitish':revision,'name':'VPS-LLHH '+version,'draft':True,'prerelease':False,'body':'Debian 12 amd64 测试版。安装后按中文网页引导配置；所有代理默认停止。BBRX 为实验性功能，未验证提速收益。'}
        _,release=request(api+'/releases','POST',json.dumps(body).encode())
    if not release['draft']:
        print(version+' already published; existing release remains immutable. Bump package version for another release.');return
    if release.get('target_commitish')!=revision:raise RuntimeError('Draft belongs to another commit; inspect it before resuming')
    output=ROOT/'dist';files={}
    for name in ['vps-panel-'+version+'.tar.gz','vps-panel-'+version+'.tar.gz.sha256']:
        files[name]=(output/name).read_bytes()
    files['bootstrap.sh']=bootstrap.encode()
    files['bootstrap.sh.sha256']=(hashlib.sha256(files['bootstrap.sh']).hexdigest()+'  bootstrap.sh\n').encode()
    existing={item['name']:item for item in release.get('assets',[])}
    for name,data in files.items():
        digest='sha256:'+hashlib.sha256(data).hexdigest()
        if name in existing:
            if existing[name].get('digest')!=digest:raise RuntimeError('Draft asset differs; refusing to overwrite '+name)
            continue
        url='https://uploads.github.com/repos/'+repository+'/releases/'+str(release['id'])+'/assets?'+urllib.parse.urlencode({'name':name})
        _,asset=request(url,'POST',data,'application/octet-stream')
        if asset.get('digest')!=digest or asset.get('size')!=len(data):raise RuntimeError('Uploaded asset digest mismatch')
    request(api+'/releases/'+str(release['id']),'PATCH',json.dumps({'draft':False,'make_latest':'true'}).encode())
    print('Published '+version+' with package, installer and SHA256 files.')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
