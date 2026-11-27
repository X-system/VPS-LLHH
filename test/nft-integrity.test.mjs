import test from'node:test';
import assert from'node:assert/strict';
import{nftFingerprint}from'../src/nft-integrity.mjs';

test('规则完整性忽略计数与内核句柄变化，检测清空链和修改动作',()=>{
 const original={nftables:[{metainfo:{version:'test'}},{table:{family:'inet',name:'vps_panel_guard',handle:1}},{chain:{family:'inet',table:'vps_panel_guard',name:'output',hook:'output',prio:-5,handle:2}},{rule:{family:'inet',table:'vps_panel_guard',chain:'output',handle:3,expr:[{counter:{packets:0,bytes:0}},{reject:{type:'icmpx',expr:'port-unreachable'}}]}}]};
 const changed=structuredClone(original);changed.nftables[0].metainfo.version='other';changed.nftables[3].rule.handle=100;changed.nftables[3].rule.expr[0].counter={packets:100,bytes:10000};
 assert.equal(nftFingerprint(original),nftFingerprint(changed));
 changed.nftables[3].rule.expr[1]={accept:null};assert.notEqual(nftFingerprint(original),nftFingerprint(changed));
 assert.notEqual(nftFingerprint(original),nftFingerprint({nftables:original.nftables.slice(0,3)}));
 assert.throws(()=>nftFingerprint({nftables:null}));
});
