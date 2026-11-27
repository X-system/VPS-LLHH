import{streams}from'./access.mjs';

const base='/usr/local/lib/vps-panel',node=base+'/runtime/bin/node',app=base+'/app';
export function serviceUnits(){
 const units={};
 units['vps-panel-agent.service']=`[Unit]
Description=VPS Panel Local System Agent
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=5
[Service]
Type=simple
User=root
Group=vps-panel
RuntimeDirectory=vps-panel
RuntimeDirectoryMode=0750
UMask=0077
ExecStart=${node} ${app}/src/agent.mjs
ExecStopPost=${node} ${app}/src/agent-stop.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/etc/vps-panel /etc/systemd/system /run -/etc/ufw -/lib/ufw -/var/lib/ufw
[Install]
WantedBy=multi-user.target
`;
 units['vps-panel-web.service']=`[Unit]
Description=VPS Panel Chinese Web Management
After=network.target vps-panel-agent.service
Wants=vps-panel-agent.service
StartLimitIntervalSec=120
StartLimitBurst=5
[Service]
Type=simple
User=vps-panel
Group=vps-panel
WorkingDirectory=${app}
EnvironmentFile=/etc/vps-panel/web.env
ExecStart=${node} ${app}/src/server.mjs
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/vps-panel
LoadCredential=fullchain.pem:/etc/vps-panel/certs/panel-fullchain.pem
LoadCredential=privkey.pem:/etc/vps-panel/certs/panel-privkey.pem
[Install]
WantedBy=multi-user.target
`;
 units['vps-panel-auth.service']=`[Unit]
Description=VPS Panel Independent Hysteria Authentication
After=network.target vps-panel-web.service
StartLimitIntervalSec=120
StartLimitBurst=5
[Service]
Type=simple
User=vps-panel
Group=vps-panel
Environment=VPS_DATA_DIR=/var/lib/vps-panel
Environment=VPS_AUTH_PORT=18444
ExecStart=${node} ${app}/src/auth-service.mjs
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
ProtectSystem=strict
ReadOnlyPaths=/var/lib/vps-panel
[Install]
WantedBy=multi-user.target
`;
 units['vps-panel-worker.service']=`[Unit]
Description=VPS Panel Independent Usage and Access Worker
After=network.target vps-panel-agent.service vps-panel-web.service
Wants=vps-panel-agent.service
StartLimitIntervalSec=120
StartLimitBurst=5
[Service]
Type=notify
NotifyAccess=all
WatchdogSec=120
WatchdogSignal=SIGKILL
TimeoutStartSec=60
LimitCORE=0
User=vps-panel
Group=vps-panel
WorkingDirectory=${app}
Environment=VPS_DATA_DIR=/var/lib/vps-panel
ExecStart=${node} ${app}/src/runtime-worker.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/vps-panel
[Install]
WantedBy=multi-user.target
`;
 units['vps-panel-network.service']=`[Unit]
Description=VPS Panel WireGuard and Fail-Closed Routing
After=network-online.target
Wants=network-online.target
Before=vps-panel-vmess-att.service vps-panel-hy2-att.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${node} ${app}/src/network-cli.mjs
UMask=0077
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/etc/vps-panel /run -/etc/ufw -/lib/ufw -/var/lib/ufw
[Install]
WantedBy=multi-user.target
`;
 units['vps-panel-guard.service']=`[Unit]
Description=VPS Panel Kernel and Local API Protection
After=network.target
Before=vps-panel-vmess-att.service vps-panel-vmess-direct.service vps-panel-hy2-att.service vps-panel-hy2-direct.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${node} ${app}/src/guard-cli.mjs
UMask=0077
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/etc/vps-panel
`;
 for(const stream of streams){
  const[protocol,exit]=stream.split('.'),name='vps-panel-'+protocol+'-'+exit;
  units[name+'.service']=`[Unit]
Description=VPS Panel ${protocol} ${exit}
After=network-online.target vps-panel-worker.service vps-panel-guard.service${exit==='att'?' vps-panel-network.service':''}${protocol==='hy2'?' vps-panel-auth.service':''}
BindsTo=vps-panel-worker.service
Requires=vps-panel-guard.service
${exit==='att'?'Requires=vps-panel-network.service\n':''}${protocol==='hy2'?'Requires=vps-panel-auth.service\n':''}StartLimitIntervalSec=120
StartLimitBurst=5
[Service]
Type=simple
User=${name}
Group=${name}
RuntimeDirectory=vps-panel-core-${protocol}-${exit}
RuntimeDirectoryMode=0700
ExecStart=${base}/${protocol==='hy2'?'hysteria server --disable-update-check -c':'xray run -config'} /run/vps-panel-core-${protocol}-${exit}/config.json
ExecStartPre=+${node} ${app}/src/core-prestart.mjs ${stream}
${protocol==='hy2'?'LoadCredential=fullchain.pem:/etc/vps-panel/certs/fullchain.pem\nLoadCredential=privkey.pem:/etc/vps-panel/certs/privkey.pem\n':''}Restart=no
RestartSec=5
TimeoutStopSec=10
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_RAW
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_RAW
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
[Install]
WantedBy=multi-user.target
`;
 }
 return units;
}
