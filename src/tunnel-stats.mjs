import{publicKey}from'./core-config.mjs';

export function ingestTunnel(store,network){
 if(!network?.up||!network.epoch)return;
 const totals=store.get('tunnel-totals')||{},now=store.clock();
 for(const peer of network.peers){
  publicKey(peer.publicKey);if(![peer.up,peer.down].every(value=>Number.isSafeInteger(value)&&value>=0))throw new Error('隧道计数无效');
  const prior=totals[peer.publicKey],same=prior?.epoch===network.epoch&&peer.up>=prior.rawUp&&peer.down>=prior.rawDown;
  const up=peer.up-(same?prior.rawUp:0),down=peer.down-(same?prior.rawDown:0),elapsed=same?now-prior.at:0;
  const totalUp=(prior?.up||0)+up,totalDown=(prior?.down||0)+down;
  if(![totalUp,totalDown].every(Number.isSafeInteger))throw new Error('隧道累计超过精确计数范围');
  totals[peer.publicKey]={up:totalUp,down:totalDown,rawUp:peer.up,rawDown:peer.down,epoch:network.epoch,at:now,handshakeAt:peer.handshakeAt,speedUp:elapsed>0&&elapsed<=60000?up*1000/elapsed:null,speedDown:elapsed>0&&elapsed<=60000?down*1000/elapsed:null};
 }
 store.set('tunnel-totals',totals);
}
export function peerView(store){
 const encoded=store.get('network-config');if(!encoded)return{configured:false,peers:[]};
 const config=JSON.parse(store.unseal(encoded)),status=store.get('network-status'),totals=store.get('tunnel-totals')||{},now=store.clock();
 const fresh=status&&now-status.at<=20000&&now>=status.at;
 return{configured:true,up:fresh?status.up:null,peers:config.peers.map(peer=>{
  const sample=totals[peer.publicKey],known=fresh&&status.up&&sample&&now-sample.at<=20000&&now>=sample.at;
  return{publicKey:peer.publicKey,name:peer.name||peer.address,address:peer.address,up:sample?.up||0,down:sample?.down||0,handshakeAt:known?sample.handshakeAt:null,recentHandshake:known?!!sample.handshakeAt&&now-sample.handshakeAt<=180000:null,speedUp:known?sample.speedUp:null,speedDown:known?sample.speedDown:null};
 })};
}
