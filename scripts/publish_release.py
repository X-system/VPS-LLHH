"""Publish immutable program releases and a separately maintained installer entry."""
import hashlib,json,os,pathlib,re,sys,urllib.request,urllib.error,urllib.parse,subprocess,tempfile,tarfile,io
ROOT=pathlib.Path(__file__).resolve().parents[1]
VERSION_PATTERN=r'v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-test[1-9]\d*)?'
MARKER='<!-- llhh:installer -->'

def release_notes(root,version,required=True):
    path=root/'docs/releases'/(version.removeprefix('v')+'.md')
    text=path.read_text(encoding='utf-8').strip()if path.exists()else''
    if required and(len(text)<80 or not re.search(r'新增|修复|改进|优化|调整|更新',text)):
        raise RuntimeError('请先编写本版本更新说明：docs/releases/'+version.removeprefix('v')+'.md')
    return text
def installer(repository,version,source):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}',repository):raise ValueError('Invalid repository')
    if not re.fullmatch(VERSION_PATTERN,version):raise ValueError('Invalid version')
    assert source.count("REPOSITORY=''\n")==1 and source.count("VERSION=''\n")==1
    # No pinned VERSION: the same public command presents all actual releases.
    return source.replace("REPOSITORY=''\n",'REPOSITORY='+repr(repository)+'\n')
