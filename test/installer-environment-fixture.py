"""Run shell entry/preflight with fake packages and downloads; never install anything."""
import pathlib,tempfile,subprocess,os,sys,json
root=pathlib.Path(sys.argv[1]if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parents[1])
passed=[]
with tempfile.TemporaryDirectory(prefix='llhh-entry-fixture-')as temporary:
    base=pathlib.Path(temporary)
    for source,cases in [('config/install-environment.sh',['missing','ready','apt-failed','unsupported','space']),('config/install-entry.sh',['missing','ready','apt-failed','unsupported','download-failed'])]:
        for case in cases:
            path=base/(source.split('/')[-1]+case);path.mkdir();binary=path/'bin';binary.mkdir();(path/'systemd').mkdir()
            (path/'os-release').write_text('ID='+('ubuntu'if case=='unsupported'else'debian')+'\nVERSION_ID=12\nVERSION="12 (bookworm)"\n')
            if case=='ready':(path/'ready').touch();(path/'ca').write_text('fixture')
            scripts={
                'apt-get':'''#!/bin/bash
echo "apt $*" >>"$FIXTURE/calls"
[[ $CASE != apt-failed ]] || { echo 'fixture package error' >&2;exit 100; }
if [[ " $* " == *" install "* ]];then touch "$FIXTURE/ready";echo fixture >"$FIXTURE/ca";fi
''',
                'dpkg-query':'#!/bin/bash\n[[ -e $FIXTURE/ready ]] && printf "install ok installed\\n"\n',
                'df':'#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 9999999 0 %s 0 /\\n" "${SPACE:-9999999}"\n',
                'curl':'''#!/bin/bash
echo curl >>"$FIXTURE/calls"
while (($#));do if [[ $1 == -o ]];then target=$2;break;fi;shift;done
printf '#!/bin/bash\necho child-ran >>"$FIXTURE/calls"\n' >"$target"
[[ $CASE != download-failed ]] || exit 22
'''}
            for name,body in scripts.items():file=binary/name;file.write_text(body);file.chmod(0o755)
            code=(root/source).read_text().replace('/etc/os-release',str(path/'os-release')).replace('/run/systemd/system',str(path/'systemd')).replace('/etc/ssl/certs/ca-certificates.crt',str(path/'ca')).replace('/var/tmp/llhh-entry.',str(path/'download.')).replace('[[ $EUID == 0 ]]','[[ 0 == 0 ]]')
            prefix='command(){ if [[ $1 == -v && $2 == curl && ! -e $FIXTURE/ready ]];then return 1;fi;builtin command "$@"; };\n'
            code=code.replace('set -Eeuo pipefail','set -Eeuo pipefail\n'+prefix)if 'set -Eeuo pipefail'in code else 'set -Eeuo pipefail\n'+prefix+code+'\nVERSION=target-version\nllhh_environment ca-certificates curl python3\n[[ $VERSION == target-version ]] || exit 99\n'
            script=path/'test.sh';script.write_text(code)
            env={**os.environ,'FIXTURE':str(path),'CASE':case,'PATH':str(binary)+':'+os.environ['PATH'],'SPACE':'100'if case=='space'else'9999999'}
            result=subprocess.run(['bash',str(script)],text=True,capture_output=True,env=env,timeout=15)
            calls=(path/'calls').read_text()if(path/'calls').exists()else''
            if 'apt 'in calls:assert all('DPkg::Lock::Timeout=600'in line for line in calls.splitlines()if line.startswith('apt ')),calls
            if case in ['ready','missing']:
                assert result.returncode==0,(source,case,result.stderr,result.stdout)
                assert ('apt 'in calls)==(case=='missing')
                if source.endswith('install-entry.sh'):assert 'child-ran'in calls
            else:
                assert result.returncode!=0,(source,case)
                assert 'child-ran'not in calls
                assert any(word in result.stdout+result.stderr for word in ['无法继续','安装未完成','目前只开放','当前只支持','空间不足'])
                if case in ['unsupported','space']:assert not calls
            passed.append(source+':'+case)
print(json.dumps({'passed':passed}))
