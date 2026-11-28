"""Exercise interactive menus in a real PTY, without installing software."""
import pathlib,sys,os,pty,select,time,tempfile,json
root=pathlib.Path(sys.argv[1]if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parents[1])
source=(root/'bootstrap.sh').read_text()
with tempfile.TemporaryDirectory(prefix='llhh-menu-')as temporary:
    path=pathlib.Path(temporary);(path/'versions.json').write_text('[{"tag":"v0.3.3-test1"}]')
    code='set -Eeuo pipefail\nINSTALL_ROLE=""\nVERSION=""\nEXISTING_ACTION=""\nRESTORE=0\nllhh_stop(){ echo "$1";exit 1; }\nllhh_step(){ :; }\n'
    code+=source[source.index('INTERACTIVE=0'):source.index('STAGE=$(mktemp')]
    code+='STAGE='+str(path)+'\nprintf "  1) 0.3.3-test1（测试版）\\n"\n'
    code+=source[source.index('if [[ -z $VERSION ]];then'):source.index('EXPECTED=$(python3')]
    code+=source[source.index("heading '第3步"):source.index('ASSET="vps-panel-')]
    code+='echo FIXTURE_CONFIRMED\n'
    code=code.replace('/usr/local/lib/vps-panel/app',str(path/'absent-app'))
    script=path/'menu.sh';script.write_text(code)
    for payload,success,cancelled in [(b'9\n2\n9\n1\n1\n',True,False),(b'1\n1\n0\n',False,True),(b'\x04',False,False)]:
        pid,fd=pty.fork()
        if pid==0:os.execv('/bin/bash',['bash',str(script)])
        os.write(fd,payload);chunks=[];deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            ready,_,_=select.select([fd],[],[],.2)
            if ready:
                try:data=os.read(fd,65536)
                except OSError:break
                if not data:break
                chunks.append(data)
        else:os.kill(pid,9);raise AssertionError('menu stalled')
        os.close(fd);_,status=os.waitpid(pid,0);text=b''.join(chunks).decode('utf-8','replace')
        assert '请输入 [1-2]'in text,text
        if success:
            assert '输入无效'in text and '请输入版本序号'in text and '请输入 [1/0]'in text and 'FIXTURE_CONFIRMED'in text and status==0,text
        elif cancelled:assert '已取消'in text and 'FIXTURE_CONFIRMED'not in text and status==0,text
        else:assert '输入已中断'in text and status!=0,text
    # The same real PTY exercises all installed-panel choices without using any
    # actual system panel files, account commands, network or uninstall code.
    app=path/'existing-app';app.mkdir();state=path/'system.json';state.write_text('{"role":"exit"}')
    existing=code.replace(str(path/'absent-app'),str(app)).replace('/etc/vps-panel/system.json',str(state))
    existing=existing.replace('set -Eeuo pipefail','set -Eeuo pipefail\nllhh(){ echo FIXTURE_ADDRESS; }')
    script.write_text(existing)
    for payload,expected in [(b'1\n','FIXTURE_ADDRESS'),(b'2\n1\n1\n','FIXTURE_CONFIRMED'),(b'3\n1\n1\nDELETE\n1\n','FIXTURE_CONFIRMED'),(b'3\n1\n1\nNO\n','已取消')]:
        pid,fd=pty.fork()
        if pid==0:os.execv('/bin/bash',['bash',str(script)])
        os.write(fd,payload);chunks=[];deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            ready,_,_=select.select([fd],[],[],.2)
            if ready:
                try:data=os.read(fd,65536)
                except OSError:break
                if not data:break
                chunks.append(data)
        else:os.kill(pid,9);raise AssertionError('existing menu stalled')
        os.close(fd);_,status=os.waitpid(pid,0);text=b''.join(chunks).decode('utf-8','replace')
        assert expected in text and status==0,text
        if payload.startswith(b'1'):assert 'FIXTURE_CONFIRMED'not in text,text
print(json.dumps({'roleAndVersionPrompts':True,'invalidInputRetried':True,'confirmationAndCancellation':True,'eofHandled':True}))