def main():
    repository=os.environ.get('GITHUB_REPOSITORY','');revision=os.environ.get('GITHUB_SHA','')
    version='v'+json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
    release_notes(ROOT,version)
    bootstrap_source=(ROOT/'bootstrap.sh').read_text(encoding='utf-8')
    if '# LLHH_EMBED_ENVIRONMENT' in bootstrap_source:
        bootstrap_source=bootstrap_source.replace('# LLHH_EMBED_ENVIRONMENT',(ROOT/'config/install-environment.sh').read_text(encoding='utf-8'))
    bootstrap=installer(repository,version,bootstrap_source).encode()
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
            with opener.open(req,timeout=90)as response:
                return response.status,json.load(response)if response.status!=204 else None
        except urllib.error.HTTPError as error:
            if error.code==404:return 404,None
            raise RuntimeError('GitHub publication failed (HTTP '+str(error.code)+')')from None
    api='https://api.github.com/repos/'+repository
    def upload(release,files,rolling=False):
        existing={item['name']:item for item in release.get('assets',[])}
        for name,data in files.items():
            digest='sha256:'+hashlib.sha256(data).hexdigest()
            if name in existing:
                if existing[name].get('digest')==digest:continue
                if not rolling or name not in ('bootstrap.sh','bootstrap.sh.sha256'):raise RuntimeError('Immutable asset differs: '+name)
                request(api+'/releases/assets/'+str(existing[name]['id']),'DELETE')
            url='https://uploads.github.com/repos/'+repository+'/releases/'+str(release['id'])+'/assets?'+urllib.parse.urlencode({'name':name})
            _,asset=request(url,'POST',data,'application/octet-stream')
            if asset.get('digest')!=digest or asset.get('size')!=len(data):raise RuntimeError('Uploaded asset digest mismatch')
    installer_files={'bootstrap.sh':bootstrap,'bootstrap.sh.sha256':(hashlib.sha256(bootstrap).hexdigest()+'  bootstrap.sh\n').encode()}
    def publish(root,version,commit,role):
        tag=role+'-'+version
        status,release=request(api+'/releases/tags/'+tag)
        test='-test'in tag
        if status==404:
            notes=root/'docs/releases'/(version[1:]+'.md')
            release_notes(root,version,required=root==ROOT)
            body={'tag_name':tag,'target_commitish':commit,'name':'【'+('中转端'if role=='relay'else '出口端')+'】'+version[1:]+('（测试版）'if test else ''),'draft':True,'prerelease':test,'body':('测试版，尚非正式发布。'if test else '正式版本。')+' Debian 12 amd64。固定标签和程序包不覆盖。安装后按中文网页配置；代理默认停止。BBRX（如提供）为实验性功能，未验证提速收益。'}
            if notes.exists():body['body']=notes.read_text(encoding='utf-8')
            policy_file=root/'config/update-policy.json'
            if policy_file.exists():
                policy=json.loads(policy_file.read_text(encoding='utf-8'))
                if policy.get('required')is True and role in policy.get('roles',['relay','exit']):body['body']+='\n\n<!-- llhh:update-policy {"required":true} -->'
            _,release=request(api+'/releases','POST',json.dumps(body).encode())
        if not release['draft']:
            if root==ROOT and os.environ.get('LLHH_REFRESH_BOOTSTRAP')=='1':
                upload(release,installer_files,rolling=True)
                notes=release_notes(root,version)
                # Keep an existing required-update marker when refreshing public notes.
                markers=re.findall(r'<!-- llhh:update-policy [^\n]*? -->',release.get('body',''))
                if markers:notes+='\n\n'+'\n'.join(markers)
                if notes!=release.get('body'):request(api+'/releases/'+str(release['id']),'PATCH',json.dumps({'body':notes}).encode())
            print(tag+' already published; immutable program release retained.');return
        if release.get('target_commitish')!=commit:raise RuntimeError('Draft belongs to another commit; inspect before resuming')
        files={name:(root/'dist'/name).read_bytes()for name in ['vps-panel-'+version+'.tar.gz','vps-panel-'+version+'.tar.gz.sha256']}
        upload(release,{**files,**installer_files})
        request(api+'/releases/'+str(release['id']),'PATCH',json.dumps({'draft':False,'prerelease':test,'make_latest':'false'if test else 'true'}).encode())
        print('Published '+tag)
    for role in ['relay','exit']:publish(ROOT,version,revision,role)
    historical=ROOT/'config/historical-releases.json'
    if historical.exists():
        for item in json.loads(historical.read_text(encoding='utf-8')):
            tag=item['tag'];commit=item['commit']
            if not re.fullmatch(VERSION_PATTERN,tag)or not re.fullmatch('[a-f0-9]{40}',commit):raise ValueError('Invalid historical release')
            ready=True
            for role in ['relay','exit']:
                status,release=request(api+'/releases/tags/'+role+'-'+tag)
                ready=ready and status==200 and not release['draft']
            if ready:continue
            subprocess.run(['git','fetch','--depth=1','https://github.com/'+repository+'.git',commit],check=True,cwd=ROOT)
            archive=subprocess.check_output(['git','archive',commit],cwd=ROOT)
            with tempfile.TemporaryDirectory(prefix='llhh-history-')as temporary:
                root=pathlib.Path(temporary)
                with tarfile.open(fileobj=io.BytesIO(archive))as tar:tar.extractall(root,filter='data')
                if 'v'+json.loads((root/'package.json').read_text(encoding='utf-8'))['version']!=tag:raise ValueError('Historical version mismatch')
                subprocess.run([sys.executable,str(root/'scripts/build_release.py')],check=True)
                for role in ['relay','exit']:publish(root,tag,commit,role)
    # Preserve the previously distributed /latest/download command. Only the
    # installer assets roll; the original v0.2.0 tag and program package do not.
    if os.environ.get('LLHH_ROLLING_INSTALLER')=='1':
        status,release=request(api+'/releases/tags/v0.2.0')
        if status!=200 or release['draft']:raise RuntimeError('Legacy installer release missing')
        upload(release,installer_files,rolling=True)
        request(api+'/releases/'+str(release['id']),'PATCH',json.dumps({'name':'安装入口（兼容原 v0.2.0 下载地址）','body':MARKER+'\n此记录保留旧安装命令与原程序包，安装脚本提供实际版本选择。程序新版本使用独立 Tag / Release；v0.2.0 原标签、程序包保持不变。中转、出口按面板和版本独立发布。最新可用版本以安装菜单和各面板入口的版本表为准。'}).encode())
        print('Rolling installer entry refreshed; original program package retained.')
if __name__=='__main__':
    try:main()
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
