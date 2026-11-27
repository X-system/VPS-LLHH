"""Resolve the management listener without changing the host's network."""
import os,sys,json,pathlib,ipaddress,re,socket,subprocess,urllib.request,urllib.parse

def public_ip():
 routes=json.loads(subprocess.check_output(['ip','-j','-4','route','show','default'],text=True))
 preferred=routes[0].get('dev')if routes else None
 links=json.loads(subprocess.check_output(['ip','-j','-4','address','show','scope','global'],text=True))
 links.sort(key=lambda link:link['ifname']!=preferred)
 for link in links:
  for address in link.get('addr_info',[]):
   value=ipaddress.ip_address(address['local'])
   if value.version==4 and value.is_global:return str(value)
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open('https://api.ipify.org',timeout=8)as response:value=ipaddress.ip_address(response.read(64).decode().strip())
 if value.version!=4 or not value.is_global:raise ValueError('无法确定公网IPv4')
 return str(value)

def resolve_settings(environment,prior,detect=public_ip):
 bind=environment.get('VPS_INSTALL_BIND',prior.get('VPS_HOST','0.0.0.0'))
 if bind not in('0.0.0.0','127.0.0.1'):raise ValueError('面板绑定地址只支持0.0.0.0或127.0.0.1')
 port=int(environment.get('VPS_INSTALL_PORT',prior.get('VPS_PORT','18443')))
 if not 1<=port<=65535:raise ValueError('面板端口应在1至65535之间')
 old=urllib.parse.urlparse(prior.get('VPS_ORIGIN',''))
 host=environment.get('VPS_INSTALL_IP')or old.hostname
 if not host or not environment.get('VPS_INSTALL_IP')and host=='127.0.0.1'and bind!='127.0.0.1':host='127.0.0.1'if bind=='127.0.0.1'else detect()
 try:
  address=ipaddress.ip_address(host)
  if address.version!=4:raise ValueError('此版本管理入口暂不支持IPv6')
  san='IP:'+host
 except ValueError:
  if not re.fullmatch(r'(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}',host):raise ValueError('面板地址必须是IPv4或有效域名')
  san='DNS:'+host
 return bind,host,port,san

if __name__=='__main__':
 try:
  prior={};path=pathlib.Path('/etc/vps-panel/web.env')
  if sys.argv[1]=='1'and path.exists():prior=dict(line.split('=',1)for line in path.read_text().splitlines()if'='in line)
  values=resolve_settings(os.environ,prior)
  with socket.socket()as server:server.bind((values[0],values[2]))
  for value in values:print(value)
 except Exception as error:print('面板地址或端口检查失败：'+str(error),file=sys.stderr);sys.exit(1)
