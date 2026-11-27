import net from'node:net';
import dgram from'node:dgram';

export async function probeBindings(bindings){
 for(const binding of bindings){
  const socket=binding.protocol==='udp'?dgram.createSocket({type:'udp4',reuseAddr:false}):net.createServer();
  try{await new Promise((resolve,reject)=>{socket.once('error',reject);if(binding.protocol==='udp')socket.bind({port:binding.port,address:binding.host||'0.0.0.0',exclusive:true},resolve);else socket.listen({port:binding.port,host:binding.host||'0.0.0.0',exclusive:true},resolve);});}
  catch{throw new Error(`端口${binding.port}/${binding.protocol}被占用或无法绑定`);}
  finally{await new Promise(resolve=>{try{socket.close(()=>resolve());}catch{resolve();}});}
 }
}
